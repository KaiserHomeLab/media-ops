// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The real server in a child process: dashboard login, backup/restore, cross-site protection,
// diagnostics. No apps configured, so nothing reaches out to the network.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeServer } = require('./helpers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-srv-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CONFIG: path.join(dir, 'config.json'), DEMO: '', HOST_OS: 'Unraid' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => child.kill('SIGTERM'));

const json = (method, p, body, headers = {}) =>
  fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });

test('detects the NAS it runs on (Unraid sets HOST_OS) so Settings can offer it', async () => {
  const s = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(s.hostOs, 'unraid');
  assert.ok(s.kinds.some(k => k.kind === 'truenas'));
});

test('testing an app at localhost explains that localhost is the container itself', async () => {
  const r = await (
    await json('POST', '/api/settings/test', { kind: 'sonarr', name: 'Sonarr', url: 'http://localhost:1', apiKey: 'x' })
  ).json();
  assert.equal(r.ok, false);
  assert.match(r.error, /inside the Media Ops container, localhost means the container itself/);
  const lan = await (
    await json('POST', '/api/settings/test', { kind: 'ping', name: 'Router', url: 'http://127.0.0.2:1' })
  ).json();
  assert.doesNotMatch(lan.error || '', /host\.docker\.internal/, 'that tip is only for Docker Desktop');
});

test('poster proxy never follows a redirect (the Plex token would go along)', async () => {
  const evil = await fakeServer({ '/steal': 'gotcha' });
  const plex = await fakeServer({ '/photo/:/transcode': { status: 302, headers: { Location: `${evil.url}/steal` } } });
  const svc = await (
    await json('POST', '/api/settings/services', { kind: 'plex', name: 'Plex', url: plex.url, token: 'secret-token' })
  ).json();
  try {
    const r = await fetch(`${base}/api/plex/thumb?p=/library/metadata/1/thumb/2`);
    assert.equal(r.status, 502);
    assert.equal(plex.calls.length, 1);
    assert.equal(evil.calls.length, 0);
  } finally {
    await json('DELETE', `/api/settings/services/${svc.id}`);
    plex.close();
    evil.close();
  }
});

test('re-check is open without a login, so it is throttled per app', async () => {
  const svc = await (
    await json('POST', '/api/settings/services', { kind: 'ping', name: 'Router', url: 'http://127.0.0.1:1' })
  ).json();
  try {
    assert.equal((await json('POST', `/api/events/services/${svc.id}/recheck`, {})).status, 200);
    assert.equal((await json('POST', `/api/events/services/${svc.id}/recheck`, {})).status, 429);
  } finally {
    await json('DELETE', `/api/settings/services/${svc.id}`);
  }
});

test('settings writes from another website are refused', async () => {
  const r = await json('PUT', '/api/settings/general', { refreshSeconds: 10 }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('every response carries the security headers; pages are cached with ETags and gzipped', async () => {
  const r = await fetch(`${base}/js/main.js`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-security-policy'), /style-src-elem 'self'/);
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  const again = await fetch(`${base}/js/main.js`, { headers: { 'If-None-Match': r.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/icons/`)).status, 404, 'a folder is a 404, not a server error');
});

test('writes flagged cross-site by the browser are refused even without an Origin header', async () => {
  const r = await json('PUT', '/api/settings/general', { refreshSeconds: 10 }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
});

test('backups need a password (they hold every key); restore runs every app through the form checks', async () => {
  let r = await json('POST', '/api/settings/services', { kind: 'ping', name: 'Router', url: 'http://192.0.2.1' });
  assert.equal(r.status, 201);
  const hook = await (
    await json('POST', '/api/settings/notifications', { type: 'webhook', name: 'Hook', url: 'http://192.0.2.5/hook' })
  ).json();
  assert.equal((await fetch(`${base}/api/settings/backup`)).status, 403, 'no password: no backup download');
  r = await json('PUT', '/api/settings/password', { next: 'backup-pw-123' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/settings/backup`)).status, 401, 'password set: must be logged in');
  const backup = await (await fetch(`${base}/api/settings/backup`, { headers: { Cookie: cookie } })).json();
  assert.equal(backup.app, 'media-ops');
  assert.equal(backup.config.services[0].name, 'Router');
  const restore = body => json('POST', '/api/settings/restore', body, { Cookie: cookie });
  assert.equal(
    (await restore({ config: { services: [{ kind: 'bogus', url: 'http://x' }] }, app: 'media-ops' })).status,
    400,
  );
  assert.equal((await restore({ nope: true })).status, 400);
  r = await restore({
    app: 'media-ops',
    // eslint-disable-next-line no-script-url -- the link must be refused
    config: { services: [{ kind: 'ping', url: 'http://x', link: 'javascript:alert(1)' }] },
  });
  assert.equal(r.status, 400, 'a crafted link is refused like in the form');
  r = await restore({ ...backup, config: { ...backup.config, evil: 'x', refreshSeconds: 1 } });
  assert.deepEqual(await r.json(), { ok: true, apps: 1 });
  const restored = await (await fetch(`${base}/api/settings/backup`, { headers: { Cookie: cookie } })).json();
  assert.equal(restored.config.evil, undefined, 'unknown settings are dropped');
  assert.equal(restored.config.refreshSeconds, 3, 'values are clamped to what the form allows');
  const targets = restored.config.notifications.targets;
  assert.equal(targets.length, 1, 'notification destinations come back');
  assert.equal(targets[0].name, 'Hook');
  assert.equal(targets[0].url, 'http://192.0.2.5/hook');
  await json('DELETE', `/api/settings/notifications/${hook.id}`, undefined, { Cookie: cookie });
  await json('PUT', '/api/settings/password', { current: 'backup-pw-123', next: '' }, { Cookie: cookie });
});

test('diagnostics runs every app and reports versions', async () => {
  const d = await (await fetch(`${base}/api/settings/diagnostics`)).json();
  assert.ok(d.mediaOps);
  assert.equal(d.apps[0].name, 'Router');
  assert.equal(d.apps[0].calls[0].url, 'http://192.0.2.1/');
});

test('dashboard login: locked dashboard redirects and refuses data until logged in', async () => {
  let r = await json('PUT', '/api/settings/security', { dashboardAuth: true });
  assert.equal(r.status, 400, 'needs a password first');
  r = await json('PUT', '/api/settings/password', { next: 'long-enough-pw' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await json('PUT', '/api/settings/security', { dashboardAuth: true }, { Cookie: cookie });
  assert.equal(r.status, 200);

  r = await fetch(`${base}/?tv=1`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/settings?next=%2F%3Ftv%3D1');
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  assert.equal((await fetch(`${base}/settings`)).status, 200, 'login page stays reachable');
  assert.equal((await fetch(`${base}/style.css`)).status, 200);

  assert.equal((await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } })).status, 200);
  r = await json('POST', '/api/settings/login', { password: 'long-enough-pw' });
  assert.equal(r.status, 200);

  // Removing the password also unlocks the dashboard.
  await json('PUT', '/api/settings/password', { current: 'long-enough-pw', next: '' }, { Cookie: cookie });
  assert.equal((await fetch(`${base}/api/overview`)).status, 200);
});

test('status page: off by default; when on, only the chosen apps and their uptime, even with the dashboard locked', async () => {
  for (const p of ['/status', '/api/status'])
    assert.equal((await fetch(base + p)).status, 404, `${p} is off by default`);
  const settings = await (await fetch(`${base}/api/settings`)).json();
  const router = settings.services.find(x => x.name === 'Router');
  const hidden = await (
    await json('POST', '/api/settings/services', { kind: 'ping', name: 'Hidden box', url: 'http://192.0.2.7' })
  ).json();
  let r = await json('PUT', '/api/settings/status-page', { enabled: true, title: 'x'.repeat(81), services: [] });
  assert.equal(r.status, 400, 'title length is checked');
  r = await json('PUT', '/api/settings/status-page', {
    enabled: true,
    title: 'Our server',
    notice: 'Back soon',
    services: [router.id, 'not-an-app', router.id],
  });
  assert.deepEqual((await r.json()).statusPage.services, [router.id], 'unknown and repeated ids dropped');

  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.title, 'Our server');
  assert.equal(st.notice, 'Back soon');
  assert.deepEqual(
    st.services.map(x => Object.keys(x).sort()),
    [['cells', 'day', 'name', 'up', 'week']],
    'only the name, up/down and uptime',
  );
  assert.equal(st.services[0].name, 'Router');
  assert.doesNotMatch(JSON.stringify(st), /192\.0\.2|Hidden box|ping/, 'no addresses, kinds or other apps');
  r = await fetch(`${base}/status`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /js\/status\.js/);

  r = await json('PUT', '/api/settings/password', { next: 'status-page-pw' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  await json('PUT', '/api/settings/security', { dashboardAuth: true }, { Cookie: cookie });
  assert.equal((await fetch(`${base}/api/overview`)).status, 401, 'dashboard locked');
  for (const p of ['/status', '/api/status', '/js/status.js'])
    assert.equal((await fetch(base + p, { redirect: 'manual' })).status, 200, `${p} stays open`);
  assert.equal((await fetch(`${base}/js/main.js`, { redirect: 'manual' })).status, 302, 'the dashboard code does not');

  await json('PUT', '/api/settings/status-page', { enabled: false }, { Cookie: cookie });
  assert.equal((await fetch(`${base}/status`)).status, 404, 'off again');
  await json('DELETE', `/api/settings/services/${hidden.id}`, undefined, { Cookie: cookie });
  await json('PUT', '/api/settings/password', { current: 'status-page-pw', next: '' }, { Cookie: cookie });
});

test('apps found in Docker: read through the configured socket proxy; none when Docker is off', async t => {
  const g = (await (await fetch(`${base}/api/settings`)).json()).general;
  const general = dockerSocket =>
    json('PUT', '/api/settings/general', { ...g, paths: g.paths.join('\n'), dockerSocket });
  await general('');
  let r = await (await fetch(`${base}/api/settings/discover`)).json();
  assert.deepEqual(r, { docker: false, apps: [] }, 'Docker turned off');
  const docker = await fakeServer({
    '/containers/json': [
      {
        Id: 'a1',
        Names: ['/sonarr'],
        Image: 'lscr.io/linuxserver/sonarr:latest',
        State: 'running',
        Ports: [{ PrivatePort: 8989, PublicPort: 8989, Type: 'tcp' }],
        NetworkSettings: { Networks: { bridge: {} } },
      },
    ],
  });
  t.after(() => docker.close());
  await general(docker.url);
  r = await (await fetch(`${base}/api/settings/discover`)).json();
  assert.deepEqual(r, {
    docker: true,
    apps: [{ kind: 'sonarr', label: 'Sonarr', container: 'sonarr', via: 'published', host: null, port: 8989 }],
  });
  await general(g.dockerSocket);
});

// Last: it locks this test client's address out of logging in.
test('password guessing: locked out after 10 wrong tries', async () => {
  let r = await json('PUT', '/api/settings/password', { next: 'guess-me-not-1' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const tries = await Promise.all(
    Array.from({ length: 10 }, () => json('POST', '/api/settings/login', { password: 'wrong' })),
  );
  assert.ok(tries.every(t => t.status === 401));
  r = await json('POST', '/api/settings/login', { password: 'guess-me-not-1' });
  assert.equal(r.status, 429, 'even the right password waits out the lockout');
  await json('PUT', '/api/settings/password', { current: 'guess-me-not-1', next: '' }, { Cookie: cookie });
});
