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
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => child.kill('SIGTERM'));

const json = (method, p, body, headers = {}) =>
  fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });

test('detects the NAS it runs on (Unraid sets HOST_OS) so Settings can offer it', async () => {
  const s = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(s.hostOs, 'unraid');
  assert.ok(s.kinds.some(k => k.kind === 'truenas'));
});

test('settings writes from another website are refused', async () => {
  const r = await json('PUT', '/api/settings/general', { refreshSeconds: 10 }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('backup includes secrets; restore validates and keeps the current password', async () => {
  let r = await json('POST', '/api/settings/services', { kind: 'ping', name: 'Router', url: 'http://192.0.2.1' });
  assert.equal(r.status, 201);
  const backup = await (await fetch(`${base}/api/settings/backup`)).json();
  assert.equal(backup.app, 'media-ops');
  assert.equal(backup.config.services[0].name, 'Router');
  r = await json('POST', '/api/settings/restore', { config: { services: [{ kind: 'bogus', url: 'http://x' }] }, app: 'media-ops' });
  assert.equal(r.status, 400);
  r = await json('POST', '/api/settings/restore', { nope: true });
  assert.equal(r.status, 400);
  r = await json('POST', '/api/settings/restore', backup);
  assert.deepEqual(await r.json(), { ok: true, apps: 1 });
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
