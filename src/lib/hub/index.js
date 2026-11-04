// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub (docs/notification-hub.md): webhooks in from Sonarr, Radarr, Seerr and
// anything else, plus what the background poll notices, turned into one event format and kept
// in /config/hub.db. Off until turned on under Settings; while off, /api/hub/in/ answers 404.
//
// Every event goes through the rules (lib/hub/rules.js): sent now, held for a digest, or
// dropped. When the hub is on, it decides all of Media Ops' notifications (lib/hub/deliver.js).
'use strict';
const fs = require('node:fs');
const config = require('../config');
const { readJson, send } = require('../web');
const store = require('./store');
const sources = require('./sources');
const parsers = require('./parsers');
const { finish, fromPolled, fromMediaReview } = require('./normalize');
const { route, deliverNow, rulesOf } = require('./deliver');
const { EVENT_TYPES } = require('./rules');
const digests = require('./digests');
const { unsubscribe } = require('./newsletter');

/** @param {import('../types').Config} cfg */
const enabled = cfg => !!cfg.hub?.enabled;

// Requests with a wrong token: counted for Settings, not put in the errors feed one by one
// (anyone who can reach the port could fill it).
const rejected = { count: 0, lastAt: /** @type {number | null} */ (null) };
// 20 wrong tokens from one address in 15 minutes and it waits out the window. Kept apart from
// the login lockout (lib/auth.js), so a misconfigured app retrying a stale token, or a reverse
// proxy that makes every request look alike, can't lock you out of Settings.
const WINDOW = 15 * 60e3,
  MAX_WRONG = 20;
const wrong = new Map(); // ip -> { n, since }
const { clientIp: ipOf } = require('../auth'); // honours TRUST_PROXY, like the login lockout
/** @param {import('node:http').IncomingMessage} req */
function lockedOut(req) {
  const f = wrong.get(ipOf(req));
  return f && Date.now() - f.since < WINDOW && f.n >= MAX_WRONG ? Math.ceil((f.since + WINDOW - Date.now()) / 60e3) : 0;
}
/** @param {import('node:http').IncomingMessage} req */
function noteFailure(req) {
  const ip = ipOf(req),
    now = Date.now();
  const f = wrong.get(ip);
  wrong.set(ip, f && now - f.since < WINDOW ? { n: f.n + 1, since: f.since } : { n: 1, since: now });
  if (wrong.size > 1000) for (const [k, v] of wrong) if (now - v.since > WINDOW) wrong.delete(k);
  rejected.count++;
  rejected.lastAt = now;
}

// POST /api/hub/in/<type>[/<instance>]. No session and no Origin check: the apps calling it
// are servers, and the token is what lets them in.
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
async function ingest(req, res, url) {
  const cfg = config.load();
  if (!enabled(cfg)) return send(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Use POST' });
  }
  const [type, instance = type, ...rest] = url.pathname.slice('/api/hub/in/'.length).split('/');
  if (!type || rest.length) return send(res, 404, { error: 'Not found' });
  const wait = lockedOut(req);
  if (wait) return send(res, 429, { error: `Too many wrong tokens. Try again in ${wait} minutes.` });
  const source = sources.verify(sources.list(cfg), type, instance, sources.tokenFrom(req.headers, url.searchParams));
  if (!source) {
    noteFailure(req);
    return send(res, 401, { error: 'Unknown source or wrong token' });
  }
  // Sonarr's payload for a season pack lists every episode; 512 KB is far more than any sends.
  const body = await readJson(req, 512 * 1024);
  const opts = { library: source.library };
  const parsed =
    source.type === 'sonarr' || source.type === 'radarr'
      ? parsers.arr(body, source.type, opts)
      : source.type === 'seerr'
        ? parsers.seerr(body)
        : parsers.generic(body);
  // The raw payload goes with the first event only; the rest came from the same body.
  const events = parsed.map((p, i) =>
    finish({ source: source.type, sourceInstance: source.instance, raw: i === 0 ? body : null }, p),
  );
  for (const e of events) route(cfg, e);
  store.sawSource(source.id, events[0]?.type || 'hub.unhandled');
  return send(res, 200, { ok: true, events: events.length });
}

// After each background poll, from notify.handle(): what it noticed, and titles newly Leaving
// Soon in Media Review, through the rules. True when the hub took them; false (hub off, or
// hub.db broken) and notify.js sends them itself, as it always has.
/** @param {import('../types').Config} cfg @param {import('../notify').Detected[]} noticed @param {import('../types').Polled[]} services */
function take(cfg, noticed, services) {
  if (!enabled(cfg)) return false;
  try {
    for (const e of [...noticed.map(fromPolled), ...fromMediaReview(services)]) route(cfg, e);
    return true;
  } catch (e) {
    console.error(`Notification Hub: couldn't record events, sending them the usual way: ${e.message}`);
    return false;
  }
}

// Every background tick, after take(): send what's due.
/** @param {import('../types').Config} cfg */
async function tick(cfg) {
  maintain();
  if (!enabled(cfg)) return;
  try {
    await deliverNow(cfg);
  } catch (e) {
    console.error(`Notification Hub: couldn't send: ${e.message}`);
  }
  // Not awaited: a newsletter to hundreds of addresses takes minutes, and the monitor (history,
  // alerts) mustn't wait for it. One run at a time, so a slow one isn't started again.
  if (!digestsRunning) {
    digestsRunning = true;
    digests
      .runDue(cfg)
      .catch(e => console.error(`Notification Hub: couldn't send a digest: ${e.message}`))
      .finally(() => (digestsRunning = false));
  }
}
let digestsRunning = false;

let prunedAt = 0;
// Hourly from the background monitor: drop old raw payloads and events. Whenever hub.db exists,
// on or off: turning the hub off mustn't keep requesters' details past 7 days.
function maintain() {
  if (Date.now() - prunedAt < 3600e3 || !fs.existsSync(store.FILE())) return;
  prunedAt = Date.now();
  try {
    store.prune();
  } catch (e) {
    console.error(`Notification Hub: couldn't clean up hub.db: ${e.message}`);
  }
}

// Settings: the switch, the sources with when each was last heard from, and rejected requests.
/** @param {import('../types').Config} cfg */
function settingsOf(cfg) {
  const stats = enabled(cfg) || sources.list(cfg).length ? store.sourceStats() : {};
  return {
    enabled: enabled(cfg),
    rules: rulesOf(cfg),
    digests: digests.digestsOf(cfg).map(d => ({ ...d, last: enabled(cfg) ? store.lastRun(d.id) : null })),
    flapMinutes: cfg.hub?.flapMinutes ?? 10,
    publicUrl: cfg.hub?.publicUrl || '',
    types: sources.TYPES,
    eventTypes: EVENT_TYPES,
    sources: sources.list(cfg).map(s => ({ ...sources.publicSource(s), ...(stats[s.id] || { received: 0 }) })),
    rejected: { ...rejected },
  };
}

module.exports = { ingest, unsubscribe, take, tick, settingsOf, enabled, activity: store.recent };
