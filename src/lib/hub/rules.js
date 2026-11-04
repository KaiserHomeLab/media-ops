// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub rules: what happens to each event. Checked top to bottom, the first enabled
// rule that matches wins: send it now (to the destinations it lists), hold it for a digest, or
// drop it. The last rule is always "everything else: drop" and can't be removed.
//
// A rule's `match` compares event fields with a value or a list of values, nothing cleverer:
//   { "type": ["media.added"], "media.library": ["Movies", "TV Shows"], "not": { "source": "generic" } }
// A type ending in ".*" matches the whole family ("media.request.*"). `min_severity` matches that
// severity and worse.
'use strict';
const crypto = require('node:crypto');
const { SEVERITIES, POLLED_TYPE } = require('./normalize');

/**
 * @typedef {Record<string, string | string[] | boolean | MatchNot>} Match
 * @typedef {{ not?: Record<string, string | string[] | boolean> }} MatchNot
 * @typedef {{ id: string, name: string, enabled: boolean, match: Record<string, any>, action: 'now' | 'digest' | 'drop',
 *   destinations?: string[], digest?: string, locked?: boolean }} Rule
 */

const CATCH_ALL_ID = 'everything-else';
/** @returns {Rule} */
const catchAll = () => ({
  id: CATCH_ALL_ID,
  name: 'Everything else',
  enabled: true,
  match: {},
  action: 'drop',
  locked: true,
});

// The fields a rule can look at, and how to read each from an event.
/** @type {Record<string, (e: import('./normalize').HubEvent) => unknown>} */
const FIELDS = {
  type: e => e.type,
  source: e => e.source,
  source_instance: e => e.sourceInstance,
  severity: e => e.severity,
  is_upgrade: e => e.isUpgrade,
  'media.kind': e => e.media?.kind ?? null,
  'media.library': e => e.media?.library ?? null,
};
const KEYS = new Set([...Object.keys(FIELDS), 'min_severity', 'not']);

/** @param {string} want @param {unknown} got */
const one = (want, got) =>
  typeof got === 'boolean'
    ? String(want) === String(got)
    : want.endsWith('.*')
      ? String(got ?? '').startsWith(want.slice(0, -1))
      : String(want).toLowerCase() === String(got ?? '').toLowerCase();

/** @param {Record<string, any>} match @param {import('./normalize').HubEvent} e @returns {boolean} */
function matches(match, e) {
  for (const [key, want] of Object.entries(match || {})) {
    if (key === 'not') {
      if (Object.keys(want || {}).length && matches(want, e)) return false;
      continue;
    }
    if (key === 'min_severity') {
      if (SEVERITIES.indexOf(e.severity) < SEVERITIES.indexOf(want)) return false;
      continue;
    }
    const got = FIELDS[key]?.(e);
    const list = Array.isArray(want) ? want : [want];
    if (!list.some(w => one(w, got))) return false;
  }
  return true;
}

// The first enabled rule that matches. The catch-all always does, so there's always an answer.
/** @param {import('./normalize').HubEvent} e @param {Rule[]} rules @returns {Rule} */
function evaluate(e, rules) {
  return rules.find(r => r.enabled && matches(r.match, e)) || catchAll();
}

// ------------------------------------------------------------------ checking what Settings sends
/** @param {unknown} v @param {string} where */
function values(v, where) {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > 50) throw new Error(`${where}: give 1 to 50 values`);
  return list.map(x => {
    if (typeof x === 'boolean') return x;
    const s = String(x ?? '').trim();
    if (!s || s.length > 100) throw new Error(`${where}: values must be 1 to 100 characters`);
    return s;
  });
}
/** @param {unknown} m @param {string} where @param {boolean} [inner] @returns {Record<string, any>} */
function cleanMatch(m, where, inner = false) {
  if (m == null) return {};
  if (typeof m !== 'object' || Array.isArray(m)) throw new Error(`${where}: match must be an object`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (!KEYS.has(k) || (inner && k === 'not')) throw new Error(`${where}: can't match on "${k}"`);
    if (k === 'not') out.not = cleanMatch(v, `${where} (not)`, true);
    else if (k === 'min_severity') {
      if (!SEVERITIES.includes(/** @type {any} */ (v)))
        throw new Error(`${where}: min_severity must be one of ${SEVERITIES.join(', ')}`);
      out.min_severity = v;
    } else {
      const list = values(v, `${where}, ${k}`);
      out[k] = list.length === 1 && !Array.isArray(v) ? list[0] : list;
    }
  }
  return out;
}

// A rule list from Settings (or a backup) -> a clean one: known fields only, the catch-all last.
// `targets` are the destination ids that exist; unknown ones are dropped.
/** @param {unknown} input @param {string[]} targets @returns {Rule[]} */
function clean(input, targets) {
  if (!Array.isArray(input)) throw new Error('Rules must be a list');
  if (input.length > 100) throw new Error('At most 100 rules');
  const known = new Set(targets);
  /** @type {Rule[]} */
  const out = [];
  for (const [i, r] of input.entries()) {
    if (!r || typeof r !== 'object') throw new Error(`Rule ${i + 1} isn't a rule`);
    if (r.id === CATCH_ALL_ID || r.locked) continue; // put back at the end below
    const name =
      String(r.name || '')
        .trim()
        .slice(0, 120) || `Rule ${i + 1}`;
    const where = `"${name}"`;
    const action = r.action;
    if (!['now', 'digest', 'drop'].includes(action)) throw new Error(`${where}: action must be now, digest or drop`);
    /** @type {Rule} */
    const rule = {
      id: /^[\w-]{1,64}$/.test(String(r.id)) ? String(r.id) : crypto.randomUUID(),
      name,
      enabled: r.enabled !== false,
      match: cleanMatch(r.match, where),
      action,
    };
    if (action === 'now')
      rule.destinations = [...new Set((Array.isArray(r.destinations) ? r.destinations : []).map(String))].filter(d =>
        known.has(d),
      );
    if (action === 'digest') {
      const d = String(r.digest || '').trim();
      if (!/^[\w-]{1,64}$/.test(d)) throw new Error(`${where}: pick a digest`);
      rule.digest = d;
    }
    if (out.some(x => x.id === rule.id)) rule.id = crypto.randomUUID();
    out.push(rule);
  }
  return [...out, catchAll()];
}

// ------------------------------------------------------------------ the rules the hub starts with
// Turning the hub on must not change where anything goes: one rule per notification kind, sent
// to every destination that has that event ticked today (lib/notify.js EVENTS, with defaults for
// events added since a destination was saved). The spec's suggested rules follow, switched off.
/** @param {import('../types').Target[]} targets @param {(t: import('../types').Target) => Record<string, boolean>} eventsOf @param {{ key: string, label: string }[]} events @returns {Rule[]} */
function starting(targets, eventsOf, events) {
  const on = targets.filter(t => t.enabled !== false);
  /** @type {Rule[]} */
  const fromToday = events
    .filter(ev => POLLED_TYPE[ev.key])
    .map(ev => ({
      id: `today-${ev.key}`,
      name: ev.label,
      enabled: true,
      match: { type: [POLLED_TYPE[ev.key]] },
      action: /** @type {const} */ ('now'),
      destinations: on.filter(t => eventsOf(t)[ev.key]).map(t => t.id),
    }));
  /** @type {Rule[]} */
  const suggested = [
    {
      id: 'suggested-alerts',
      name: 'Problems go out straight away',
      enabled: false,
      match: { type: ['app.down', 'download.failed', 'download.stuck', 'system.disk'], min_severity: 'warning' },
      action: 'now',
      destinations: [],
    },
    {
      id: 'suggested-recovered',
      name: 'Recoveries go out straight away',
      enabled: false,
      match: { type: ['app.up', 'app.health_restored'] },
      action: 'now',
      destinations: [],
    },
    {
      id: 'suggested-upgrades',
      name: 'Quality upgrades: never announced as new',
      enabled: false,
      match: { type: ['media.upgraded'] },
      action: 'drop',
    },
    {
      id: 'suggested-added',
      name: 'New movies and shows go to the daily digest',
      enabled: false,
      match: { type: ['media.added'], 'media.library': ['Movies', 'TV Shows', 'Anime'] },
      action: 'digest',
      digest: 'added_daily',
    },
    {
      id: 'suggested-requests',
      name: 'Request updates go out straight away',
      enabled: false,
      match: { type: ['media.request.*'] },
      action: 'now',
      destinations: [],
    },
    {
      id: 'suggested-leaving',
      name: 'Leaving Soon goes to the weekly digest',
      enabled: false,
      match: { type: ['media.leaving_soon'] },
      action: 'digest',
      digest: 'leaving_weekly',
    },
  ];
  return [...fromToday, ...suggested, catchAll()];
}

module.exports = { CATCH_ALL_ID, FIELDS, matches, evaluate, clean, starting, catchAll };
