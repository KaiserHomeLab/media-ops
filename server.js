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
// This file only routes and starts things. The work lives in lib/:
//   poll.js           polling the apps, the overview, the background monitor
//   settings-api.js   /api/settings/…        dashboard-api.js   /api/events/…, posters
//   auth.js           sessions and lockout   web.js             headers, JSON, static files
//   host.js           CPU/memory, disks, Docker for the Host panel
//
// No dependencies beyond Node's standard library.'use strict';
const http = require('node:http');
const path = require('node:path');
const config = require('./lib/config');
const history = require('./lib/history');
const { loggedIn } = require('./lib/auth');
const { SECURITY_HEADERS, sameOrigin, send, serveStatic } = require('./lib/web');
const { DEMO, overview, monitorTick, historyPayload } = require('./lib/poll');
const { eventsApi, plexThumb } = require('./lib/dashboard-api');
const { settingsApi } = require('./lib/settings-api');

const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8484;
const PAGES = { '/': '/index.html', '/settings': '/settings.html' };

// With "require login for the dashboard" on, only the login page (Settings) and what it needs
// are reachable without a session.
const ALWAYS_OPEN = new Set([
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
function dashboardLocked(req, pathname) {
  const cfg = config.load();
  if (!cfg.dashboardAuth || !cfg.auth || ALWAYS_OPEN.has(pathname) || pathname.startsWith('/api/settings'))
    return false;
  return !loggedIn(req);
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
    return await serveStatic(req, res, url, PUBLIC, PAGES);
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
