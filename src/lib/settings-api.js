// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Everything under /api/settings: login and password reset, apps, notification destinations,
// general options, backup and restore, diagnostics.
'use strict';
const crypto = require('node:crypto');
const collectors = require('./collectors');
const config = require('./config');
const { KINDS } = require('./kinds');
const demo = require('./demo');
const feed = require('./events');
const recovery = require('./recovery');
const geo = require('./geo');
const notify = require('./notify');
const status = require('./status');
const layout = require('./layout');
const autofix = require('./autofix');
const appearance = require('./appearance');
const metrics = require('./metrics');
const diagnostics = require('./diagnostics');
const digest = require('./digest');
const pins = require('./pins');
const { platform } = require('./platform');
const { hostOs, hostStats, loopbackNote, listContainers } = require('./host');
const discover = require('./discover');
const { sessions, cookie, loggedIn, startSession, lockedOut, noteFailure } = require('./auth');
const { readJson, send } = require('./web');
const { DEMO, describeError, runService, invalidate, polled } = require('./poll');
const pkg = require('../package.json');

/** @typedef {import('node:http').IncomingMessage} Req @typedef {import('node:http').ServerResponse} Res */

/** @param {Req} req */
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
      refreshSeconds: cfg.refreshSeconds,
      paths: cfg.paths,
      dockerSocket: cfg.docker?.socket || '',
      mapEnabled: cfg.map?.enabled !== false,
      mapHome: cfg.map?.home || '',
      uploadMbps: cfg.uploadMbps || '',
      cleanupDays: cfg.cleanupDays || 365,
      checkUpdates: cfg.checkUpdates !== false,
    },
    services: cfg.services.map(config.publicService),
    kinds: KINDS,
    hostOs: hostOs(),
    platform: platform(),
    notifications: {
      diskThreshold: cfg.notifications?.diskThreshold ?? 90,
      quiet: { enabled: false, from: '23:00', to: '07:00', allowDown: true, ...(cfg.notifications?.quiet || {}) },
      digest: { enabled: false, time: '08:00', ...(cfg.notifications?.digest || {}) },
      targets: (cfg.notifications?.targets || []).map(t => ({
        ...notify.publicTarget(t),
        last: notify.lastResult(t.id),
      })),
    },
    notifyTypes: notify.TYPES,
    notifyEvents: notify.EVENTS,
    statusPage: status.settingsOf(cfg),
    layout: layout.clean(cfg.layout),
    layoutBlocks: layout.BLOCKS,
    autoFix: { ...autofix.settingsOf(cfg), recent: autofix.recent() },
    appearance: appearance.settingsOf(cfg),
    accents: appearance.ACCENTS,
    metrics: metrics.settingsOf(cfg),
  };
}

/** @param {unknown} v */
const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const newId = (/** @type {unknown} */ id) => (/^[\w-]{1,64}$/.test(String(id)) ? String(id) : crypto.randomUUID());

// A wrong password or reset code: count it toward the lockout and slow the next guess down.
/** @param {Req} req */
async function wrongAnswer(req) {
  noteFailure(req);
  await new Promise(r => setTimeout(r, 800));
}

// ---------------------------------------------------------------- login and password
/** @param {Req} req @param {Res} res */
async function login(req, res) {
  const { password } = await readJson(req);
  if (!(await config.checkPassword(password))) {
    await wrongAnswer(req);
    return send(res, 401, { error: 'Wrong password' });
  }
  startSession(req, res);
  return send(res, 200, { ok: true });
}

/** @param {Req} req @param {Res} res */
function forgot(req, res) {
  const r = recovery.request();
  return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, file: r.file } : { error: r.error });
}

/** @param {Req} req @param {Res} res */
async function reset(req, res) {
  const { code, next } = await readJson(req);
  if (next && String(next).length < 8)
    return send(res, 400, { error: 'Use at least 8 characters, or leave it blank to remove the password' });
  const err = recovery.verify(code);
  if (err) {
    await wrongAnswer(req);
    return send(res, 400, { error: err });
  }
  config.update(c => ({ ...c, auth: next ? config.hashPassword(String(next)) : null }));
  sessions.clear(); // sign out everywhere else
  if (next) startSession(req, res);
  console.log(`Settings password ${next ? 'reset' : 'removed'} using a reset code.`);
  return send(res, 200, { ok: true, authEnabled: !!next });
}

/** @param {Req} req @param {Res} res */
function logout(req, res) {
  sessions.delete(cookie(req, 'mo_session'));
  res.setHeader('Set-Cookie', 'mo_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
  return send(res, 200, { ok: true });
}

/** @param {Req} req @param {Res} res */
async function changePassword(req, res) {
  const { current, next } = await readJson(req);
  const cfg = config.load();
  if (cfg.auth && !(await config.checkPassword(current))) {
    await wrongAnswer(req);
    return send(res, 401, { error: 'Current password is wrong' });
  }
  if (next && String(next).length < 8) return send(res, 400, { error: 'Use at least 8 characters' });
  config.update(c => ({
    ...c,
    auth: next ? config.hashPassword(String(next)) : null,
    dashboardAuth: next ? c.dashboardAuth : false,
  }));
  sessions.clear();
  if (next) startSession(req, res);
  return send(res, 200, { ok: true, authEnabled: !!next });
}

/** @param {Req} req @param {Res} res */
async function saveSecurity(req, res) {
  const { dashboardAuth } = await readJson(req);
  if (dashboardAuth && !config.load().auth) return send(res, 400, { error: 'Set a settings password first' });
  config.update(c => ({ ...c, dashboardAuth: !!dashboardAuth }));
  return send(res, 200, { ok: true });
}

// ---------------------------------------------------------------- apps
/** @param {Req} req @param {Res} res */
async function testService(req, res) {
  const input = await readJson(req);
  const existing = config.load().services.find(s => s.id === input.id);
  let svc;
  try {
    svc = config.mergeService(existing, input);
  } catch (e) {
    return send(res, 200, { ok: false, error: e.message });
  }
  if (svc.kind === 'truenas') pins.forget(svc.url); // testing from Settings trusts its current certificate
  const r = await runService(svc);
  const note = loopbackNote(svc.url);
  return send(
    res,
    200,
    r.up
      ? { ok: true, version: r.version, latency: r.latency, note: r.data?.note || null }
      : { ok: false, error: note ? `${String(r.error).replace(/[.\s]*$/, '.')}${note}` : r.error },
  );
}

/** @param {Req} req @param {Res} res */
async function addService(req, res) {
  const input = await readJson(req);
  let svc;
  try {
    svc = config.mergeService(null, input);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  if (svc.kind === 'truenas') pins.forget(svc.url);
  config.update(c => ({ ...c, services: [...c.services, svc] }));
  invalidate();
  return send(res, 201, config.publicService(svc));
}

/** @param {Req} req @param {Res} res @param {{ id: string }} params */
async function updateService(req, res, { id }) {
  const input = await readJson(req);
  const existing = config.load().services.find(s => s.id === id);
  if (!existing) return send(res, 404, { error: 'Not found' });
  let svc;
  try {
    svc = config.mergeService(existing, { ...input, kind: existing.kind });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  if (svc.kind === 'truenas') pins.forget(svc.url);
  config.update(c => ({ ...c, services: c.services.map(s => (s.id === id ? svc : s)) }));
  invalidate();
  return send(res, 200, config.publicService(svc));
}

/** @param {Req} req @param {Res} res @param {{ id: string }} params */
function deleteService(req, res, { id }) {
  config.update(c => ({ ...c, services: c.services.filter(s => s.id !== id) }));
  invalidate();
  return send(res, 200, { ok: true });
}

/** @param {Req} req @param {Res} res */
async function reorderServices(req, res) {
  const { ids } = await readJson(req);
  config.update(c => {
    const pos = new Map(/** @type {string[]} */ (ids || []).map((id, i) => [id, i]));
    return { ...c, services: [...c.services].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)) };
  });
  invalidate();
  return send(res, 200, { ok: true });
}

/** @param {Req} req @param {Res} res */
async function runDiagnostics(req, res) {
  // Diagnostics skips every cache, so allow up to a minute per app.
  return send(res, 200, await diagnostics.run(config.load().services, s => runService(s, 60000)));
}

// ---------------------------------------------------------------- notifications
const targets = () => config.load().notifications?.targets || [];
/** @param {(list: import('./types').Target[]) => import('./types').Target[]} fn */
const saveTargets = fn =>
  config.update(c => ({
    ...c,
    notifications: { ...(c.notifications || {}), targets: fn(c.notifications?.targets || []) },
  }));

/** @param {Req} req @param {Res} res */
async function testTarget(req, res) {
  const input = await readJson(req);
  try {
    const t = notify.mergeTarget(
      targets().find(x => x.id === input.id),
      input,
    );
    await notify.test(t);
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, 200, { ok: false, error: describeError(e) });
  }
}

/** @param {Req} req @param {Res} res */
async function addTarget(req, res) {
  let t;
  try {
    t = notify.mergeTarget(null, await readJson(req));
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  saveTargets(list => [...list, t]);
  return send(res, 201, notify.publicTarget(t));
}

/** @param {Req} req @param {Res} res @param {{ id: string }} params */
async function updateTarget(req, res, { id }) {
  const existing = targets().find(x => x.id === id);
  if (!existing) return send(res, 404, { error: 'Not found' });
  let t;
  try {
    t = notify.mergeTarget(existing, await readJson(req));
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  saveTargets(list => list.map(x => (x.id === t.id ? t : x)));
  return send(res, 200, notify.publicTarget(t));
}

/** @param {Req} req @param {Res} res @param {{ id: string }} params */
function deleteTarget(req, res, { id }) {
  saveTargets(list => list.filter(x => x.id !== id));
  return send(res, 200, { ok: true });
}

/** @param {Req} req @param {Res} res */
async function saveNotificationOptions(req, res) {
  const { diskThreshold, quiet = {}, digest: dg = {} } = await readJson(req);
  const n = Math.round(Number(diskThreshold));
  if (!(n >= 50 && n <= 99)) return send(res, 400, { error: 'Disk threshold must be between 50 and 99%' });
  if (quiet.enabled && !(hhmm(quiet.from) && hhmm(quiet.to)))
    return send(res, 400, { error: 'Quiet hours need a start and end time' });
  if (dg.enabled && !hhmm(dg.time)) return send(res, 400, { error: 'Pick a time for the daily digest' });
  config.update(c => ({
    ...c,
    notifications: {
      ...(c.notifications || {}),
      diskThreshold: n,
      quiet: {
        enabled: !!quiet.enabled,
        from: quiet.from || '23:00',
        to: quiet.to || '07:00',
        allowDown: quiet.allowDown !== false,
      },
      digest: { enabled: !!dg.enabled, time: dg.time || '08:00' },
    },
  }));
  return send(res, 200, { ok: true });
}

/** @param {Req} req @param {Res} res */
async function sendTestDigest(req, res) {
  const raw = DEMO ? demo.overview(hostStats()) : await polled();
  const { events } = feed.apply(feed.collect(raw.services), raw.services, config.load().dismissed);
  const preview = digest.build(raw, events);
  const sent = await notify.sendDigest(config.load(), preview);
  return send(res, 200, { ok: true, sent, preview });
}

// ---------------------------------------------------------------- general options
/** @param {Req} req @param {Res} res */
async function saveGeneral(req, res) {
  const g = await readJson(req);
  const refresh = Math.round(Number(g.refreshSeconds));
  if (!(refresh >= 3 && refresh <= 300)) return send(res, 400, { error: 'Refresh must be between 3 and 300 seconds' });
  const paths = /** @type {unknown[]} */ (Array.isArray(g.paths) ? g.paths : String(g.paths || '').split(/[\n,]/))
    .map(p => String(p).trim())
    .filter(Boolean);
  if (paths.some(p => !p.startsWith('/')))
    return send(res, 400, { error: 'Disk paths must be absolute, like /mnt/user' });
  const docker = String(g.dockerSocket || '').trim();
  if (docker && !docker.startsWith('/') && !/^https?:\/\/[^\s]+$/i.test(docker))
    return send(res, 400, {
      error:
        'Docker needs a socket path like /var/run/docker.sock, or a socket proxy address like http://socket-proxy:2375',
    });
  const mapHome = String(g.mapHome || '').trim();
  if (mapHome && !geo.parseLatLon(mapHome))
    return send(res, 400, { error: 'Home location must look like "41.88, -87.63" (latitude, longitude)' });
  const upload = g.uploadMbps === '' || g.uploadMbps == null ? null : Number(g.uploadMbps);
  if (upload != null && !(upload > 0 && upload < 100000))
    return send(res, 400, { error: 'Upload speed should be in Mbps, e.g. 40' });
  const cleanupDays = Math.round(Number(g.cleanupDays || 365));
  if (!(cleanupDays >= 30 && cleanupDays <= 3650))
    return send(res, 400, { error: 'Cleanup period should be between 30 and 3650 days' });
  config.update(c => ({
    ...c,
    refreshSeconds: refresh,
    paths,
    docker: { socket: docker },
    map: { enabled: g.mapEnabled !== false, home: mapHome },
    uploadMbps: upload,
    cleanupDays,
    checkUpdates: g.checkUpdates !== false,
  }));
  invalidate();
  return send(res, 200, { ok: true });
}

// ---------------------------------------------------------------- dashboard layout
/** @param {Req} req @param {Res} res */
async function saveLayout(req, res) {
  const next = layout.clean(await readJson(req));
  config.update(c => ({ ...c, layout: next }));
  return send(res, 200, { ok: true, layout: next });
}

// ---------------------------------------------------------------- Prometheus metrics
// Turning it on the first time creates the token; it's only ever sent back here, once.
/** @param {Req} req @param {Res} res */
async function saveMetrics(req, res) {
  const enabled = !!(await readJson(req)).enabled;
  /** @type {string | null} */
  let token = null;
  config.update(c => {
    const keep = c.metrics?.token;
    if (enabled && !keep) token = metrics.newToken();
    return { ...c, metrics: { enabled, token: keep || token } };
  });
  return send(res, 200, { ok: true, metrics: metrics.settingsOf(config.load()), token });
}
/** @param {Req} req @param {Res} res */
function newMetricsToken(req, res) {
  const token = metrics.newToken();
  config.update(c => ({ ...c, metrics: { enabled: !!c.metrics?.enabled, token } }));
  return send(res, 200, { ok: true, metrics: metrics.settingsOf(config.load()), token });
}

// ---------------------------------------------------------------- appearance
/** @param {Req} req @param {Res} res */
async function saveAppearance(req, res) {
  let next;
  try {
    next = appearance.clean(await readJson(req), config.load().appearance);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  config.update(c => ({ ...c, appearance: next }));
  return send(res, 200, { ok: true, appearance: appearance.settingsOf({ appearance: next }) });
}
/** @param {Req} req @param {Res} res */
async function uploadLogo(req, res) {
  let logo;
  try {
    // Base64 makes the 256 KB limit about 342 KB on the wire.
    logo = appearance.logoFrom((await readJson(req, 400 * 1024))?.data);
  } catch (e) {
    return send(res, e.status || 400, { error: e.status === 413 ? 'The logo must be 256 KB or smaller' : e.message });
  }
  config.update(c => ({ ...c, appearance: { ...appearance.clean(c.appearance, null), logo } }));
  return send(res, 200, { ok: true, appearance: appearance.settingsOf(config.load()) });
}
/** @param {Req} req @param {Res} res */
function removeLogo(req, res) {
  config.update(c => ({ ...c, appearance: appearance.clean(c.appearance, null) }));
  return send(res, 200, { ok: true, appearance: appearance.settingsOf(config.load()) });
}
// A backup's appearance, through the same checks as the form and the upload.
/** @param {any} input */
function safeAppearance(input) {
  try {
    const out = appearance.clean(input, null);
    if (input.logo?.data) out.logo = appearance.logoFrom(input.logo.data);
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stuck downloads
/** @param {Req} req @param {Res} res */
async function saveAutoFix(req, res) {
  const next = autofix.clean(await readJson(req));
  config.update(c => ({ ...c, autoFix: next }));
  return send(res, 200, { ok: true, autoFix: { ...next, recent: autofix.recent() } });
}

// ---------------------------------------------------------------- apps found in Docker
/** @param {Req} req @param {Res} res */
async function discoverApps(req, res) {
  if (DEMO) return send(res, 200, { docker: false, apps: [] });
  try {
    const list = await listContainers(config.load().docker);
    if (!list) return send(res, 200, { docker: false, apps: [] });
    return send(res, 200, { docker: true, apps: discover.findApps(list) });
  } catch (e) {
    return send(res, 200, { docker: true, apps: [], error: describeError(e) });
  }
}

// ---------------------------------------------------------------- public status page
/** @param {Req} req @param {Res} res */
async function saveStatusPage(req, res) {
  let statusPage;
  try {
    statusPage = status.clean(await readJson(req), config.load().services);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  config.update(c => ({ ...c, statusPage }));
  return send(res, 200, { ok: true, statusPage });
}

// ---------------------------------------------------------------- backup and restore
// The whole config, secrets included, as one JSON file.
/** @param {Req} req @param {Res} res */
function backup(req, res) {
  // The file holds every API key. Without a password, anyone on the network could fetch it.
  if (!config.load().auth)
    return send(res, 403, { error: 'Set a settings password first: backups contain all your API keys.' });
  const body = JSON.stringify(
    { app: 'media-ops', version: pkg.version, exportedAt: new Date().toISOString(), config: config.load() },
    null,
    2,
  );
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="media-ops-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    'Cache-Control': 'no-store',
  });
  return res.end(body);
}

// A backup's status page settings, through the same checks as the form (bad ones are dropped).
/** @param {any} input @param {import('./types').Service[]} services */
function safeStatusPage(input, services) {
  try {
    return status.clean(input, services);
  } catch {
    return null;
  }
}

/** @param {Req} req @param {Res} res */
async function restore(req, res) {
  const b = await readJson(req, 2 * 1024 * 1024);
  const incoming = b?.app === 'media-ops' ? b.config : b;
  if (!incoming || !Array.isArray(incoming.services))
    return send(res, 400, { error: "That doesn't look like a Media Ops backup" });
  // Every app and destination goes through the same checks as the Settings forms, and only
  // known settings are taken, so a crafted file can't smuggle in anything the forms refuse.
  let services, restoredTargets;
  try {
    services = /** @type {any[]} */ (incoming.services).map(x => {
      if (!collectors[x.kind]) throw new Error(`Unknown app type "${x.kind}" in the backup`);
      return { ...config.mergeService(null, x), id: newId(x.id) };
    });
    restoredTargets = /** @type {any[]} */ (incoming.notifications?.targets || []).map(t => ({
      ...notify.mergeTarget(null, t),
      id: newId(t.id),
    }));
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const auth =
    incoming.auth && /^[0-9a-f]{32}$/.test(incoming.auth.salt) && /^[0-9a-f]{128}$/.test(incoming.auth.hash)
      ? { salt: incoming.auth.salt, hash: incoming.auth.hash }
      : null;
  const n = incoming.notifications || {};
  config.update(c => ({
    ...c,
    services,
    // Keep the current password if the backup has none, so a restore can't silently unlock Settings.
    auth: auth || c.auth,
    refreshSeconds: Math.min(300, Math.max(3, Math.round(Number(incoming.refreshSeconds)) || c.refreshSeconds)),
    paths: Array.isArray(incoming.paths)
      ? /** @type {unknown[]} */ (incoming.paths).map(String).filter(p => p.startsWith('/'))
      : c.paths,
    map: {
      enabled: incoming.map?.enabled !== false,
      home: geo.parseLatLon(incoming.map?.home || '') ? String(incoming.map.home) : '',
    },
    uploadMbps: Number(incoming.uploadMbps) > 0 ? Number(incoming.uploadMbps) : null,
    cleanupDays: Math.min(3650, Math.max(30, Math.round(Number(incoming.cleanupDays)) || 365)),
    checkUpdates: incoming.checkUpdates !== false,
    dashboardAuth: !!incoming.dashboardAuth && !!(auth || c.auth),
    statusPage: incoming.statusPage ? safeStatusPage(incoming.statusPage, services) : null,
    layout: incoming.layout ? layout.clean(incoming.layout) : null,
    autoFix: incoming.autoFix ? autofix.clean(incoming.autoFix) : null,
    appearance: incoming.appearance ? safeAppearance(incoming.appearance) : null,
    metrics:
      incoming.metrics && /^[\w-]{20,100}$/.test(String(incoming.metrics.token))
        ? { enabled: !!incoming.metrics.enabled, token: String(incoming.metrics.token) }
        : null,
    notifications: {
      diskThreshold: Math.min(99, Math.max(50, Math.round(Number(n.diskThreshold)) || 90)),
      quiet: n.quiet
        ? {
            enabled: !!n.quiet.enabled,
            from: hhmm(n.quiet.from) ? n.quiet.from : '23:00',
            to: hhmm(n.quiet.to) ? n.quiet.to : '07:00',
            allowDown: n.quiet.allowDown !== false,
          }
        : c.notifications?.quiet,
      digest: n.digest
        ? { enabled: !!n.digest.enabled, time: hhmm(n.digest.time) ? n.digest.time : '08:00' }
        : c.notifications?.digest,
      targets: restoredTargets,
    },
  }));
  invalidate();
  return send(res, 200, { ok: true, apps: services.length });
}

// ---------------------------------------------------------------- routing
// [method, path, handler, options]. `:id` matches an app or destination id.
//   open: works without a settings session (login and password reset)
//   guessable: wrong answers count toward the per-address lockout
/** @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, params: any) => unknown} Handler */
/** @type {[string, string, Handler, { open?: boolean, guessable?: boolean }?][]} */
const ROUTE_LIST = [
  ['POST', '/login', login, { open: true, guessable: true }],
  ['POST', '/forgot', forgot, { open: true }],
  ['POST', '/reset', reset, { open: true, guessable: true }],
  ['POST', '/logout', logout, { open: true }],
  ['PUT', '/password', changePassword, { guessable: true }],
  ['PUT', '/security', saveSecurity],
  ['GET', '', (req, res) => send(res, 200, settingsPayload(req))],
  ['PUT', '/general', saveGeneral],
  ['POST', '/test', testService],
  ['POST', '/services', addService],
  ['PUT', '/services/:id', updateService],
  ['DELETE', '/services/:id', deleteService],
  ['PUT', '/order', reorderServices],
  ['GET', '/diagnostics', runDiagnostics],
  ['POST', '/notifications/test', testTarget],
  ['POST', '/notifications', addTarget],
  ['PUT', '/notifications/:id', updateTarget],
  ['DELETE', '/notifications/:id', deleteTarget],
  ['PUT', '/notification-options', saveNotificationOptions],
  ['PUT', '/status-page', saveStatusPage],
  ['GET', '/discover', discoverApps],
  ['PUT', '/layout', saveLayout],
  ['PUT', '/auto-fix', saveAutoFix],
  ['PUT', '/appearance', saveAppearance],
  ['PUT', '/metrics', saveMetrics],
  ['POST', '/metrics/token', newMetricsToken],
  ['PUT', '/logo', uploadLogo],
  ['DELETE', '/logo', removeLogo],
  ['POST', '/digest-test', sendTestDigest],
  ['GET', '/backup', backup],
  ['POST', '/restore', restore],
];
const ROUTES = ROUTE_LIST.map(([method, path, handler, opts = {}]) => ({
  method,
  handler,
  ...opts,
  pattern: new RegExp(`^${path.replace(':id', '(?<id>[\\w-]+)')}$`),
}));

// Routes under /api/settings. Without a session (when a password is set) only the `open` ones
// answer; anything else, including an unknown path, gets 401 so it reveals nothing.
/** @param {Req} req @param {Res} res @param {string} path */
async function settingsApi(req, res, path) {
  /** @type {(typeof ROUTES)[number] | null} */
  let route = null;
  /** @type {Record<string, string>} */
  let params = {};
  for (const r of ROUTES) {
    const m = r.method === req.method && r.pattern.exec(path);
    if (m) {
      route = r;
      params = m.groups || {};
      break;
    }
  }
  if (route?.guessable) {
    const wait = lockedOut(req);
    if (wait)
      return send(res, 429, { error: `Too many wrong attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` });
  }
  if (!route?.open && !loggedIn(req)) return send(res, 401, { error: 'Log in to change settings', needLogin: true });
  if (!route) return send(res, 404, { error: 'Not found' });
  return route.handler(req, res, params);
}

module.exports = { settingsApi };
