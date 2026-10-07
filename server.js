// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media Ops server. Serves the dashboard (/) and settings (/settings) pages, polls every
// configured app, and exposes the JSON API the pages use:
//
//   GET  /api/overview                     poll results + errors feed (cached a few seconds)
//   GET  /api/plex/thumb?p=…               Plex poster proxy (keeps the Plex token server-side)
//   POST /api/events/dismiss|restore       hide / unhide errors-feed entries
//   POST /api/events/services/:id/clear    clear an app's own log (needs login if a password is set)
//   POST /api/events/services/:id/recheck  re-run an app's health checks
//   *    /api/settings/…                   apps, general options, password, password reset
//   GET  /healthz                          liveness probe
//
// No dependencies beyond Node's standard library.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const collectors = require('./lib/collectors');
const { join, unixGet, clearCache } = require('./lib/http');
const config = require('./lib/config');
const { KINDS } = require('./lib/kinds');
const demo = require('./lib/demo');
const feed = require('./lib/events');
const actions = require('./lib/actions');
const recovery = require('./lib/recovery');
const geo = require('./lib/geo');
const history = require('./lib/history');
const notify = require('./lib/notify');
const diagnostics = require('./lib/diagnostics');
const digest = require('./lib/digest');
const gpu = require('./lib/gpu');
const space = require('./lib/space');
const selfupdate = require('./lib/selfupdate');
const pkg = require('./package.json');

const PUBLIC = path.join(__dirname, 'public');
const DEMO = ['1', 'truenas'].includes(process.env.DEMO); // DEMO=truenas: the demo server runs TrueNAS instead of Unraid
const PORT = Number(process.env.PORT) || 8484;

// ------------------------------------------------------------- host stats
let lastCpu = os.cpus();
// CPU % since the previous call. os.cpus() only gives cumulative tick counters, so
// we diff against the last sample.
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i]?.times || c.times;
    for (const k of Object.keys(c.times)) total += c.times[k] - prev[k];
    idle += c.times.idle - prev.idle;
  });
  lastCpu = now;
  return total ? Math.round((1 - idle / total) * 100) : null;
}

// Which NAS OS the container is running on, so Settings can suggest the matching app.
// Containers share the host's kernel, and both name it: "6.12.x-Unraid" and
// "6.12.x-production+truenas". Unraid's Docker manager also sets HOST_OS=Unraid.
function hostOs() {
  const hint = `${process.env.HOST_OS || ''} ${os.release()}`;
  return /unraid/i.test(hint) ? 'unraid' : /truenas/i.test(hint) ? 'truenas' : null;
}

// Stats for the machine this runs on. Inside a container, CPU, RAM, load and uptime are the
// host's (Linux doesn't virtualise them), but the hostname isn't, hence HOST_NAME.
function hostStats() {
  return {
    hostname: process.env.HOST_NAME || os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    os: hostOs(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim(),
    cpu: cpuPercent(),
    load: os.loadavg(),
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    uptime: os.uptime(),
    node: process.version,
  };
}

// Free/total space for the paths listed under Settings → Disks (as seen inside the container).
async function localDisks(paths = []) {
  const out = [];
  for (const p of paths) {
    try {
      const s = await fs.promises.statfs(p);
      out.push({ path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch { /* path not mounted / not visible */ }
  }
  return out;
}

// Container list from the Docker Engine API over its unix socket. Read-only: one GET.
async function dockerContainers(cfg) {
  if (!cfg?.socket) return null;
  if (!fs.existsSync(cfg.socket)) return null; // socket not mounted — just hide the panel
  try {
    const list = await unixGet(cfg.socket, '/containers/json?all=1');
    return list
      .map(c => ({
        name: (c.Names?.[0] || c.Id).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return { error: e.message };
  }
}

// ------------------------------------------------------------- overview
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
async function runService(s) {
  const base = { id: s.id, kind: s.kind, name: s.name, link: s.link || s.url };
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out')), 15000));
    const r = await Promise.race([collectors[s.kind](s), timeout]);
    return { ...base, up: true, ...r };
  } catch (e) {
    return { ...base, up: false, error: describeError(e) };
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
      Promise.all(services.map(runService)),
      dockerContainers(cfg.docker),
      localDisks(cfg.paths),
      gpu.read().catch(() => []),
    ]);
    await geo.enrich(results, cfg);
    const spaceInfo = space.build(results, cfg);
    space.stripPrivate(results);
    const value = {
      generatedAt: Date.now(), demo: false, refreshSeconds: cfg.refreshSeconds,
      configured: cfg.services.length > 0, host: hostStats(), services: results, docker, disks, gpus, space: spaceInfo,
    };
    if (gen === cache.gen) cache = { ...cache, at: Date.now(), value, pending: null };
    return value;
  })();
  cache.pending = p;
  p.finally(() => { if (cache.pending === p) cache.pending = null; });
  return p;
}

// Poll results + the unified errors feed with dismissals applied (cheap, so done per request).
async function overview() {
  const raw = DEMO ? demo.overview(hostStats()) : await polled();
  const { events, changed } = feed.apply(feed.collect(raw.services), raw.services, config.load().dismissed);
  if (changed) config.update(c => ({ ...c, dismissed: changed }));
  const services = raw.services.map(s => ({ ...s, actions: actions.capabilities(s.kind, s.name) }));
  const cfg = config.load();
  return { ...raw, services, events, uploadMbps: Number(cfg.uploadMbps) || null, version: pkg.version, latestVersion: DEMO ? null : selfupdate.latest(cfg) };
}

// ------------------------------------------------------------- background monitor
// Polls on its own schedule, even with no browser open, to record history and send
// notifications. Shares the poll cache with page requests, so apps aren't polled twice.
async function monitorTick() {
  const cfg = config.load();
  try {
    const raw = DEMO ? demo.overview(hostStats()) : await polled();
    const { events } = feed.apply(feed.collect(raw.services), raw.services, cfg.dismissed);
    history.record(raw);
    await notify.handle(raw, events, history.diskList(raw), cfg);
    await digest.maybeSend(cfg, { ...raw, latestVersion: DEMO ? null : selfupdate.latest(cfg) }, events, notify.sendDigest);
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

// ------------------------------------------------------------- dashboard actions: dismiss / clear / re-check
async function eventsApi(req, res, route) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  const body = await readJson(req);

  if (route === '/dismiss') {
    const { events } = await overview();
    config.update(c => ({ ...c, dismissed: feed.dismiss(c.dismissed, events, body) }));
    return send(res, 200, { ok: true });
  }
  if (route === '/restore') {
    config.update(c => ({ ...c, dismissed: feed.emptyState() }));
    return send(res, 200, { ok: true });
  }

  // /services/:id/(clear|recheck|stop|queue-retry|queue-remove|request-approve|request-decline)
  const m = /^\/services\/([\w-]+)\/(clear|recheck|stop|queue-retry|queue-remove|request-approve|request-decline)$/.exec(route);
  if (!m) return send(res, 404, { error: 'Not found' });
  const [, id, action] = m;
  // Anything that changes or deletes something inside an app is behind the settings password
  // when one is set. Re-check only reads, so it's open.
  if (action !== 'recheck' && !loggedIn(req)) return send(res, 401, { error: 'Log in under Settings to do this', needLogin: true });
  if (DEMO) return send(res, 200, { ok: true, message: 'Demo mode — nothing was changed' });
  const svc = config.load().services.find(s => s.id === id);
  if (!svc) return send(res, 404, { error: 'App not found' });
  try {
    const run = {
      clear: () => actions.clear(svc),
      recheck: () => actions.recheck(svc),
      stop: () => actions.stopStream(svc, body.sessionId, body.reason),
      'queue-retry': () => actions.queueRetry(svc),
      'queue-remove': () => actions.queueRemove(svc, body.queueId),
      'request-approve': () => actions.seerrRequest(svc, body.requestId, 'approve'),
      'request-decline': () => actions.seerrRequest(svc, body.requestId, 'decline'),
    }[action];
    const message = await run();
    invalidate(); // re-fetch logs/health right away
    return send(res, 200, { ok: true, message });
  } catch (e) {
    return send(res, e.status || 502, { error: describeError(e) });
  }
}

// ------------------------------------------------------------- Plex poster proxy (keeps token server-side)
async function plexThumb(res, p) {
  const plex = config.load().services.find(s => s.kind === 'plex' && s.enabled !== false);
  if (!plex || !/^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/.test(p || '')) return send(res, 404);
  const url = join(plex.url, `/photo/:/transcode?width=240&height=360&minSize=1&upscale=1&url=${encodeURIComponent(p)}`);
  try {
    const r = await fetch(url, { headers: { 'X-Plex-Token': plex.token }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    send(res, 502);
  }
}

// ------------------------------------------------------------- settings: sessions & guards
// Sessions are kept in memory: a restart signs everyone out of Settings, which is fine for an
// admin page and means no session secrets are ever written to disk.
const sessions = new Map(); // token -> expiry
const SESSION_DAYS = 30;

function cookie(req, name) {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
}
function loggedIn(req) {
  if (!config.load().auth) return true;
  const t = cookie(req, 'mo_session');
  const exp = t && sessions.get(t);
  return !!exp && exp > Date.now();
}
function startSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `mo_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

// Writes must come from this page (blocks other websites from silently changing your settings).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function readJson(req) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function settingsPayload(req) {
  const cfg = config.load();
  return {
    authEnabled: !!cfg.auth,
    dashboardAuth: !!cfg.dashboardAuth,
    version: pkg.version,
    loggedIn: loggedIn(req),
    demo: DEMO,
    configFile: config.FILE,
    general: {
      refreshSeconds: cfg.refreshSeconds, paths: cfg.paths, dockerSocket: cfg.docker?.socket || '',
      mapEnabled: cfg.map?.enabled !== false, mapHome: cfg.map?.home || '',
      uploadMbps: cfg.uploadMbps || '', cleanupDays: cfg.cleanupDays || 365, checkUpdates: cfg.checkUpdates !== false,
    },
    services: cfg.services.map(config.publicService),
    kinds: KINDS,
    hostOs: hostOs(),
    notifications: {
      diskThreshold: cfg.notifications?.diskThreshold ?? 90,
      quiet: { enabled: false, from: '23:00', to: '07:00', allowDown: true, ...(cfg.notifications?.quiet || {}) },
      digest: { enabled: false, time: '08:00', ...(cfg.notifications?.digest || {}) },
      targets: (cfg.notifications?.targets || []).map(t => ({ ...notify.publicTarget(t), last: notify.lastResult(t.id) })),
    },
    notifyTypes: notify.TYPES,
    notifyEvents: notify.EVENTS,
  };
}

// Routes under /api/settings. /login, /logout, /forgot and /reset work without a session;
// everything else needs one when a settings password is set.
async function settingsApi(req, res, route) {
  const method = req.method;

  if (route === '/login' && method === 'POST') {
    const { password } = await readJson(req);
    if (!config.checkPassword(password)) {
      await new Promise(r => setTimeout(r, 800)); // slow down guessing
      return send(res, 401, { error: 'Wrong password' });
    }
    startSession(res);
    return send(res, 200, { ok: true });
  }
  if (route === '/forgot' && method === 'POST') {
    const r = recovery.request();
    return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, file: r.file } : { error: r.error });
  }
  if (route === '/reset' && method === 'POST') {
    const { code, next } = await readJson(req);
    if (next && String(next).length < 8) return send(res, 400, { error: 'Use at least 8 characters, or leave it blank to remove the password' });
    const err = recovery.verify(code);
    if (err) {
      await new Promise(r => setTimeout(r, 800));
      return send(res, 400, { error: err });
    }
    config.update(c => ({ ...c, auth: next ? config.hashPassword(String(next)) : null }));
    sessions.clear(); // sign out everywhere else
    if (next) startSession(res);
    console.log(`Settings password ${next ? 'reset' : 'removed'} using a reset code.`);
    return send(res, 200, { ok: true, authEnabled: !!next });
  }
  if (route === '/logout' && method === 'POST') {
    sessions.delete(cookie(req, 'mo_session'));
    res.setHeader('Set-Cookie', 'mo_session=; Max-Age=0; Path=/');
    return send(res, 200, { ok: true });
  }

  if (!loggedIn(req)) return send(res, 401, { error: 'Log in to change settings', needLogin: true });
  if (method === 'GET' && route === '') return send(res, 200, settingsPayload(req));

  const svcMatch = /^\/services\/([\w-]+)$/.exec(route);

  if (method === 'POST' && route === '/test') {
    const input = await readJson(req);
    const existing = config.load().services.find(s => s.id === input.id);
    let svc;
    try { svc = config.mergeService(existing, input); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    const r = await runService(svc);
    return send(res, 200, r.up
      ? { ok: true, version: r.version, latency: r.latency, note: r.data?.note || null }
      : { ok: false, error: r.error });
  }

  if (method === 'POST' && route === '/services') {
    const input = await readJson(req);
    let svc;
    try { svc = config.mergeService(null, input); } catch (e) { return send(res, 400, { error: e.message }); }
    config.update(c => ({ ...c, services: [...c.services, svc] }));
    invalidate();
    return send(res, 201, config.publicService(svc));
  }

  if (svcMatch && method === 'PUT') {
    const input = await readJson(req);
    const id = svcMatch[1];
    const existing = config.load().services.find(s => s.id === id);
    if (!existing) return send(res, 404, { error: 'Not found' });
    let svc;
    try { svc = config.mergeService(existing, { ...input, kind: existing.kind }); } catch (e) { return send(res, 400, { error: e.message }); }
    config.update(c => ({ ...c, services: c.services.map(s => (s.id === id ? svc : s)) }));
    invalidate();
    return send(res, 200, config.publicService(svc));
  }

  if (svcMatch && method === 'DELETE') {
    config.update(c => ({ ...c, services: c.services.filter(s => s.id !== svcMatch[1]) }));
    invalidate();
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && route === '/diagnostics') {
    return send(res, 200, await diagnostics.run(config.load().services, runService));
  }

  // Notification destinations
  const nMatch = /^\/notifications\/([\w-]+)$/.exec(route);
  const targets = () => config.load().notifications?.targets || [];
  const saveTargets = fn => config.update(c => ({ ...c, notifications: { ...(c.notifications || {}), targets: fn(c.notifications?.targets || []) } }));
  if (method === 'POST' && route === '/notifications/test') {
    const input = await readJson(req);
    try {
      const t = notify.mergeTarget(targets().find(x => x.id === input.id), input);
      await notify.test(t);
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 200, { ok: false, error: describeError(e) });
    }
  }
  if (method === 'POST' && route === '/notifications') {
    let t;
    try { t = notify.mergeTarget(null, await readJson(req)); } catch (e) { return send(res, 400, { error: e.message }); }
    saveTargets(list => [...list, t]);
    return send(res, 201, notify.publicTarget(t));
  }
  if (nMatch && method === 'PUT') {
    const existing = targets().find(x => x.id === nMatch[1]);
    if (!existing) return send(res, 404, { error: 'Not found' });
    let t;
    try { t = notify.mergeTarget(existing, await readJson(req)); } catch (e) { return send(res, 400, { error: e.message }); }
    saveTargets(list => list.map(x => (x.id === t.id ? t : x)));
    return send(res, 200, notify.publicTarget(t));
  }
  if (nMatch && method === 'DELETE') {
    saveTargets(list => list.filter(x => x.id !== nMatch[1]));
    return send(res, 200, { ok: true });
  }
  if (method === 'PUT' && route === '/notification-options') {
    const { diskThreshold, quiet = {}, digest: dg = {} } = await readJson(req);
    const n = Math.round(Number(diskThreshold));
    if (!(n >= 50 && n <= 99)) return send(res, 400, { error: 'Disk threshold must be between 50 and 99%' });
    const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
    if (quiet.enabled && !(hhmm(quiet.from) && hhmm(quiet.to))) return send(res, 400, { error: 'Quiet hours need a start and end time' });
    if (dg.enabled && !hhmm(dg.time)) return send(res, 400, { error: 'Pick a time for the daily digest' });
    config.update(c => ({
      ...c,
      notifications: {
        ...(c.notifications || {}), diskThreshold: n,
        quiet: { enabled: !!quiet.enabled, from: quiet.from || '23:00', to: quiet.to || '07:00', allowDown: quiet.allowDown !== false },
        digest: { enabled: !!dg.enabled, time: dg.time || '08:00' },
      },
    }));
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && route === '/digest-test') {
    const raw = DEMO ? demo.overview(hostStats()) : await polled();
    const { events } = feed.apply(feed.collect(raw.services), raw.services, config.load().dismissed);
    const preview = digest.build(raw, events);
    const sent = await notify.sendDigest(config.load(), preview);
    return send(res, 200, { ok: true, sent, preview });
  }

  // Backup / restore: the whole config, secrets included, as one JSON file.
  if (method === 'GET' && route === '/backup') {
    const body = JSON.stringify({ app: 'media-ops', version: pkg.version, exportedAt: new Date().toISOString(), config: config.load() }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="media-ops-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }
  if (method === 'POST' && route === '/restore') {
    const b = await readJson(req);
    const incoming = b?.app === 'media-ops' ? b.config : b;
    if (!incoming || !Array.isArray(incoming.services)) return send(res, 400, { error: "That doesn't look like a Media Ops backup" });
    const bad = incoming.services.find(x => !collectors[x.kind]);
    if (bad) return send(res, 400, { error: `Unknown app type "${bad.kind}" in the backup` });
    // Keep the current password if the backup has none, so a restore can't silently unlock Settings.
    config.update(c => ({ ...incoming, auth: incoming.auth || c.auth }));
    invalidate();
    return send(res, 200, { ok: true, apps: incoming.services.length });
  }
  if (method === 'PUT' && route === '/security') {
    const { dashboardAuth } = await readJson(req);
    if (dashboardAuth && !config.load().auth) return send(res, 400, { error: 'Set a settings password first' });
    config.update(c => ({ ...c, dashboardAuth: !!dashboardAuth }));
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/order') {
    const { ids } = await readJson(req);
    config.update(c => {
      const pos = new Map((ids || []).map((id, i) => [id, i]));
      return { ...c, services: [...c.services].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)) };
    });
    invalidate();
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/general') {
    const g = await readJson(req);
    const refresh = Math.round(Number(g.refreshSeconds));
    if (!(refresh >= 3 && refresh <= 300)) return send(res, 400, { error: 'Refresh must be between 3 and 300 seconds' });
    const paths = (Array.isArray(g.paths) ? g.paths : String(g.paths || '').split(/[\n,]/))
      .map(p => String(p).trim()).filter(Boolean);
    if (paths.some(p => !p.startsWith('/'))) return send(res, 400, { error: 'Disk paths must be absolute, like /mnt/user' });
    const mapHome = String(g.mapHome || '').trim();
    if (mapHome && !geo.parseLatLon(mapHome)) return send(res, 400, { error: 'Home location must look like "41.88, -87.63" (latitude, longitude)' });
    const upload = g.uploadMbps === '' || g.uploadMbps == null ? null : Number(g.uploadMbps);
    if (upload != null && !(upload > 0 && upload < 100000)) return send(res, 400, { error: 'Upload speed should be in Mbps, e.g. 40' });
    const cleanupDays = Math.round(Number(g.cleanupDays || 365));
    if (!(cleanupDays >= 30 && cleanupDays <= 3650)) return send(res, 400, { error: 'Cleanup period should be between 30 and 3650 days' });
    config.update(c => ({
      ...c, refreshSeconds: refresh, paths, docker: { socket: String(g.dockerSocket || '').trim() },
      map: { enabled: g.mapEnabled !== false, home: mapHome },
      uploadMbps: upload, cleanupDays, checkUpdates: g.checkUpdates !== false,
    }));
    invalidate();
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/password') {
    const { current, next } = await readJson(req);
    const cfg = config.load();
    if (cfg.auth && !config.checkPassword(current)) return send(res, 401, { error: 'Current password is wrong' });
    if (next && String(next).length < 8) return send(res, 400, { error: 'Use at least 8 characters' });
    config.update(c => ({ ...c, auth: next ? config.hashPassword(String(next)) : null, dashboardAuth: next ? c.dashboardAuth : false }));
    sessions.clear();
    if (next) startSession(res);
    return send(res, 200, { ok: true, authEnabled: !!next });
  }

  return send(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/': '/index.html', '/settings': '/settings.html' };

// With "require login for the dashboard" on, only the login page (Settings) and what it needs
// are reachable without a session.
const ALWAYS_OPEN = new Set(['/healthz', '/settings', '/settings.html', '/settings.js', '/style.css', '/manifest.webmanifest', '/icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
function dashboardLocked(req, pathname) {
  const cfg = config.load();
  if (!cfg.dashboardAuth || !cfg.auth || ALWAYS_OPEN.has(pathname) || pathname.startsWith('/api/settings')) return false;
  return !loggedIn(req);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (dashboardLocked(req, url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Log in to view the dashboard', needLogin: true });
      res.writeHead(302, { Location: `/settings?next=${encodeURIComponent(url.pathname + url.search)}` });
      return res.end();
    }
    if (url.pathname === '/api/overview') return send(res, 200, await overview());
    if (url.pathname === '/api/history') return send(res, 200, historyPayload());
    if (url.pathname === '/api/plex/thumb') return plexThumb(res, url.searchParams.get('p'));
    if (url.pathname === '/healthz') return res.writeHead(200).end('ok');
    if (url.pathname.startsWith('/api/events/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
      return await eventsApi(req, res, url.pathname.slice('/api/events'.length));
    }
    if (url.pathname === '/api/settings' || url.pathname.startsWith('/api/settings/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
      return await settingsApi(req, res, url.pathname.slice('/api/settings'.length));
    }

    const file = path.join(PUBLIC, path.normalize(PAGES[url.pathname] || url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403);
    const data = await fs.promises.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return res.writeHead(404).end('Not found');
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

history.load();
setInterval(history.save, 5 * 60e3).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { history.save(); process.exit(0); });
setTimeout(monitorTick, 2000).unref();

server.listen(PORT, () => {
  const cfg = config.load();
  console.log(`Media Ops on http://localhost:${PORT}  (settings: http://localhost:${PORT}/settings)`);
  console.log(`Config file: ${config.FILE}`);
  if (DEMO) console.log('DEMO=1 — the dashboard shows fake data.');
  else if (!cfg.services.length) console.log('No apps connected yet — open /settings to add them.');
  else console.log(`Watching ${cfg.services.length} apps: ${cfg.services.map(s => s.name).join(', ')}`);
});
