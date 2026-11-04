// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Discord webhooks: everything Discord-specific about sending, for alerts (lib/notify.js) and
// Notification Hub digests (lib/hub/digests.js).
//   - Markdown escaped in text from apps, so "M*A*S*H" shows as written, not "MAS*H"
//   - each destination's own name, avatar and colour
//   - Discord's limits: 10 embeds and 6000 characters per message, 4096 per embed description;
//     a digest that's longer goes out as several messages
//   - one message at a time per webhook; on 429 it waits as long as Discord says and tries again,
//     a 5xx is tried 3 times, so a burst never loses a message
'use strict';
const { req } = require('./http');

const LIMITS = { embeds: 10, total: 6000, description: 4096, title: 256, footer: 2048, content: 2000 };
const DEFAULT_COLOR = 0xe5a00d; // Plex amber, for digests when a destination has no colour of its own

// Discord treats a backslash before any punctuation as "show this character as is", so escaping
// every markdown character is safe: nothing extra ever shows.
/** @param {unknown} s */
const escape = s => String(s ?? '').replace(/[\\*_~`|>#\-[\]()]/g, c => `\\${c}`);

/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** @param {string | undefined} hex "#E5A00D" -> 0xE5A00D */
const colorOf = hex => (/^#?[0-9a-f]{6}$/i.test(String(hex || '')) ? parseInt(String(hex).replace('#', ''), 16) : null);

// Name and avatar a destination posts as (Discord's own for the webhook when left blank).
/** @param {import('./types').Target} t @param {string} fallbackName */
const branding = (t, fallbackName) => ({
  username: cut(String(t.username || '').trim() || fallbackName, 80),
  ...(/^https:\/\/\S+$/i.test(String(t.avatarUrl || '')) ? { avatar_url: t.avatarUrl } : {}),
});

// ------------------------------------------------------------------ sending, one at a time per webhook
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
// How long the first 5xx retry waits (doubling after). Tests make it short.
const timing = { retryMs: 500 };

// Retry-After (seconds) from a 429; Discord also sends X-RateLimit-Reset-After.
/** @param {any} e */
function waitFor(e) {
  const h = e?.reply?.headers;
  const s = Number(h?.get?.('retry-after') ?? h?.get?.('x-ratelimit-reset-after'));
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 1000;
}

/** @param {string} url @param {object} body */
async function attempt(url, body) {
  let fivexx = 0;
  for (let tries = 0; ; tries++) {
    try {
      return await req(url, {
        method: 'POST',
        as: 'text',
        timeout: 10000,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      const status = e?.reply?.status;
      if (status === 429 && tries < 5) {
        const ms = waitFor(e);
        if (ms > 60e3) throw e; // a minute or more: give up rather than block every other message
        await sleep(ms);
        continue;
      }
      if (status >= 500 && ++fivexx < 3) {
        await sleep(timing.retryMs * 2 ** (fivexx - 1));
        continue;
      }
      throw e;
    }
  }
}

// Post to a webhook, after whatever is already being sent to it.
/** @param {string} url @param {object} body */
function post(url, body) {
  const prev = queues.get(url) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => attempt(url, body));
  queues.set(url, p);
  p.finally(() => {
    if (queues.get(url) === p) queues.delete(url);
  }).catch(() => {});
  return p;
}

// ------------------------------------------------------------------ messages
// An alert: one embed, the title and lines escaped.
/** @param {import('./types').Target} t @param {{ title: string, lines: string[], color: number }} m */
function alert(t, { title, lines, color }) {
  return {
    ...branding(t, 'Media Ops'),
    allowed_mentions: { parse: [] }, // text from an app (a log line) must never ping @everyone
    embeds: [
      {
        title: cut(escape(title), LIMITS.title),
        description: cut(lines.map(escape).join('\n'), LIMITS.description),
        color: colorOf(t.color) ?? color,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** @param {any} e */
const size = e =>
  (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0) + (e.author?.name?.length || 0);

// A digest (lib/hub/digests.js build()) -> Discord messages. One embed per section; a Movies
// section of 4 or fewer with posters gets a small embed per movie (poster and one line about
// it). Long sections continue in another embed, and embeds are packed into as few messages as
// Discord's limits allow. The footer goes on the very last embed.
/** @param {import('./types').Target} t @param {{ title: string, sections: { name: string, lines: string[], more: number, items?: { line: string, posterUrl: string | null, overview: string | null }[] }[], footer: string }} b */
function digest(t, b) {
  const color = colorOf(t.color) ?? DEFAULT_COLOR;
  /** @type {any[]} */
  const embeds = [];
  for (const s of b.sections) {
    const items = s.items || [];
    if (/^movies$/i.test(s.name) && items.length && items.length <= 4 && !s.more && items.every(i => i.posterUrl)) {
      for (const i of items)
        embeds.push({
          color,
          author: { name: cut(s.name.toUpperCase(), 256) },
          title: cut(escape(i.line), LIMITS.title),
          ...(i.overview ? { description: cut(escape(i.overview.split(/(?<=[.!?])\s/)[0]), 300) } : {}),
          thumbnail: { url: i.posterUrl },
        });
      continue;
    }
    const lines = s.lines.map(l => `• ${escape(l)}`);
    if (s.more) lines.push(`…and ${s.more} more`);
    // Split at line boundaries so no description passes 4096 (and a long one isn't one huge embed).
    let chunk = '';
    let part = 0;
    const flush = () => {
      if (!chunk) return;
      embeds.push({
        color,
        title: cut(`${escape(s.name)}${part++ ? ' (continued)' : ''}`, LIMITS.title),
        description: chunk,
      });
      chunk = '';
    };
    for (const l of lines) {
      const line = cut(l, 1000);
      if (chunk.length + line.length + 1 > 3000) flush();
      chunk += (chunk ? '\n' : '') + line;
    }
    flush();
  }
  if (!embeds.length) embeds.push({ color, description: 'Nothing new.' });
  if (b.footer) embeds[embeds.length - 1].footer = { text: cut(b.footer, LIMITS.footer) };

  /** @type {any[][]} */
  const messages = [[]];
  let total = 0;
  for (const e of embeds) {
    const cur = messages[messages.length - 1];
    if (cur.length && (cur.length >= LIMITS.embeds || total + size(e) > LIMITS.total)) {
      messages.push([e]);
      total = size(e);
    } else {
      cur.push(e);
      total += size(e);
    }
  }
  const [title, ...rest] = b.title.split(' · ');
  const content = cut(`**${escape(title)}**${rest.length ? ` · ${escape(rest.join(' · '))}` : ''}`, LIMITS.content);
  return messages.map((m, i) => ({
    ...branding(t, 'Media Ops'),
    allowed_mentions: { parse: [] },
    ...(i === 0 ? { content } : {}),
    embeds: m,
  }));
}

module.exports = { escape, post, alert, digest, colorOf, timing, LIMITS, DEFAULT_COLOR };
