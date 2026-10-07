// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Polling every app: one collector run per app with a time cap, a short shared cache so every
// open tab reuses the same poll, the overview the dashboard shows, and the background monitor
// that records history and sends notifications even with no browser open.
'use strict';
const collectors = require('./collectors');
const { clearCache } = require('./http');
const config = require('./config');
const demo = require('./demo');
const feed = require('./events');
const actions = require('./actions');
const geo = require('./geo');
const history = require('./history');
const notify = require('./notify');
const digest = require('./digest');
const gpu = require('./gpu');
const space = require('./space');
const selfupdate = require('./selfupdate');
const { hostStats, localDisks, dockerContainers } = require('./host');
const pkg = require('../package.json');

const DEMO = ['1', 'truenas'].includes(process.env.DEMO); // DEMO=truenas: the demo server runs TrueNAS instead of Unraid

function describeError(e) {
  // Node's fetch wraps the socket error, sometimes as an AggregateError (IPv4 + IPv6 attempts).
  const code = e.cause?.code || e.cause?.errors?.[0]?.code;
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  if (/HTTP 401|HTTP 403/.test(e.message)) return `${e.message} — check the API key`;
  if (e.name === 'TimeoutError') return 'Timed out';
  return code || (e.message === 'fetch failed' && e.cause?.message) || e.message;
}

// Run one collector with a hard 15 s cap. Never throws: a failure becomes { up: false, error }.
async function runService(s, limitMs = 15000) {
  const base = { id: s.id, kind: s.kind, name: s.name, link: s.link || s.url };
  let timer;
  try {
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('Timed out')), limitMs);
    });
    const r = await Promise.race([collectors[s.kind](s), timeout]);
    return { ...base, up: true, ...r };
  } catch (e) {
    return { ...base, up: false, error: describeError(e) };
  } finally {
    clearTimeout(timer); // otherwise one stray timer per app per poll
  }
}

// Poll cache. Every open tab hits /api/overview, so results are reused for 4 s and concurrent
// callers share one in-flight poll. `gen` bumps when settings change, so a poll that started
// with the old settings isn't cached.
let cache = { at: 0, value: null, pending: null, gen: 0 };
function invalidate() {
  cache = { at: 0, value: null, pending: null, gen: cache.gen + 1 };
  clearCache();
}

async function polled() {
  const cfg = config.load();
  if (cache.value && Date.now() - cache.at < 4000) return cache.value;
  if (cache.pending) return cache.pending;
  const gen = cache.gen;
  const p = (async () => {
    const services = cfg.services.filter(s => s.enabled !== false && collectors[s.kind]);
    const [results, docker, disks, gpus] = await Promise.all([
      Promise.all(services.map(s => runService(s))),
      dockerContainers(cfg.docker),
      localDisks(cfg.paths),
      gpu.read().catch(() => []),
    ]);
    await geo.enrich(results, cfg);
    const spaceInfo = space.build(results, cfg);
    space.stripPrivate(results);
    const value = {
      generatedAt: Date.now(),
      demo: false,
      refreshSeconds: cfg.refreshSeconds,
      configured: cfg.services.length > 0,
      host: hostStats(),
      services: results,
      docker,
      disks,
      gpus,
      space: spaceInfo,
    };
    if (gen === cache.gen) cache = { ...cache, at: Date.now(), value, pending: null };
    return value;
  })();
  cache.pending = p;
  p.finally(() => {
    if (cache.pending === p) cache.pending = null;
  });
  return p;
}

// Every open tab asks for the overview, but the poll result only changes every few seconds:
// build the errors feed (hashes, hints) once per poll result and reuse it.
const collected = new WeakMap();
function eventsOf(raw) {
  if (!collected.has(raw.services)) collected.set(raw.services, feed.collect(raw.services));
  return collected.get(raw.services).map(e => ({ ...e })); // apply() marks dismissals on its own copy
}

// Poll results + the unified errors feed with dismissals applied.
async function overview() {
  const raw = DEMO ? demo.overview(hostStats()) : await polled();
  const cfg = config.load();
  const { events, changed } = feed.apply(eventsOf(raw), raw.services, cfg.dismissed);
  if (changed) config.update(c => ({ ...c, dismissed: changed }));
  const services = raw.services.map(s => ({ ...s, actions: actions.capabilities(s.kind, s.name) }));
  return {
    ...raw,
    services,
    events,
    uploadMbps: Number(cfg.uploadMbps) || null,
    version: pkg.version,
    latestVersion: DEMO ? null : selfupdate.latest(cfg),
    settingsLocked: !!cfg.auth,
  };
}

// ------------------------------------------------------------- background monitor
// Polls on its own schedule, even with no browser open, to record history and send
// notifications. Shares the poll cache with page requests, so apps aren't polled twice.
async function monitorTick() {
  const cfg = config.load();
  try {
    const raw = DEMO ? demo.overview(hostStats()) : await polled();
    const { events } = feed.apply(eventsOf(raw), raw.services, cfg.dismissed);
    history.record(raw);
    await notify.handle(raw, events, history.diskList(raw), cfg);
    await digest.maybeSend(
      cfg,
      { ...raw, latestVersion: DEMO ? null : selfupdate.latest(cfg) },
      events,
      notify.sendDigest,
    );
  } catch (e) {
    console.error(`Monitor: ${e.message}`);
  }
  setTimeout(monitorTick, Math.max(10, cfg.refreshSeconds || 10) * 1000).unref();
}

function historyPayload() {
  if (DEMO) return demo.history();
  const ids = config.load().services.map(s => s.id);
  return {
    uptime: Object.fromEntries(ids.map(id => [id, history.uptime(id)])),
    trends: history.trends(),
    forecasts: Object.fromEntries(history.diskPaths().map(p => [p, history.forecast(p)])),
  };
}

module.exports = {
  DEMO,
  describeError,
  runService,
  invalidate,
  polled,
  eventsOf,
  overview,
  monitorTick,
  historyPayload,
};
