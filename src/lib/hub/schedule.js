// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// When a digest is due: a five-field cron expression ("0 8 * * *" = 08:00 every day) read in a
// time zone ("America/Chicago"; blank = the container's own, set by TZ). Just enough cron for
// schedules: numbers, *, lists (1,15), ranges (1-5) and steps (*/15, 8-18/2). Sunday is 0 or 7.
'use strict';

const FIELDS = /** @type {const} */ ([
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
]);

/** @typedef {{ minute: Set<number>, hour: Set<number>, dom: Set<number>, month: Set<number>, dow: Set<number>, anyDom: boolean, anyDow: boolean }} Cron */

/** @param {string} expr @returns {Cron} */
function parse(expr) {
  const parts = String(expr || '')
    .trim()
    .split(/\s+/);
  if (parts.length !== 5)
    throw new Error('A schedule needs five parts: minute hour day month weekday, like "0 8 * * *"');
  const sets = parts.map((p, i) => {
    const [name, lo, hi] = FIELDS[i];
    const out = new Set();
    for (const piece of p.split(',')) {
      const m = piece.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`Schedule ${name}: "${piece}" isn't a number, range, list or step`);
      const step = m[2] ? Number(m[2]) : 1;
      // "*" is the whole range; "5" alone is just 5, but "5/15" means 5 onwards in steps of 15.
      const [a, b] =
        m[1] === '*'
          ? [lo, hi]
          : m[1].includes('-')
            ? m[1].split('-').map(Number)
            : [Number(m[1]), m[2] ? hi : Number(m[1])];
      if (!(step >= 1) || a < lo || b > hi || a > b)
        throw new Error(`Schedule ${name}: ${piece} is outside ${lo}-${hi}`);
      for (let v = a; v <= b; v += step) out.add(name === 'day of week' && v === 7 ? 0 : v);
    }
    return out;
  });
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    anyDom: parts[2] === '*',
    anyDow: parts[4] === '*',
  };
}

/** @param {string} tz */
function validZone(tz) {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of a moment in a time zone.
/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();
/** @param {number} t @param {string} tz */
function partsIn(t, tz) {
  const key = tz || '';
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formats.set(key, f);
  }
  /** @type {Record<string, string>} */
  const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), dow };
}

/** @param {Cron} c @param {ReturnType<typeof partsIn>} p */
function dayMatches(c, p) {
  if (!c.month.has(p.month)) return false;
  // Cron's rule: with both day fields set, either one matching is enough.
  if (c.anyDom && c.anyDow) return true;
  if (c.anyDom) return c.dow.has(p.dow);
  if (c.anyDow) return c.dom.has(p.day);
  return c.dom.has(p.day) || c.dow.has(p.dow);
}

// The first matching minute after `after` (ms), or null if none in the next 400 days. Walks
// minute by minute within a matching hour, an hour at a time otherwise.
/** @param {string} expr @param {string} tz @param {number} after @returns {number | null} */
function next(expr, tz, after) {
  const c = parse(expr);
  let t = Math.floor(after / 60e3) * 60e3 + 60e3;
  const end = after + 400 * 864e5;
  while (t <= end) {
    const p = partsIn(t, tz);
    // A day or hour that can't match is skipped to the next hour boundary: one step per hour
    // stays right across daylight-saving changes, and 400 days is under 10,000 steps.
    if (!dayMatches(c, p) || !c.hour.has(p.hour)) {
      t += (60 - p.minute) * 60e3;
      continue;
    }
    if (c.minute.has(p.minute)) return t;
    t += 60e3;
  }
  return null;
}

module.exports = { parse, next, validZone };
