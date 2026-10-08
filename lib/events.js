// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
const { hintFor } = require('./hints');
// One errors & warnings feed for the whole stack, plus dismissals that survive restarts.
const crypto = require('node:crypto');

const DAY = 864e5;
const keyOf = (svcId, source, message, time) =>
  crypto
    .createHash('sha1')
    .update(`${svcId}|${source}|${message}|${time ?? ''}`)
    .digest('hex')
    .slice(0, 16);

// "Live" events describe a condition that's true right now (app down, failing health check,
// stuck queue item). Log events are history with a timestamp.
function collect(services) {
  const now = Date.now();
  const out = [];
  const push = (s, e) => {
    const t = e.live ? now : new Date(e.time).getTime();
    out.push({
      key: keyOf(s.id, e.source, e.message, e.live ? null : e.time),
      svcId: s.id,
      svc: s.name,
      level: e.level,
      t: isNaN(t) ? now : t,
      source: e.source || '',
      message: e.message,
      detail: e.detail || null,
      live: !!e.live,
      healthCheck: !!e.healthCheck,
      queueId: e.queueId ?? null,
    });
    out.at(-1).hint = hintFor(out.at(-1));
  };
  for (const s of services) {
    if (!s.up) {
      push(s, { level: 'error', source: 'Connection', message: `Unreachable — ${s.error}`, live: true });
      continue;
    }
    for (const h of s.data?.health || [])
      push(s, {
        level: h.type === 'error' ? 'error' : 'warn',
        source: 'Health check',
        message: h.message,
        live: true,
        healthCheck: true,
      });
    for (const e of s.data?.events || []) push(s, e);
  }
  // Live problems first, then newest log lines.
  return out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.t - a.t);
}

/** @typedef {{ before: Record<string, number>, items: any[] }} DismissState */
/** @returns {DismissState} */
const emptyState = () => ({ before: {}, items: [] });

// Mark dismissed events. Returns the events plus a pruned dismissal state (or null if unchanged).
/** @param {any[]} events @param {any[]} services @param {DismissState} [state] */
function apply(events, services, state = emptyState()) {
  const items = new Map((state.items || []).map(i => [i.key, i]));
  const before = state.before || {};
  for (const e of events) {
    const wm = Math.max(before[e.svcId] || 0, before['*'] || 0);
    e.dismissed = items.has(e.key) || (!e.live && e.t <= wm);
  }

  // A dismissed live condition that has since cleared is forgotten, so it shows again if it comes back.
  // Only judge apps we reached this round: an unreachable app can't tell us its health.
  const reached = new Set(services.filter(s => s.up).map(s => s.id));
  const present = new Set(events.map(e => e.key));
  const known = new Set(services.map(s => s.id));
  const pruned = [...items.values()].filter(i => {
    if (!known.has(i.svcId)) return false; // app removed or disabled
    if (i.connection) return !reached.has(i.svcId); // "app is down" ends when it's back up
    if (i.live) return present.has(i.key) || !reached.has(i.svcId);
    return Date.now() - i.at < 30 * DAY; // old log lines have long scrolled out of the app's log
  });
  return { events, changed: pruned.length !== items.size ? { before, items: pruned } : null };
}

// Dismiss specific entries (`keys`), everything from one app (`svcId`), or everything (`all`).
/**
 * @param {DismissState} state
 * @param {any[]} events
 * @param {{ keys?: string[], svcId?: string, all?: boolean }} [which]
 */
function dismiss(state = emptyState(), events, { keys, svcId, all } = {}) {
  const items = new Map((state.items || []).map(i => [i.key, i]));
  const before = { ...(state.before || {}) };
  const pick = all || svcId ? events.filter(e => all || e.svcId === svcId) : events.filter(e => keys?.includes(e.key));
  for (const e of pick)
    items.set(e.key, {
      key: e.key,
      svcId: e.svcId,
      live: e.live,
      connection: e.source === 'Connection' && e.live,
      at: Date.now(),
    });
  // "Dismiss all" also sets a watermark, so log lines older than now stay hidden even after they scroll out.
  if (all) before['*'] = Date.now();
  else if (svcId) before[svcId] = Date.now();
  return { before, items: [...items.values()] };
}

module.exports = { collect, apply, dismiss, emptyState };
