// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub delivery: each event goes through the rules as it arrives and is stored with
// what they decided. "Now" events wait in hub.db until the next background tick, which sends
// them as one message per destination (like Media Ops always has), so a burst of webhooks
// doesn't become a burst of messages. Quiet hours hold them in hub.db, so a restart loses none.
'use strict';
const notify = require('../notify');
const store = require('./store');
const rules = require('./rules');

const FLAP_MINUTES = 10;
/** @param {import('../types').Config} cfg */
const flapMs = cfg => Math.min(1440, Math.max(0, Number(cfg.hub?.flapMinutes ?? FLAP_MINUTES))) * 60e3;

// The saved rules, or the ones the hub starts with (a hub turned on before rules existed).
/** @param {import('../types').Config} cfg @returns {import('./rules').Rule[]} */
function rulesOf(cfg) {
  return cfg.hub?.rules?.length
    ? cfg.hub.rules
    : rules.starting(cfg.notifications?.targets || [], notify.eventsOf, notify.EVENTS);
}

// Decide and store one event.
/** @param {import('../types').Config} cfg @param {import('./normalize').HubEvent} e */
function route(cfg, e) {
  const r = rules.evaluate(e, rulesOf(cfg));
  /** @type {import('./store').Outcome} */
  const outcome = { rule: r.name, action: r.action };
  if (r.action === 'drop') outcome.status = 'dropped';
  else if (r.action === 'digest') Object.assign(outcome, { status: 'queued', digestId: r.digest });
  else {
    outcome.destinations = r.destinations || [];
    outcome.status = !outcome.destinations.length
      ? 'unrouted'
      : flapMs(cfg) && store.recentlySent(e.dedupeKey, e.type, flapMs(cfg))
        ? 'suppressed'
        : 'pending';
  }
  store.add(e, outcome);
  return outcome;
}

// Quiet hours let through what can't wait: anything critical, and an app going down or coming
// back when "still wake me if an app goes down" is on (the setting Media Ops already has).
/** @param {{ type: string, severity: string }} e @param {{ allowDown?: boolean } | undefined} quiet */
const urgent = (e, quiet) =>
  e.severity === 'critical' || (quiet?.allowDown !== false && (e.type === 'app.down' || e.type === 'app.up'));

/** @type {Record<string, string>} */
const LEVEL = { critical: 'error', error: 'error', warning: 'warn', info: 'info' };
const GOOD = new Set(['app.up', 'app.health_restored']);
/** @param {{ type: string, severity: string }[]} list */
function levelOf(list) {
  if (list.some(e => LEVEL[e.severity] === 'error')) return 'error';
  if (list.some(e => e.severity === 'warning')) return 'warn';
  return list.every(e => GOOD.has(e.type)) ? 'good' : 'info';
}

// Every background tick: send what's pending, one message per destination.
/** @param {import('../types').Config} cfg */
async function deliverNow(cfg) {
  const quiet = cfg.notifications?.quiet;
  const asleep = notify.inQuietHours(quiet);
  let list = store.waiting(asleep ? ['pending'] : ['pending', 'held']);
  if (asleep) {
    const wait = list.filter(e => !urgent(e, quiet));
    // Someone starting to watch isn't worth telling hours later.
    store.mark(
      wait.filter(e => e.type === 'playback.started').map(e => e.id),
      'skipped',
    );
    store.mark(
      wait.filter(e => e.type !== 'playback.started' && e.status !== 'held').map(e => e.id),
      'held',
    );
    list = list.filter(e => urgent(e, quiet));
  }
  if (!list.length) return 0;

  const targets = new Map((cfg.notifications?.targets || []).filter(t => t.enabled !== false).map(t => [t.id, t]));
  /** @type {Map<string, typeof list>} */
  const byTarget = new Map();
  for (const e of list)
    for (const d of e.destinations) if (targets.has(d)) byTarget.set(d, [...(byTarget.get(d) || []), e]);
  /** @type {Map<string, boolean>} event id -> reached at least one destination */
  const reached = new Map(list.map(e => [e.id, false]));

  await Promise.all(
    [...byTarget].map(async ([id, mine]) => {
      const t = /** @type {import('../types').Target} */ (targets.get(id));
      const lines = mine.slice(0, 10).map(e => (e.status === 'held' ? `🌙 ${e.summary}` : e.summary));
      if (mine.length > 10) lines.push(`…and ${mine.length - 10} more`);
      const title =
        mine.length === 1
          ? mine[0].summary.replace(/^\p{Extended_Pictographic}\S*\s/u, '').slice(0, 120)
          : `Media Ops: ${mine.length} updates`;
      const ids = mine.map(e => e.id);
      try {
        await notify.send(t, {
          title,
          lines,
          level: levelOf(mine),
          events: mine.map(e => ({ kind: e.type, level: LEVEL[e.severity] || 'info', text: e.summary })),
        });
        notify.remember(t.id, true);
        store.delivered({ eventIds: ids, destination: t.id, ok: true });
        for (const e of mine) reached.set(e.id, true);
      } catch (err) {
        notify.remember(t.id, false, err.message);
        store.delivered({ eventIds: ids, destination: t.id, ok: false, error: err.message });
        console.error(`Notification to ${t.name} failed: ${err.message}`);
      }
    }),
  );
  const tried = new Set([...byTarget.values()].flat().map(e => e.id));
  store.mark(
    list.filter(e => reached.get(e.id)).map(e => e.id),
    'sent',
  );
  store.mark(
    list.filter(e => !reached.get(e.id) && tried.has(e.id)).map(e => e.id),
    'failed',
  );
  // Every destination it named was removed or switched off since.
  store.mark(
    list.filter(e => !tried.has(e.id)).map(e => e.id),
    'unrouted',
  );
  return byTarget.size;
}

module.exports = { route, deliverNow, rulesOf, urgent, levelOf, FLAP_MINUTES };
