// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Newer integrations and features: Unraid, Plex resources/recently added, arr imports, Seerr
// requests + approve, GPU readings, quiet hours, upload alert, daily digest.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, fakeServer } = require('./helpers');
const c = require('../lib/collectors');
const actions = require('../lib/actions');
const notify = require('../lib/notify');
const feed = require('../lib/events');
const digest = require('../lib/digest');
const history = require('../lib/history');
const { clearCache } = require('../lib/http');

test('unraid: GraphQL query with x-api-key; disk problems become stable events', async t => {
  const srv = await fakeServer({ 'POST /graphql': (req, url, body) => (req.headers['x-api-key'] === 'uk' && JSON.parse(body).query.includes('array') ? fixture('unraid-array') : { status: 401 }) });
  t.after(() => srv.close());
  const r = await c.unraid({ url: srv.url, apiKey: 'uk' });
  assert.equal(r.version, '7.2.1');
  assert.equal(r.data.capacity.total, 40 * 1024 ** 4, 'KiB converted to bytes');
  const msgs = r.data.events.map(e => `${e.level}:${e.message}`);
  assert.ok(msgs.includes('warn:Disk disk1 is running hot'), '47 °C on a hard drive (warn 45)');
  assert.ok(msgs.includes('error:Disk disk1 is nearly full'), '93% >= critical 90');
  assert.ok(msgs.includes('error:Disk disk2 is disabled'));
  assert.ok(msgs.includes('warn:Disk disk2 has read/write errors'));
  assert.ok(!msgs.some(m => m.includes('cache')), 'SSD at 58 °C is under its 60 °C warning');
  assert.ok(!msgs.some(m => /filling up/.test(m)), 'Unraid warning-level fill (70%) does not alert');
  assert.ok(r.data.events.every(e => !/\d+ °C/.test(e.message)), 'temperature kept out of the message so the event key stays stable');
  await assert.rejects(c.unraid({ url: srv.url, apiKey: 'wrong' }), /401/);
});

test('plex: resources and recently added', async t => {
  const srv = await fakeServer({
    '/identity': { MediaContainer: { version: '1.42.2' } },
    '/status/sessions': { MediaContainer: { size: 0 } },
    '/library/sections': { MediaContainer: { Directory: [] } },
    '/statistics/resources': fixture('plex-resources'),
    '/library/recentlyAdded': fixture('plex-recent'),
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.plex({ url: srv.url, token: 't' });
  assert.deepEqual(r.data.resources, { hostCpu: 35, plexCpu: 28, hostMem: 42, plexMem: 3.6 }, 'latest sample');
  assert.equal(r.data.recentlyAdded[0].title, 'Andor');
  assert.equal(r.data.recentlyAdded[0].sub, 'S02E10 · Who Are You?');
  assert.equal(r.data.recentlyAdded[1].sub, '2025');
});

test('sonarr/radarr: imports from history (eventType=3)', async t => {
  const routes = prefix => ({
    [`${prefix}/system/status`]: { version: '5' }, [`${prefix}/health`]: [], [`${prefix}/diskspace`]: [], [`${prefix}/log`]: { records: [] },
    [`${prefix}/queue`]: { records: [] }, [`${prefix}/wanted/missing`]: { totalRecords: 0 }, [`${prefix}/calendar`]: [],
  });
  const srv = await fakeServer({
    ...routes('/api/v3'), '/api/v3/series': [], '/api/v3/movie': [],
    '/api/v3/history': (req, url) => {
      assert.equal(url.searchParams.get('eventType'), '3');
      return url.searchParams.get('includeMovie') ? fixture('radarr-history') : fixture('sonarr-history');
    },
  });
  t.after(() => srv.close());
  clearCache();
  const s = await c.sonarr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(s.data.imports.map(x => [x.title, x.quality]), [['Andor S02E08', 'WEBDL-1080p']]);
  clearCache();
  const r = await c.radarr({ url: srv.url, apiKey: 'k' });
  assert.equal(r.data.imports[0].title, 'Sinners (2025)');
});

test('seerr: pending requests get titles; approve posts to /request/:id/approve', async t => {
  const srv = await fakeServer({
    '/api/v1/status': { version: '3.0.1' },
    '/api/v1/request/count': fixture('seerr-count'),
    '/api/v1/settings/logs': [],
    'GET /api/v1/request': fixture('seerr-pending'),
    '/api/v1/movie/1233413': fixture('seerr-movie'),
    '/api/v1/tv/136315': fixture('seerr-tv'),
    'POST /api/v1/request/41/approve': {},
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.seerr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(r.data.requests.map(x => [x.title, x.year, x.requestedBy]), [['Sinners', '2025', 'viewer-c'], ['The Bear', '2022', 'viewer-d']]);
  assert.deepEqual(r.data.requests[1].seasons, [1, 2]);
  await actions.seerrRequest({ kind: 'seerr', url: srv.url, apiKey: 'k' }, 41, 'approve');
  assert.ok(srv.calls.some(x => x.method === 'POST' && x.path === '/api/v1/request/41/approve' && x.headers['x-api-key'] === 'k'));
  await assert.rejects(actions.seerrRequest({ kind: 'seerr', url: srv.url, apiKey: 'k' }, 41, 'delete'), /Bad request/);
});

test('gpu: AMD busy %, Intel busy from idle residency, virtual GPUs ignored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-'));
  const card = (n, files) => { for (const [f, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, n, f)), { recursive: true }); fs.writeFileSync(path.join(root, n, f), String(v)); } };
  card('card0', { 'device/vendor': '0x8086', 'power/rc6_residency_ms': 1000, gt_act_freq_mhz: 900, gt_RP0_freq_mhz: 1300 });
  card('card1', { 'device/vendor': '0x1002', 'device/gpu_busy_percent': 42 });
  card('card2', { 'device/vendor': '0x1b36' });
  process.env.GPU_SYSFS = root;
  const gpu = require('../lib/gpu');
  const first = await gpu.read();
  assert.deepEqual(first.map(g => g.vendor), ['Intel', 'AMD']);
  assert.equal(first.find(g => g.vendor === 'AMD').busy, 42);
  assert.equal(first.find(g => g.vendor === 'Intel').busy, null, 'needs two samples');
  await new Promise(r => setTimeout(r, 1000));
  fs.writeFileSync(path.join(root, 'card0', 'power/rc6_residency_ms'), '1250'); // idle 250 of ~1000 ms -> ~75% busy
  const intel = (await gpu.read()).find(g => g.vendor === 'Intel');
  assert.ok(intel.busy >= 65 && intel.busy <= 80, `busy ${intel.busy}`);
  assert.equal(intel.freqMhz, 900);
});

test('quiet hours: held overnight (except app-down), sent together afterwards', async t => {
  const got = [];
  const srv = await fakeServer({ 'POST /h': (req, url, body) => { got.push(JSON.parse(body).message); return {}; } });
  t.after(() => srv.close());
  const now = new Date();
  const hh = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const quietNow = { enabled: true, from: hh(new Date(now - 3600e3)), to: hh(new Date(+now + 3600e3)), allowDown: true };
  assert.equal(notify.inQuietHours(quietNow, now), true);
  assert.equal(notify.inQuietHours({ enabled: true, from: '23:00', to: '07:00' }, new Date(2026, 0, 1, 2, 0)), true, 'across midnight');
  assert.equal(notify.inQuietHours({ enabled: true, from: '23:00', to: '07:00' }, new Date(2026, 0, 1, 12, 0)), false);

  const target = notify.mergeTarget(null, { type: 'webhook', url: `${srv.url}/h` });
  const cfg = q => ({ notifications: { targets: [target], quiet: q } });
  const svc = (up, events = []) => ({ services: [{ id: 'x', name: 'Radarr', kind: 'radarr', up, error: up ? undefined : 'refused', data: up ? { health: [], events } : undefined }] });
  const run = (r, q) => notify.handle(r, feed.collect(r.services), [], cfg(q));
  await run(svc(true), quietNow); // seed
  await run(svc(true, [{ time: new Date().toISOString(), level: 'error', source: 'Import', message: 'night error' }]), quietNow);
  assert.equal(got.length, 0, 'error held');
  await run(svc(false), quietNow); await run(svc(false), quietNow);
  assert.match(got.at(-1), /Radarr is down/, 'app-down still sent');
  await run(svc(false), { enabled: false });
  assert.match(got.at(-1), /🌙 .*night error/, 'held alert delivered after quiet hours');
});

test('upload alert: once when remote streams pass 85%, again only after dropping below 75%', async t => {
  const got = [];
  const srv = await fakeServer({ 'POST /h': (req, url, body) => { got.push(JSON.parse(body).message); return {}; } });
  t.after(() => srv.close());
  const cfg = { uploadMbps: 40, notifications: { targets: [notify.mergeTarget(null, { type: 'webhook', url: `${srv.url}/h` })] } };
  const raw = mbps => ({ services: [{ id: 'p', name: 'Plex', kind: 'plex', up: true, data: { health: [], events: [], streams: [{ sessionId: 's', local: false, bandwidth: mbps * 1000, user: 'u', title: 't', type: 'movie', subtitle: '' }] } }] });
  const run = m => notify.handle(raw(m), [], [], cfg);
  await run(10); // seed (also learns the stream)
  await run(36);
  assert.match(got.at(-1), /36 of your 40 Mbps upload \(90%\)/);
  await run(37);
  assert.equal(got.length, 1, 'no repeat while still high');
  await run(20); await run(38);
  assert.equal(got.length, 2, 'fires again after recovering');
});

test('digest: plays, imports, downtime, errors and requests in one message', () => {
  const now = Date.now();
  const y = history.dayKey(now - 864e5);
  const raw = { services: [
    { id: 't', kind: 'tautulli', name: 'Tautulli', up: true, data: { playsByDate: { dates: [y], series: [{ name: 'TV', data: [9] }, { name: 'Movies', data: [2] }] } } },
    { id: 's', kind: 'sonarr', name: 'Sonarr', up: true, data: { imports: [{ time: new Date(now - 3600e3).toISOString() }, { time: new Date(now - 7200e3).toISOString() }] } },
    { id: 'r', kind: 'radarr', name: 'Radarr', up: true, data: { imports: [{ time: new Date(now - 3600e3).toISOString() }, { time: new Date(now - 3 * 864e5).toISOString() }] } },
    { id: 'o', kind: 'seerr', name: 'Seerr', up: true, data: { stats: { pending: 2 } } },
  ] };
  const events = [{ level: 'error', t: now - 3600e3, dismissed: false }, { level: 'error', t: now - 3600e3, dismissed: true }];
  const { title, lines } = digest.build(raw, events, now);
  assert.match(title, /daily digest/);
  const text = lines.join('\n');
  assert.match(text, /11 plays yesterday \(9 TV, 2 Movies\)/);
  assert.match(text, /Added: 2 episodes, 1 movie/);
  assert.match(text, /No downtime|Downtime/);
  assert.match(text, /1 error in the last 24 h/);
  assert.match(text, /2 requests waiting/);
});
