// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub digests: what rules held back ("digest" action), sent on a schedule as one
// calm summary ("Added to Plex · Tuesday, Nov 3"). Each title once, TV episodes folded into
// seasons, sections by library, upgrades only ever a count in the footer. Not the same thing as
// the daily summary in lib/digest.js (health, plays, disk), which is sent as before.
'use strict';
const crypto = require('node:crypto');
const notify = require('../notify');
const discord = require('../discord');
const store = require('./store');
const schedule = require('./schedule');
const newsletter = require('./newsletter');
const smtp = require('../smtp');

/**
 * @typedef {{ id: string, title: string, enabled: boolean, cron: string, timezone: string,
 *   destinations: string[], skipIfEmpty: boolean, maxItemsPerSection: number, footer: string,
 *   recipients?: string[] }} Digest  recipients: newsletter addresses for its email destinations
 * @typedef {import('./normalize').HubEvent} HubEvent
 * @typedef {{ line: string, posterUrl: string | null, overview: string | null }} Item
 * @typedef {{ name: string, lines: string[], more: number, items: Item[] }} Section
 */

// ------------------------------------------------------------------ settings
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** @returns {Digest[]} */
const starting = () => [
  {
    id: 'added_daily',
    title: 'Added to Plex',
    enabled: false,
    cron: '0 8 * * *',
    timezone: '',
    destinations: [],
    skipIfEmpty: true,
    maxItemsPerSection: 25,
    footer: '',
  },
  {
    id: 'leaving_weekly',
    title: 'Leaving soon',
    enabled: false,
    cron: '0 10 * * 6',
    timezone: '',
    destinations: [],
    skipIfEmpty: true,
    maxItemsPerSection: 25,
    footer: '',
  },
];

/** @param {unknown} input @param {string[]} targets @returns {Digest[]} */
function clean(input, targets) {
  if (!Array.isArray(input)) throw new Error('Digests must be a list');
  if (input.length > 20) throw new Error('At most 20 digests');
  const known = new Set(targets);
  /** @type {Digest[]} */
  const out = [];
  for (const d of input) {
    const id = String(d?.id || '').trim();
    if (!ID.test(id)) throw new Error(`Digest id "${id}": lowercase letters, digits, - and _`);
    if (out.some(x => x.id === id)) throw new Error(`Two digests called "${id}"`);
    const title =
      String(d.title || '')
        .trim()
        .slice(0, 100) || id;
    const cron = String(d.cron || '').trim();
    try {
      schedule.parse(cron);
    } catch (e) {
      throw new Error(`"${title}": ${e.message}`, { cause: e });
    }
    const timezone = String(d.timezone || '').trim();
    if (!schedule.validZone(timezone)) throw new Error(`"${title}": unknown time zone "${timezone}"`);
    const max = Math.round(Number(d.maxItemsPerSection ?? 25));
    out.push({
      id,
      title,
      enabled: d.enabled === true,
      cron,
      timezone,
      destinations: [...new Set((Array.isArray(d.destinations) ? d.destinations : []).map(String))].filter(x =>
        known.has(x),
      ),
      skipIfEmpty: d.skipIfEmpty !== false,
      maxItemsPerSection: Number.isFinite(max) ? Math.min(100, Math.max(1, max)) : 25,
      footer: String(d.footer || '')
        .trim()
        .slice(0, 200),
      recipients: recipientsOf(d.recipients, title),
    });
  }
  return out;
}

// Newsletter addresses: a list or one per line/comma, each a plain address, at most 500, no repeats.
/** @param {unknown} v @param {string} title @returns {string[]} */
function recipientsOf(v, title) {
  const list = (Array.isArray(v) ? v.map(String) : smtp.addressList(v)).map(a => a.trim()).filter(Boolean);
  if (list.length > 500) throw new Error(`"${title}": at most 500 newsletter addresses`);
  const bad = list.find(a => !smtp.isAddress(a));
  if (bad) throw new Error(`"${title}": "${bad.slice(0, 80)}" isn't an email address`);
  /** @type {Set<string>} */
  const seen = new Set();
  return list.filter(a => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
}

/** @param {import('../types').Config} cfg @returns {Digest[]} */
const digestsOf = cfg => /** @type {Digest[]} */ (cfg.hub?.digests ?? starting());

// ------------------------------------------------------------------ building one
const LIBRARY_ORDER = ['movies', 'tv shows', 'anime'];
/** @type {Record<string, string>} */
const TYPE_SECTION = {
  'media.leaving_soon': 'Leaving soon',
  'media.removed': 'Removed',
  'media.request.available': 'Now available',
  'media.request.created': 'Requested',
  'media.request.approved': 'Approved',
  'media.problem_report': 'Problem Reports',
};

/** @param {number[]} nums e.g. [1,2,3,5,7,8] -> "1–3, 5, 7–8" */
function ranges(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(', ');
}
/** @param {number | null} n */
const pad = n => String(n ?? 0).padStart(2, '0');

// Episodes of one show -> one line: a single episode by name, a season as an episode range, a
// season 1 that starts at episode 1 as a new series.
/** @param {import('./normalize').Media[]} eps */
function showLine(eps) {
  const show = eps[0].show || eps[0].title;
  if (eps.length === 1) {
    const e = eps[0];
    return `${show} S${pad(e.season)}E${pad(e.episode)}${e.episodeTitle ? ` "${e.episodeTitle}"` : ''}`;
  }
  /** @type {Map<number, number[]>} */
  const seasons = new Map();
  for (const e of eps) seasons.set(e.season ?? 0, [...(seasons.get(e.season ?? 0) || []), e.episode ?? 0]);
  const order = [...seasons.keys()].sort((a, b) => a - b);
  const isNew = seasons.get(1)?.includes(1);
  const parts = order.map(
    s => `Season ${s}, episode${seasons.get(s)?.length === 1 ? '' : 's'} ${ranges(seasons.get(s) || [])}`,
  );
  return `${show}${isNew ? ' (new series)' : ''}: ${parts.join('; ')}`;
}

/** @param {import('./normalize').Media} m */
const titleLine = m => `${m.title}${m.year ? ` (${m.year})` : ''}`;

// The digest's content from the queued events: what to list, and what's only counted.
/** @param {Digest} d @param {HubEvent[]} events @param {number} [now] */
function build(d, events, now = Date.now()) {
  // Each title once: an added and an upgrade of the same thing is "added"; the latest event
  // for a key wins otherwise (a better quality arriving later).
  /** @type {Map<string, HubEvent>} */
  const added = new Map();
  /** @type {Set<string>} */
  const upgraded = new Set();
  /** @type {Map<string, HubEvent>} */
  const other = new Map();
  for (const e of events) {
    if (e.type === 'media.added') added.set(e.dedupeKey, e);
    else if (e.type === 'media.upgraded') upgraded.add(e.dedupeKey);
    else other.set(`${e.type}|${e.dedupeKey}`, e);
  }
  for (const k of added.keys()) upgraded.delete(k);

  // Added titles by library; within a library, a show's episodes become one line.
  /** @type {Map<string, { items: Item[], shows: Map<string, import('./normalize').Media[]> }>} */
  const libs = new Map();
  for (const e of added.values()) {
    const m = e.media;
    const lib = m?.library || (m?.kind === 'movie' ? 'Movies' : m?.kind ? 'TV Shows' : 'Other');
    if (!libs.has(lib)) libs.set(lib, { items: [], shows: new Map() });
    const L = /** @type {{ items: Item[], shows: Map<string, import('./normalize').Media[]> }} */ (libs.get(lib));
    if (!m) L.items.push({ line: e.summary, posterUrl: null, overview: null });
    else if (m.kind === 'episode') {
      const key = m.ids.tvdb ? `tvdb:${m.ids.tvdb}` : (m.show || m.title).toLowerCase();
      L.shows.set(key, [...(L.shows.get(key) || []), m]);
    } else L.items.push({ line: titleLine(m), posterUrl: m.posterUrl, overview: m.overview });
  }
  const max = d.maxItemsPerSection || 25;
  // Lines in order, capped; `items` keep each line's poster and overview for richer outputs (Discord).
  /** @param {string} name @param {Item[]} items @returns {Section} */
  const section = (name, items) => ({
    name,
    lines: items.slice(0, max).map(i => i.line),
    more: Math.max(0, items.length - max),
    items: items.slice(0, max),
  });
  const libNames = [...libs.keys()].sort((a, b) => {
    const ia = LIBRARY_ORDER.indexOf(a.toLowerCase()),
      ib = LIBRARY_ORDER.indexOf(b.toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  /** @type {Section[]} */
  const sections = libNames.map(name => {
    const L = /** @type {{ items: Item[], shows: Map<string, import('./normalize').Media[]> }} */ (libs.get(name));
    const shows = [...L.shows.values()].map(eps => ({
      line: showLine(eps),
      posterUrl: eps[0].posterUrl,
      overview: null,
    }));
    return section(
      name,
      [...L.items, ...shows].sort((a, b) => a.line.localeCompare(b.line)),
    );
  });
  // Everything else a rule sent here (Leaving Soon, requests, a script's events), by type.
  /** @type {Map<string, Item[]>} */
  const byType = new Map();
  for (const e of other.values()) {
    const name = TYPE_SECTION[e.type] || 'Other';
    const item = { line: e.summary, posterUrl: e.media?.posterUrl ?? null, overview: null };
    byType.set(name, [...(byType.get(name) || []), item]);
  }
  for (const [name, items] of byType) sections.push(section(name, items));

  const items = added.size + other.size;
  // "N new" counts what's listed (a movie, a show), not episodes: 10 episodes of one show is 1 new.
  let titles = 0;
  for (const L of libs.values()) titles += L.items.length + L.shows.size;
  const date = new Date(now).toLocaleDateString('en-US', {
    ...(d.timezone ? { timeZone: d.timezone } : {}),
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  const footer = [
    titles ? `${titles} new` : '',
    upgraded.size ? `${upgraded.size} upgraded quietly` : '',
    d.footer,
  ]
    .filter(Boolean)
    .join(' · ');
  return { title: `${d.title} · ${date}`, sections, footer, items, upgrades: upgraded.size };
}

// The digest as plain lines, for every kind of destination but Discord (which gets embeds).
/** @param {ReturnType<typeof build>} b */
function asText(b) {
  /** @type {string[]} */
  const lines = [];
  for (const s of b.sections) {
    if (lines.length) lines.push('');
    lines.push(s.name.toUpperCase(), ...s.lines.map(l => `• ${l}`));
    if (s.more) lines.push(`…and ${s.more} more`);
  }
  if (b.footer) lines.push('', b.footer);
  return { title: b.title, lines };
}

/** @param {import('../types').Target} t @param {ReturnType<typeof build>} b */
async function discordDigest(t, b) {
  for (const m of discord.digest(t, b)) await discord.post(t.webhookUrl, m);
}

// ------------------------------------------------------------------ running
/** @type {Map<string, number>} digest id -> first seen (a digest never run waits for its next slot from then) */
const firstSeen = new Map();

// Build and send one digest now, marking what it took. Returns what happened.
/** @param {import('../types').Config} cfg @param {Digest} d */
async function run(cfg, d) {
  const events = store.queuedFor(d.id);
  const b = build(d, events);
  const runId = crypto.randomUUID();
  const window = { id: runId, digestId: d.id, windowStart: events[0]?.receivedAt ?? null, windowEnd: Date.now() };
  const ids = events.map(e => e.id);
  // Nothing to list: no post when skipIfEmpty is on (or there isn't even an upgrade to count).
  if (!b.items && (d.skipIfEmpty || !b.upgrades)) {
    // Counted-only upgrades are used up all the same, so they don't pile up.
    store.digestRun({ ...window, items: 0, upgrades: b.upgrades, status: 'empty' }, ids);
    return { status: 'empty', items: 0, upgrades: b.upgrades, sent: 0 };
  }
  const targets = (cfg.notifications?.targets || []).filter(t => t.enabled !== false && d.destinations.includes(t.id));
  // A run that reached nobody still counts as this slot's run (the next try is the next slot, not
  // the next 10-second tick), but takes no titles: they wait, queued, for the next one.
  if (!targets.length) {
    store.digestRun({ ...window, items: b.items, upgrades: b.upgrades, status: 'no-destination' }, []);
    return { status: 'no-destination', items: b.items, upgrades: b.upgrades, sent: 0 };
  }
  const text = asText(b);
  let sent = 0;
  for (const t of targets) {
    try {
      // Discord gets embeds (sections, posters, its limits); everything else the plain text.
      // Email gets HTML, and a copy of its own for each newsletter address.
      if (t.type === 'discord') await notify.sendWith(t, () => discordDigest(t, b));
      else if (t.type === 'email') await notify.sendWith(t, () => newsletter.sendDigest(cfg, d, b, text, t));
      else await notify.send(t, { ...text, level: 'info' });
      notify.remember(t.id, true);
      store.delivered({ digestRunId: runId, destination: t.id, ok: true });
      sent++;
    } catch (e) {
      notify.remember(t.id, false, e.message);
      store.delivered({ digestRunId: runId, destination: t.id, ok: false, error: e.message });
      console.error(`Digest "${d.title}" to ${t.name} failed: ${e.message}`);
    }
  }
  if (!sent) {
    store.digestRun({ ...window, items: b.items, upgrades: b.upgrades, status: 'failed' }, []);
    return { status: 'failed', items: b.items, upgrades: b.upgrades, sent };
  }
  store.digestRun({ ...window, items: b.items, upgrades: b.upgrades, status: 'sent' }, ids);
  return { status: 'sent', items: b.items, upgrades: b.upgrades, sent };
}

// Every background tick: run each enabled digest whose next time since its last run has come.
// One missed while Media Ops was down runs once when it's back.
/** @param {import('../types').Config} cfg @param {number} [now] */
async function runDue(cfg, now = Date.now()) {
  for (const d of digestsOf(cfg)) {
    if (!d.enabled) continue;
    const last = store.lastRun(d.id);
    if (!last && !firstSeen.has(d.id)) firstSeen.set(d.id, now);
    const from = last?.sentAt ?? /** @type {number} */ (firstSeen.get(d.id));
    const due = schedule.next(d.cron, d.timezone, from);
    if (due != null && due <= now) await run(cfg, d);
  }
}

module.exports = { starting, clean, digestsOf, build, asText, run, runDue, ranges, showLine };
