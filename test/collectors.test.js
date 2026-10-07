// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Each collector against a fake app answering with recorded-style API replies (test/fixtures).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, fakeServer } = require('./helpers');
const c = require('../lib/collectors');
const { clearCache } = require('../lib/http');

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
