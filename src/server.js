// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media Ops server. Serves the dashboard (/) and settings (/settings) pages, polls every
// configured app, and exposes the JSON API the pages use:
//
//   GET  /api/overview                     poll results + errors feed (cached a few seconds)
//   GET  /api/media/thumb?s=…&p=…          poster proxy for Plex/Jellyfin/Emby (keeps tokens server-side)
//   POST /api/events/dismiss|restore       hide / unhide errors-feed entries
//   POST /api/events/services/:id/clear    clear an app's own log (needs login if a password is set)
//   POST /api/events/services/:id/recheck  re-run an app's health checks
//   *    /api/settings/…                   apps, general options, password, password reset
//   GET  /api/status                       the public status page's data (only when turned on)
//   GET  /metrics                          Prometheus metrics (when turned on; Bearer token)
//   GET  /branding/logo                    the logo uploaded under Settings → Appearance
//   GET  /healthz                          liveness probe
//
// This file only routes and starts things. The work lives in lib/:
//   poll.js           polling the apps, the overview, the background monitor
//   settings-api.js   /api/settings/…        dashboard-api.js   /api/events/…, posters
//   auth.js           sessions and lockout   web.js             headers, JSON, static files
//   host.js           CPU/memory, disks, Docker for the Host panel
//
// No dependencies beyond Node's standard library.
'use strict';
const http = require('node:http');
const path = require('node:path');
const config = require('./lib/config');
const appearance = require('./lib/appearance');
const history = require('./lib/history');
const { loggedIn } = require('./lib/auth');
const { SECURITY_HEADERS, sameOrigin, send, serveStatic } = require('./lib/web');
const {
  DEMO,
  overview,
  monitorTick,
  historyPayload,
  statusEnabled,
  statusPayload,
  metricsEnabled,
  metricsText,
} = require('./lib/poll');
const metrics = require('./lib/metrics');
const { eventsApi, mediaThumb } = require('./lib/dashboard-api');
const { settingsApi } = require('./lib/settings-api');

const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8484;
const PAGES = { '/': '/index.html', '/settings': '/settings.html', '/status': '/status.html' };

// With "require login for the dashboard" on, only the login page (Settings), the public status
// page (when it's turned on) and what they need are reachable without a session.
const STATUS_PAGE = new Set(['/status', '/status.html', '/api/status']);
const ALWAYS_OPEN = new Set([
  ...STATUS_PAGE,
  '/branding/logo', // shown on the login page and the status page
  '/metrics', // Prometheus can't log in; it has its own token
  '/js/status.js',
  '/healthz',
  '/settings',
  '/settings.html',
  '/settings.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/fonts/InterVariable.woff2',
]);
/** @param {import('node:http').IncomingMessage} req @param {string} pathname */
function dashboardLocked(req, pathname) {
  const cfg = config.load();
  if (!cfg.dashboardAuth || !cfg.auth || ALWAYS_OPEN.has(pathname) || pathname.startsWith('/api/settings'))
    return false;
  return !loggedIn(req);
}

// Pages get the appearance settings written in (lib/appearance.js).
/** @type {Record<string, string>} */
const PAGE_OF = { 'index.html': 'dashboard', 'settings.html': 'settings', 'status.html': 'status' };
/** @type {{ key: () => string, apply: (html: string, file: string) => string }} */
const PAGE_RENDER = {
  key: () => appearance.pageKey(config.load()),
  apply: (html, file) => appearance.renderPage(html, config.load(), PAGE_OF[path.basename(file)] || 'other'),
};
/** @param {import('node:http').ServerResponse} res */
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function metricsEndpoint(req, res) {
  if (!metricsEnabled()) return send(res, 404, { error: 'Not found' });
  if (!metrics.authorized(req.headers.authorization, config.load())) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="media-ops"', 'Content-Type': 'text/plain' });
    return res.end('Send the token from Settings → Metrics as "Authorization: Bearer <token>".\n');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(metricsText());
}

/** @param {import('node:http').ServerResponse} res */
function brandingLogo(res) {
  const saved = config.load().appearance?.logo;
  if (!saved?.data) return send(res, 404);
  // Re-checked on the way out: the type comes from the image's own bytes, never from
  // config.json, so a hand-edited file can't make this serve HTML from our origin.
  let logo;
  try {
    logo = appearance.logoFrom(saved.data);
  } catch {
    return send(res, 404);
  }
  const body = Buffer.from(logo.data, 'base64');
  // The URL carries the image's hash (?v=…), so it can be cached for good.
  res.writeHead(200, {
    'Content-Type': logo.type,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  return res.end(body);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {
    return send(res, 400);
  }
  try {
    if (dashboardLocked(req, url.pathname)) {
      if (url.pathname.startsWith('/api/'))
        return send(res, 401, { error: 'Log in to view the dashboard', needLogin: true });
      res.writeHead(302, { Location: `/settings?next=${encodeURIComponent(url.pathname + url.search)}` });
      return res.end();
    }
    if (STATUS_PAGE.has(url.pathname) && !statusEnabled()) return send(res, 404, { error: 'Not found' });
    if (url.pathname === '/api/status') return send(res, 200, statusPayload());
    if (url.pathname === '/api/overview') return send(res, 200, await overview());
    if (url.pathname === '/api/history') return send(res, 200, historyPayload());
    if (url.pathname === '/api/media/thumb')
      return mediaThumb(res, url.searchParams.get('s'), url.searchParams.get('p'));
    if (url.pathname === '/healthz') return res.writeHead(200).end('ok');
    if (url.pathname === '/branding/logo') return brandingLogo(res);
    if (url.pathname === '/metrics') return metricsEndpoint(req, res);
    if (url.pathname.startsWith('/api/events/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
      return await eventsApi(req, res, url.pathname.slice('/api/events'.length));
    }
    if (url.pathname === '/api/settings' || url.pathname.startsWith('/api/settings/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
      return await settingsApi(req, res, url.pathname.slice('/api/settings'.length));
    }
    return await serveStatic(req, res, url, PUBLIC, PAGES, PAGE_RENDER);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') return res.writeHead(404).end('Not found');
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.headersTimeout = 15000; // a client gets 15 s to send its headers...
server.requestTimeout = 30000; // ...and 30 s for the whole request (the biggest is a 2 MB restore)

history.load();
setInterval(history.save, 5 * 60e3).unref();
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    history.save();
    process.exit(0);
  });
setTimeout(monitorTick, 2000).unref();

server.listen(PORT, () => {
  const cfg = config.load();
  console.log(`Media Ops on http://localhost:${PORT}  (settings: http://localhost:${PORT}/settings)`);
  console.log(`Config file: ${config.FILE}`);
  if (DEMO) console.log('DEMO=1 — the dashboard shows fake data.');
  else if (!cfg.services.length) console.log('No apps connected yet — open /settings to add them.');
  else console.log(`Watching ${cfg.services.length} apps: ${cfg.services.map(s => s.name).join(', ')}`);
});
