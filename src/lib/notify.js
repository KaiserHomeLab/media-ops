// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notifications: decide what's worth telling you about after each background poll, and send
// it to Discord, Telegram, ntfy, Pushover, Gotify, email or a JSON webhook (set up under Settings).
//
// Noise control:
//   - an app must fail two polls in a row before "down" fires; "back up" only follows a "down"
//   - errors already present when the server starts are never sent (no flood on restart)
//   - log lines are only sent if they're recent; dismissed entries are never sent
//   - one batched message per destination per poll, at most 10 lines
'use strict';
const crypto = require('node:crypto');
const { originOf } = require('./config');
const { req } = require('./http');
const smtp = require('./smtp');

// ------------------------------------------------------------------ destination types (Settings form)
const secret = (key, label, help, optional) => ({ key, label, type: 'secret', help, optional });
const text = (key, label, help, placeholder, optional) => ({ key, label, type: 'text', help, placeholder, optional });

const TYPES = [
  {
    type: 'discord',
    label: 'Discord',
    fields: [
      secret(
        'webhookUrl',
        'Webhook URL',
        'Discord channel → Edit channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
      ),
    ],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    fields: [
      secret(
        'botToken',
        'Bot token',
        'Message @BotFather in Telegram, send /newbot, and copy the token it gives you (like 123456:ABC-DEF…).',
      ),
      text(
        'chatId',
        'Chat ID',
        'Send your bot a message, then open api.telegram.org/bot<token>/getUpdates and copy "chat":{"id":…}. Group IDs start with -. A public channel can use @name.',
        '123456789',
      ),
    ],
  },
  {
    type: 'ntfy',
    label: 'ntfy',
    fields: [
      text('server', 'Server', 'Use https://ntfy.sh or your own ntfy server.', 'https://ntfy.sh'),
      text(
        'topic',
        'Topic',
        'Subscribe to the same topic in the ntfy app. Pick something hard to guess on ntfy.sh.',
        'media-ops-8f3k2',
      ),
      secret('token', 'Access token', 'Only if your topic requires login.', true),
    ],
  },
  {
    type: 'pushover',
    label: 'Pushover',
    fields: [
      secret('userKey', 'User key', 'Shown on your Pushover dashboard after you log in.'),
      secret('appToken', 'API token', 'Create an application at pushover.net/apps/build and copy its API token.'),
    ],
  },
  {
    type: 'gotify',
    label: 'Gotify',
    fields: [
      text('url', 'Server', 'Your Gotify server address.', 'http://192.168.1.10:8070'),
      secret('appToken', 'App token', 'Gotify → Apps → Create application → copy its token.'),
    ],
  },
  {
    type: 'email',
    label: 'Email',
    fields: [
      text(
        'smtpHost',
        'Mail server (SMTP)',
        'For example smtp.gmail.com, smtp.fastmail.com, or your own.',
        'smtp.example.com',
      ),
      text(
        'smtpPort',
        'Port',
        '587 (STARTTLS) is the usual one; 465 for an encrypted connection from the start. The connection is always encrypted when a password is set.',
        '587',
        true,
      ),
      text(
        'username',
        'Username',
        'Usually your email address. Leave blank for a relay that needs no login.',
        '',
        true,
      ),
      secret(
        'password',
        'Password',
        'Gmail, iCloud, Outlook and Fastmail need an app password, not your normal one.',
        true,
      ),
      text(
        'from',
        'From',
        'The address the email comes from. Most servers need it to be your own.',
        'media-ops@example.com',
      ),
      text('to', 'To', 'Where to send it. Separate several addresses with commas.', 'you@example.com'),
    ],
    // A saved password is only reused for the same mail server.
    where: t => `smtp://${String(t?.smtpHost || '').toLowerCase()}:${Number(t?.smtpPort) || 587}`,
  },
  {
    type: 'webhook',
    label: 'Webhook (JSON)',
    fields: [
      secret(
        'url',
        'URL',
        'Receives a POST with { title, message, events[] } as JSON. Works with Home Assistant, n8n, Apprise API, etc.',
      ),
    ],
  },
];
const BY_TYPE = Object.fromEntries(TYPES.map(t => [t.type, t]));

const EVENTS = [
  { key: 'down', label: 'App goes down', def: true },
  { key: 'recovered', label: 'App is back up', def: true },
  { key: 'errors', label: 'New errors', def: true },
  { key: 'warnings', label: 'New warnings & health checks', def: false },
  { key: 'downloads', label: 'Failed or stuck downloads', def: true },
  { key: 'disk', label: 'Disk over the threshold', def: true },
  { key: 'unraid', label: 'Server problems (Unraid array, TrueNAS pools, alerts, hot disks)', def: true }, // key kept for saved settings
  { key: 'bandwidth', label: 'Upload nearly maxed out', def: true },
  { key: 'streams', label: 'Someone starts watching', def: false },
  { key: 'digest', label: 'Daily digest', def: true },
];

const secretKeys = type => (BY_TYPE[type]?.fields || []).filter(f => f.type === 'secret').map(f => f.key);

function publicTarget(t) {
  const out = { ...t };
  for (const k of secretKeys(t.type)) {
    out[`${k}Saved`] = !!t[k];
    delete out[k];
  }
  return out;
}

// Form submission -> stored destination. Blank secret = keep the saved one.
function mergeTarget(existing, input) {
  const type = existing?.type || input.type;
  const def = BY_TYPE[type];
  if (!def) throw new Error(`Unknown notification type "${type}"`);
  const out = {
    id: existing?.id || crypto.randomUUID(),
    type,
    name: String(input.name || '').trim() || def.label,
    enabled: input.enabled !== false,
    events: Object.fromEntries(EVENTS.map(e => [e.key, input.events?.[e.key] ?? existing?.events?.[e.key] ?? e.def])),
  };
  // Where this destination sends to; a saved token is only reused for the same server.
  const where =
    def.where ||
    (t =>
      def.fields
        .filter(f => /url|server/i.test(f.key) && f.type !== 'secret')
        .map(f => originOf(t?.[f.key] || (f.key === 'server' ? 'https://ntfy.sh' : '')))
        .join(' '));
  for (const f of def.fields)
    if (f.type !== 'secret')
      out[f.key] = String(input[f.key] ?? '').trim() || (f.key === 'server' ? 'https://ntfy.sh' : '');
  const moved = existing && where(existing) !== where(out);
  for (const f of def.fields) {
    const v = String(input[f.key] ?? '').trim();
    if (f.type === 'secret') {
      if (!v && existing?.[f.key] && moved)
        throw new Error(
          `Re-enter the ${f.label}: the address changed, and a saved ${f.label} is only sent to the address it was saved for.`,
        );
      out[f.key] = v || existing?.[f.key] || '';
    }
    if (!f.optional && !out[f.key]) throw new Error(`${f.label} is required`);
    if (/url|server/i.test(f.key) && out[f.key] && !/^https?:\/\//i.test(out[f.key]))
      throw new Error(`${f.label} must start with http:// or https://`);
  }
  if (type === 'telegram' && !/^(-?\d{1,20}|@\w{4,64})$/.test(out.chatId))
    throw new Error('Chat ID must be a number (like 123456789 or -100123…) or a channel @name');
  if (type === 'email') {
    if (!/^[a-z0-9.-]{1,253}$/i.test(out.smtpHost))
      throw new Error('Mail server must be a host name like smtp.example.com');
    const port = Number(out.smtpPort || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a number from 1 to 65535');
    out.smtpPort = String(port);
    if (!smtp.isAddress(out.from)) throw new Error('From must be an email address');
    const to = smtp.addressList(out.to);
    if (!to.length || to.length > 10 || !to.every(smtp.isAddress))
      throw new Error('To must be one or more email addresses, separated by commas');
  }
  return out;
}

// ------------------------------------------------------------------ sending
const LEVEL_COLOR = { error: 0xd03b3b, warn: 0xfab219, good: 0x0ca30c, info: 0x3987e5 };

/**
 * @param {import('./types').Target} target
 * @param {{ title: string, lines: string[], level?: string, events?: { kind: string, level: string, text: string }[] }} message
 */
async function send(target, message) {
  try {
    return await deliver(target, message);
  } catch (e) {
    // Error messages show in Settings and the log, and some secrets live in the address
    // (Telegram's bot token, a Discord webhook's token): blank out every saved secret.
    for (const k of secretKeys(target.type)) {
      const v = String(target[k] || '');
      if (v.length < 4) continue;
      // A secret URL (Discord webhook) shows up in errors as just its path.
      const path = URL.canParse(v) ? new URL(v).pathname : '';
      for (const form of new Set([v, encodeURIComponent(v), path.length > 1 ? path : v]))
        e.message = e.message.split(form).join('•••');
    }
    throw e;
  }
}

/** @param {import('./types').Target} target @param {Parameters<typeof send>[1]} message */
async function deliver(target, { title, lines, level = 'info', events = [] }) {
  const message = lines.join('\n');
  const post = (url, body, headers = {}) => req(url, { method: 'POST', as: 'text', timeout: 10000, body, headers });
  const json = o => JSON.stringify(o);
  switch (target.type) {
    case 'discord':
      return post(
        target.webhookUrl,
        json({
          username: 'Media Ops',
          allowed_mentions: { parse: [] }, // text from an app (a log line) must never ping @everyone
          embeds: [
            {
              title,
              description: message.slice(0, 4000),
              color: LEVEL_COLOR[level],
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        { 'Content-Type': 'application/json' },
      );
    case 'telegram':
      // Plain text (no parse_mode), so text from an app can't inject formatting or links.
      return post(
        `https://api.telegram.org/bot${target.botToken}/sendMessage`,
        json({ chat_id: target.chatId, text: `${title}\n\n${message}`.slice(0, 4096), disable_web_page_preview: true }),
        { 'Content-Type': 'application/json' },
      );
    case 'email':
      return smtp.sendMail({
        host: target.smtpHost,
        port: Number(target.smtpPort) || 587,
        username: target.username,
        password: target.password,
        from: target.from,
        to: target.to,
        subject: title,
        text: message,
      });
    case 'ntfy':
      return post(`${target.server.replace(/\/+$/, '')}/${encodeURIComponent(target.topic)}`, message, {
        Title: title.replace(/[^\x20-\x7e]/g, ''), // HTTP headers must be plain ASCII
        Priority: level === 'error' ? 'high' : 'default',
        Tags:
          level === 'error'
            ? 'rotating_light'
            : level === 'good'
              ? 'white_check_mark'
              : level === 'warn'
                ? 'warning'
                : 'tv',
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
      });
    case 'pushover':
      return post(
        'https://api.pushover.net/1/messages.json',
        new URLSearchParams({
          token: target.appToken,
          user: target.userKey,
          title,
          message: message.slice(0, 1000),
          priority: level === 'error' ? '1' : '0',
        }),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
      );
    case 'gotify':
      return post(
        `${target.url.replace(/\/+$/, '')}/message`,
        json({ title, message, priority: level === 'error' ? 8 : 5 }),
        { 'Content-Type': 'application/json', 'X-Gotify-Key': target.appToken },
      );
    case 'webhook':
      return post(target.url, json({ source: 'media-ops', title, message, level, events }), {
        'Content-Type': 'application/json',
      });
  }
  throw new Error(`Unknown type ${target.type}`);
}

// ------------------------------------------------------------------ deciding what to send
const state = {
  seeded: false,
  startedAt: Date.now(),
  fails: new Map(), // service id -> { n: consecutive failed polls, since: first failure }
  downSince: new Map(), // service id -> when "down" was sent
  seen: new Map(), // event key -> last seen (ms)
  diskOver: new Set(), // disk paths currently over the threshold
  streams: new Set(), // Plex session ids seen
  uploadHigh: false, // remote streams over 85% of upload
  held: /** @type {any[]} */ ([]), // alerts held back during quiet hours
  lastResult: new Map(), // target id -> { at, ok, error }
};

const ago = ms => {
  const m = Math.round(ms / 60e3);
  return m < 1 ? 'less than a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

function detect(raw, events, disks, cfg) {
  const out = [];
  const now = Date.now();
  const threshold = cfg.notifications?.diskThreshold ?? 90;

  for (const s of raw.services) {
    const prev = state.fails.get(s.id);
    const f = s.up ? { n: 0, since: null } : { n: (prev?.n || 0) + 1, since: prev?.since || now };
    state.fails.set(s.id, f);
    if (f.n === 2 && !state.downSince.has(s.id)) {
      state.downSince.set(s.id, f.since);
      out.push({ kind: 'down', level: 'error', line: `🔴 ${s.name} is down: ${s.error}` });
    }
    if (s.up && state.downSince.has(s.id)) {
      out.push({
        kind: 'recovered',
        level: 'good',
        line: `🟢 ${s.name} is back up (down for ${ago(now - state.downSince.get(s.id))})`,
      });
      state.downSince.delete(s.id);
    }
  }

  const SERVER_SOURCES = new Set(['Array', 'Pool', 'TrueNAS', 'Apps']);
  for (const e of events) {
    const fresh = !state.seen.has(e.key);
    state.seen.set(e.key, now);
    if (!fresh || e.dismissed || e.source === 'Connection') continue;
    if (!e.live && (e.t < state.startedAt || now - e.t > 30 * 60e3)) continue; // old log lines
    const download =
      ['Queue', 'Failed download', 'Torrent error'].includes(e.source) || /DownloadClient|Import/i.test(e.source);
    const kind = SERVER_SOURCES.has(e.source)
      ? 'unraid'
      : download
        ? 'downloads'
        : e.level === 'error'
          ? 'errors'
          : 'warnings';
    out.push({ kind, level: e.level, line: `${e.level === 'error' ? '❌' : '⚠️'} ${e.svc}: ${e.message}` });
  }
  for (const [k, t] of state.seen) if (now - t > 7 * 864e5) state.seen.delete(k);

  for (const d of disks) {
    const pct = ((d.total - d.free) / d.total) * 100;
    if (pct >= threshold && !state.diskOver.has(d.path)) {
      state.diskOver.add(d.path);
      out.push({
        kind: 'disk',
        level: 'warn',
        line: `💾 ${d.path} is ${pct.toFixed(0)}% full (${(d.free / 1024 ** 4).toFixed(2)} TB free)`,
      });
    } else if (pct < threshold - 2) state.diskOver.delete(d.path); // a little hysteresis
  }

  const plex = raw.services.find(s => s.kind === 'plex' && s.up);
  const upload = Number(cfg.uploadMbps) || 0;
  if (upload && plex) {
    const wan = (plex.data.streams || []).filter(st => !st.local).reduce((a, st) => a + (st.bandwidth || 0), 0) / 1000;
    if (wan >= upload * 0.85 && !state.uploadHigh) {
      state.uploadHigh = true;
      out.push({
        kind: 'bandwidth',
        level: 'warn',
        line: `📶 Remote streams are using ${wan.toFixed(0)} of your ${upload} Mbps upload (${Math.round((wan / upload) * 100)}%)`,
      });
    } else if (wan < upload * 0.75) state.uploadHigh = false;
  }
  const live = new Set();
  for (const st of plex?.data.streams || []) {
    const id = st.sessionId || st.id;
    live.add(id);
    if (!state.streams.has(id))
      out.push({
        kind: 'streams',
        level: 'info',
        line: `▶️ ${st.user} started ${st.title}${st.type === 'episode' ? ` ${st.subtitle.split(' · ')[0]}` : ''} on ${st.player || st.product}${st.geo?.city ? ` (${st.geo.city})` : st.local ? ' (home)' : ''}`,
      });
  }
  state.streams = live;
  return out;
}

// "HH:MM" in server-local time (set TZ on the container). Handles ranges across midnight.
const minutes = hhmm => {
  const [h, m] = String(hhmm || '')
    .split(':')
    .map(Number);
  return h * 60 + (m || 0);
};
function inQuietHours(q, now = new Date()) {
  if (!q?.enabled) return false;
  const t = now.getHours() * 60 + now.getMinutes(),
    from = minutes(q.from),
    to = minutes(q.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

async function handle(raw, events, disks, cfg) {
  let found = detect(raw, events, disks, cfg);
  if (!state.seeded) {
    state.seeded = true;
    return;
  } // first poll only learns what's already there

  // Quiet hours: hold alerts (optionally still sending app-down), then send what was held as
  // one "while you were asleep" message when they end. "Started watching" isn't worth holding.
  const quiet = cfg.notifications?.quiet;
  if (inQuietHours(quiet)) {
    const urgent = f => quiet.allowDown !== false && (f.kind === 'down' || f.kind === 'recovered');
    state.held.push(...found.filter(f => !urgent(f) && f.kind !== 'streams'));
    state.held = state.held.slice(-50);
    found = found.filter(urgent);
  } else if (state.held.length) {
    found = [...state.held.map(f => ({ ...f, line: `🌙 ${f.line}` })), ...found];
    state.held = [];
  }
  if (!found.length) return;
  const targets = (cfg.notifications?.targets || []).filter(t => t.enabled !== false);
  await Promise.all(
    targets.map(async t => {
      const mine = found.filter(f => t.events?.[f.kind]);
      if (!mine.length) return;
      const level = mine.some(f => f.level === 'error')
        ? 'error'
        : mine.some(f => f.level === 'warn')
          ? 'warn'
          : mine.every(f => f.level === 'good')
            ? 'good'
            : 'info';
      const lines = mine.slice(0, 10).map(f => f.line);
      if (mine.length > 10) lines.push(`…and ${mine.length - 10} more`);
      const title =
        mine.length === 1 ? mine[0].line.replace(/^\S+\s/, '').slice(0, 120) : `Media Ops: ${mine.length} updates`;
      try {
        await send(t, {
          title,
          lines,
          level,
          events: mine.map(({ kind, level: l, line }) => ({ kind, level: l, text: line })),
        });
        state.lastResult.set(t.id, { at: Date.now(), ok: true });
      } catch (e) {
        state.lastResult.set(t.id, { at: Date.now(), ok: false, error: e.message });
        console.error(`Notification to ${t.name} failed: ${e.message}`);
      }
    }),
  );
}

// Send the daily digest to every destination that wants it.
async function sendDigest(cfg, digest) {
  const targets = (cfg.notifications?.targets || []).filter(t => t.enabled !== false && t.events?.digest);
  await Promise.all(
    targets.map(async t => {
      try {
        await send(t, { ...digest, level: 'info' });
        state.lastResult.set(t.id, { at: Date.now(), ok: true });
      } catch (e) {
        state.lastResult.set(t.id, { at: Date.now(), ok: false, error: e.message });
        console.error(`Digest to ${t.name} failed: ${e.message}`);
      }
    }),
  );
  return targets.length;
}

async function test(target) {
  await send(target, {
    title: 'Media Ops test notification',
    lines: [
      '✅ If you can read this, notifications are working.',
      `Events: ${
        EVENTS.filter(e => target.events?.[e.key])
          .map(e => e.label)
          .join(', ') || 'none selected'
      }`,
    ],
    level: 'good',
  });
}

const lastResult = id => state.lastResult.get(id) || null;

module.exports = { TYPES, EVENTS, publicTarget, mergeTarget, handle, test, lastResult, sendDigest, inQuietHours };
