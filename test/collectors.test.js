// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Each collector against a fake app answering with recorded-style API replies (test/fixtures).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, fakeServer, fakeTrueNAS } = require('./helpers');
const c = require('../lib/collectors');
const { clearCache, trace } = require('../lib/http');

const arrRoutes = (prefix, extra) => ({
  [`${prefix}/system/status`]: { version: '4.0.15' },
  [`${prefix}/health`]: fixture('arr-health'),
  [`${prefix}/diskspace`]: fixture('arr-diskspace'),
  [`${prefix}/log`]: fixture('sonarr-log'),
  ...extra,
});

test('plex: streams, transcode reason, local/remote, libraries', async t => {
  const srv = await fakeServer({
    '/identity': { MediaContainer: { version: '1.42.2' } },
    '/status/sessions': fixture('plex-sessions'),
    '/library/sections': fixture('plex-sections'),
    '/library/sections/1/all': { MediaContainer: { size: 0, totalSize: 2184 } },
    '/library/sections/2/all': (req, url) => ({ MediaContainer: { size: 0, totalSize: url.searchParams.get('type') === '4' ? 18733 : 412 } }),
    '/library/sections/3/all': (req, url) => ({ MediaContainer: { size: 0, totalSize: { 9: 4210, 10: 51288 }[url.searchParams.get('type')] ?? 1307 } }),
    '/library/recentlyAdded': { MediaContainer: { Metadata: [
      { ratingKey: '1', type: 'movie', title: 'M*A*S*H', year: 1970, addedAt: 4039401600 }, // corrupt: year 2098
      { ratingKey: '2', type: 'movie', title: 'Dune', year: 2021, addedAt: Math.floor(Date.now() / 1000) - 3600 },
    ] } },
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.plex({ url: srv.url, token: 'tok' });
  assert.equal(r.version, '1.42.2');
  const [ep, track] = r.data.streams;
  assert.equal(ep.title, 'Andor');
  assert.equal(ep.subtitle, 'S01E12 · Rix Road');
  assert.equal(ep.decision, 'Transcode');
  assert.equal(ep.fourKTranscode, true);
  assert.equal(ep.sessionId, 'sess-12');
  assert.match(ep.reason, /burning in subtitles/);
  assert.match(ep.reason, /HEVC → H264/);
  assert.match(ep.reason, /quality limit 4K → 1080p/);
  assert.match(ep.reason, /audio TRUEHD → AAC/);
  assert.equal(ep.local, false);
  assert.equal(track.local, true);
  assert.equal(track.decision, 'Direct Play');
  assert.equal(track.subtitle, 'Reckoner — In Rainbows');
  const tv = r.data.libraries.find(l => l.type === 'show');
  assert.deepEqual([tv.count, tv.episodes], [412, 18733]);
  assert.equal(srv.calls[0].headers['x-plex-token'], 'tok', 'token goes in a header, not the URL');
  assert.deepEqual(r.data.recentlyAdded.map(m => m.title), ['Dune'], 'future-dated items skipped');
});

test('sonarr: stats, queue warning becomes an event, logs filtered to warn+', async t => {
  const srv = await fakeServer(arrRoutes('/api/v3', {
    '/api/v3/series': fixture('sonarr-series'),
    '/api/v3/queue': fixture('sonarr-queue'),
    '/api/v3/wanted/missing': { totalRecords: 7 },
    '/api/v3/calendar': fixture('sonarr-calendar'),
  }));
  t.after(() => srv.close());
  clearCache();
  const r = await c.sonarr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(r.data.stats, { series: 3, monitored: 2, continuing: 2, episodes: 48, missing: 7, size: 150_000_000_000 });
  assert.equal(r.data.queue[0].title, 'Andor S02E09');
  assert.equal(r.data.queue[0].progress, 0.75);
  const stuck = r.data.events.find(e => e.source === 'Queue');
  assert.equal(stuck.queueId, 813);
  assert.match(stuck.message, /No files found are eligible/);
  const logLevels = r.data.events.filter(e => e.source !== 'Queue').map(e => e.level);
  assert.deepEqual(logLevels, ['error', 'warn'], 'info lines are dropped');
  assert.equal(r.data.upcoming[0].sub, 'S02E10 · Who Are You?');
  assert.equal(srv.calls[0].headers['x-api-key'], 'k');
  const before = srv.calls.filter(x => x.path === '/api/v3/series').length;
  await c.sonarr({ url: srv.url, apiKey: 'k' });
  assert.equal(srv.calls.filter(x => x.path === '/api/v3/series').length, before, 'full series list cached between polls');
});

test('radarr: missing counts only monitored + available', async t => {
  const srv = await fakeServer(arrRoutes('/api/v3', {
    '/api/v3/movie': fixture('radarr-movies'),
    '/api/v3/queue': { records: [] },
    '/api/v3/calendar': [],
  }));
  t.after(() => srv.close());
  clearCache();
  const r = await c.radarr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(r.data.stats, { movies: 3, monitored: 3, onDisk: 1, missing: 1, size: 60_000_000_000 });
});

test('sabnzbd: speed, queue, failed history and warnings as events', async t => {
  const srv = await fakeServer({
    '/api': (req, url) => ({ queue: fixture('sab-queue'), server_stats: fixture('sab-stats'), warnings: fixture('sab-warnings'), history: fixture('sab-history-failed') })[url.searchParams.get('mode')],
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.sabnzbd({ url: srv.url, apiKey: 'k' });
  assert.equal(r.version, '4.5.1');
  assert.equal(r.data.downBps, 2048 * 1024);
  assert.equal(r.data.items[0].progress, 0.74);
  assert.deepEqual(r.data.events.map(e => [e.source, e.level]), [['Warnings', 'warn'], ['Failed download', 'error']]);
});

test('qbittorrent: logs in, reuses the session, renews it on 403', async t => {
  let logins = 0, sid = 'one';
  const srv = await fakeServer({
    'POST /api/v2/auth/login': (req, url, body) => {
      logins++;
      assert.match(body, /username=admin/);
      return { status: 200, body: 'Ok.', headers: { 'Set-Cookie': `SID=${sid}; path=/` } };
    },
    '/api/v2/app/version': req => (req.headers.cookie === `SID=${sid}` ? 'v5.1.2' : { status: 403, body: 'Forbidden' }),
    '/api/v2/sync/maindata': fixture('qbit-maindata'),
  });
  t.after(() => srv.close());
  const cfg = { url: srv.url, username: 'admin', password: 'pw' };
  const r = await c.qbittorrent(cfg);
  assert.equal(r.version, 'v5.1.2');
  assert.equal(r.data.ratio, 2.31);
  assert.equal(r.data.items.length, 1, 'only unfinished torrents listed');
  await c.qbittorrent(cfg);
  assert.equal(logins, 1, 'session reused');
  sid = 'two';
  await c.qbittorrent(cfg);
  assert.equal(logins, 2, 'expired session renewed');
});

test('tautulli: home stats and plays by date', async t => {
  const srv = await fakeServer({
    '/api/v2': (req, url) => ({ response: { result: 'success', data: { get_tautulli_info: { tautulli_version: 'v2.15.3' }, get_home_stats: fixture('tautulli-home'), get_plays_by_date: fixture('tautulli-plays'), get_logs: [] }[url.searchParams.get('cmd')] } }),
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.tautulli({ url: srv.url, apiKey: 'k' });
  assert.equal(r.version, 'v2.15.3');
  assert.equal(r.data.topUsers[0].plays, 20);
  assert.equal(r.data.mostConcurrent, 4);
  assert.deepEqual(r.data.playsByDate.series[0].data, [3, 5]);
});

test('clonarr: widget summary, and graceful fallback when the endpoint is missing', async t => {
  const full = await fakeServer({ '/api/widget/summary': req => (req.headers['x-api-key'] === 'ck' ? fixture('clonarr-summary') : { status: 401 }) });
  t.after(() => full.close());
  const r = await c.clonarr({ url: full.url, apiKey: 'ck' });
  assert.equal(r.data.stats.withErrors, 1);
  assert.match(r.data.events[0].message, /custom format rejected/);
  const old = await fakeServer({ '/api/health': { ok: true } });
  t.after(() => old.close());
  const r2 = await c.clonarr({ url: old.url });
  assert.equal(r2.data.limited, true);
});

test('ping: 401 still counts as up, 5xx is down', async t => {
  const srv = await fakeServer({ '/up': { status: 401 }, '/down': { status: 503 } });
  t.after(() => srv.close());
  assert.ok(await c.ping({ url: `${srv.url}/up` }));
  await assert.rejects(c.ping({ url: `${srv.url}/down` }));
});

test('truenas: logs in over wss with the key, reuses the connection, maps pools, disks, alerts, apps', async t => {
  const big = 'x'.repeat(70000); // forces the 64-bit frame length path
  const nas = await fakeTrueNAS({
    __users: { mediaops: 'tn-key' },
    'system.info': { version: 'TrueNAS-SCALE-25.10.1', hostname: 'nas', padding: big },
    'pool.query': [
      { name: 'tank', status: 'DEGRADED', healthy: false, size: 100, allocated: 85, free: 15, scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 3, end_time: { $date: 1790000000000 } } },
      { name: 'apps', status: 'ONLINE', healthy: true, size: 10, allocated: 1, free: 9, scan: null },
    ],
    'disk.query': [{ name: 'sda', type: 'HDD', size: 18e12, pool: 'tank', serial: 'SECRET123' }, { name: 'nvme0n1', type: 'SSD', size: 2e12, pool: 'apps' }],
    'disk.temperatures': ([names]) => Object.fromEntries(names.map(n => [n, n === 'sda' ? 56 : 41])),
    'alert.list': [
      { level: 'CRITICAL', klass: 'VolumeStatus', formatted: 'Pool tank state is <b>DEGRADED</b>', dismissed: false },
      { level: 'WARNING', klass: 'Update', text: 'Update available', dismissed: true },
      { level: 'INFO', klass: 'Info', text: 'fyi', dismissed: false },
    ],
    'app.query': [{ name: 'plex', state: 'RUNNING', upgrade_available: true }, { name: 'bazarr', state: 'CRASHED' }],
  });
  t.after(() => nas.close());
  const cfg = { url: nas.url, username: 'mediaops', apiKey: 'tn-key' };
  const r = await c.truenas(cfg);
  assert.equal(r.version, '25.10.1');
  assert.equal(r.data.server, 'nas');
  assert.deepEqual(r.data.capacity, { total: 110, used: 86 });
  assert.equal(r.data.pools[0].scan.end, 1790000000000);
  const sda = r.data.disks.find(d => d.name === 'sda');
  assert.deepEqual([sda.temp, sda.role, sda.ssd], [56, 'tank', false]);
  assert.equal(r.data.disks.find(d => d.name === 'nvme0n1').tempWarn, 60, 'SSD limits');
  const msgs = r.data.events.map(e => `${e.level} ${e.source} ${e.message}`);
  assert.ok(msgs.includes('error TrueNAS Pool tank state is DEGRADED'), 'alert HTML stripped');
  assert.ok(!msgs.some(m => /Pool tank is degraded/.test(m)), "no duplicate when TrueNAS already alerts on the pool");
  assert.ok(msgs.includes('warn Pool Last scrub of tank found 3 errors'));
  assert.ok(msgs.includes('error Pool Disk sda is critically hot'));
  assert.ok(msgs.includes('error Apps App bazarr has crashed'));
  assert.ok(!msgs.some(m => /Update available|fyi/.test(m)), 'dismissed and info alerts skipped');
  assert.equal(r.data.alerts, 1);

  await c.truenas(cfg);
  assert.equal(nas.state.logins, 1, 'connection reused between polls');
  nas.dropConnections();
  await new Promise(res => setTimeout(res, 50));
  await c.truenas(cfg);
  assert.equal(nas.state.logins, 2, 'reconnects after the connection drops');

  // Diagnostics: own connection, calls recorded, key and serial numbers never in the report.
  const store = { calls: [] };
  await trace.run(store, () => c.truenas(cfg));
  assert.ok(store.calls.some(x => x.url.endsWith('· pool.query') && x.status === 'ok'));
  assert.ok(!store.calls.some(x => /login/.test(x.url)), 'login call not recorded');
  assert.ok(!JSON.stringify(store.calls).includes('tn-key') && !JSON.stringify(store.calls).includes('SECRET123'));
});

test('truenas: wrong key gives a clear error', async t => {
  const nas = await fakeTrueNAS({ __users: { mediaops: 'right' } });
  t.after(() => nas.close());
  await assert.rejects(c.truenas({ url: nas.url, username: 'mediaops', apiKey: 'wrong' }), /refused the API key/);
});

test('truenas: a changed certificate is refused before the key is sent; Test/Save trusts the new one', async t => {
  const pins = require('../lib/pins');
  const nas = await fakeTrueNAS({ __users: { u: 'k' }, 'system.info': { version: '25.10', hostname: 'nas' }, 'pool.query': [], 'disk.query': [] });
  t.after(() => nas.close());
  const cfg = { url: nas.url, username: 'u', apiKey: 'k2' }; // own key = own connection
  nas.state.calls.length = 0;
  pins.forget(nas.url);
  pins.check(pins.keyOf(nas.url), 'AA:BB:CC'); // as if the first-seen certificate were a different one
  await assert.rejects(c.truenas(cfg), /certificate has changed/);
  assert.ok(!nas.state.calls.includes('auth.login_ex'), 'the API key was never sent');
  pins.forget(nas.url); // what Test / Save in Settings does
  await assert.rejects(c.truenas(cfg), /refused the API key/, 'now it connects (and this key is wrong on purpose)');
  assert.ok(nas.state.calls.includes('auth.login_ex'));
});
