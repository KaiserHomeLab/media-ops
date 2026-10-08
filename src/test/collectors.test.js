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
    '/library/sections/2/all': (req, url) => ({
      MediaContainer: { size: 0, totalSize: url.searchParams.get('type') === '4' ? 18733 : 412 },
    }),
    '/library/sections/3/all': (req, url) => ({
      MediaContainer: { size: 0, totalSize: { 9: 4210, 10: 51288 }[url.searchParams.get('type')] ?? 1307 },
    }),
    '/library/recentlyAdded': {
      MediaContainer: {
        Metadata: [
          { ratingKey: '1', type: 'movie', title: 'M*A*S*H', year: 1970, addedAt: 4039401600 }, // corrupt: year 2098
          { ratingKey: '2', type: 'movie', title: 'Dune', year: 2021, addedAt: Math.floor(Date.now() / 1000) - 3600 },
        ],
      },
    },
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
  assert.deepEqual(
    r.data.recentlyAdded.map(m => m.title),
    ['Dune'],
    'future-dated items skipped',
  );
});

test('sonarr: stats, queue warning becomes an event, logs filtered to warn+', async t => {
  const srv = await fakeServer(
    arrRoutes('/api/v3', {
      '/api/v3/series': fixture('sonarr-series'),
      '/api/v3/queue': fixture('sonarr-queue'),
      '/api/v3/wanted/missing': { totalRecords: 7 },
      '/api/v3/calendar': fixture('sonarr-calendar'),
    }),
  );
  t.after(() => srv.close());
  clearCache();
  const r = await c.sonarr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(r.data.stats, {
    series: 3,
    monitored: 2,
    continuing: 2,
    episodes: 48,
    missing: 7,
    size: 150_000_000_000,
  });
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
  assert.equal(
    srv.calls.filter(x => x.path === '/api/v3/series').length,
    before,
    'full series list cached between polls',
  );
});

test('radarr: missing counts only monitored + available', async t => {
  const srv = await fakeServer(
    arrRoutes('/api/v3', {
      '/api/v3/movie': fixture('radarr-movies'),
      '/api/v3/queue': { records: [] },
      '/api/v3/calendar': [],
    }),
  );
  t.after(() => srv.close());
  clearCache();
  const r = await c.radarr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(r.data.stats, { movies: 3, monitored: 3, onDisk: 1, missing: 1, size: 60_000_000_000 });
});

test('sabnzbd: speed, queue, failed history and warnings as events', async t => {
  const srv = await fakeServer({
    '/api': (req, url) =>
      ({
        queue: fixture('sab-queue'),
        server_stats: fixture('sab-stats'),
        warnings: fixture('sab-warnings'),
        history: fixture('sab-history-failed'),
      })[url.searchParams.get('mode')],
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.sabnzbd({ url: srv.url, apiKey: 'k' });
  assert.equal(r.version, '4.5.1');
  assert.equal(r.data.downBps, 2048 * 1024);
  assert.equal(r.data.items[0].progress, 0.74);
  assert.deepEqual(
    r.data.events.map(e => [e.source, e.level]),
    [
      ['Warnings', 'warn'],
      ['Failed download', 'error'],
    ],
  );
});

test('qbittorrent: logs in, reuses the session, renews it on 403', async t => {
  let logins = 0,
    sid = 'one';
  const srv = await fakeServer({
    'POST /api/v2/auth/login': (req, url, body) => {
      logins++;
      assert.match(body, /username=admin/);
      if (!/password=pw\b/.test(body)) return { status: 200, body: 'Fails.' };
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
  await assert.rejects(c.qbittorrent({ ...cfg, password: 'wrong' }), /login failed/, 'other credentials log in afresh');
});

test('nzbget: queue, speed, failed downloads and log warnings, with basic auth', async t => {
  const results = {
    version: '25.4',
    status: { DownloadRate: 3_145_728, DownloadPaused: false },
    listgroups: [
      { NZBName: 'Show.S01E01', Status: 'DOWNLOADING', FileSizeMB: 1000, RemainingSizeMB: 250 },
      { NZBName: 'Movie.2024', Status: 'QUEUED', FileSizeMB: 4000, RemainingSizeMB: 4000 },
    ],
    history: [
      { Name: 'Old.Thing', Status: 'SUCCESS/ALL', HistoryTime: 1_760_000_000 },
      { Name: 'Broken.Thing', Status: 'FAILURE/UNPACK', HistoryTime: 1_760_000_100, Category: 'tv' },
    ],
    log: [
      { Kind: 'INFO', Time: 1_760_000_000, Text: 'Started' },
      { Kind: 'WARNING', Time: 1_760_000_200, Text: 'Server news.example.com: connection timed out' },
    ],
  };
  const srv = await fakeServer({
    'POST /jsonrpc': (req, url, body) => {
      if (req.headers.authorization !== `Basic ${Buffer.from('nzbget:pw').toString('base64')}`)
        return { status: 401, body: 'Unauthorized' };
      return { version: '1.1', result: results[JSON.parse(body).method] };
    },
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.nzbget({ url: srv.url, username: 'nzbget', password: 'pw' });
  assert.equal(r.version, '25.4');
  assert.equal(r.data.client, 'usenet');
  assert.equal(r.data.downBps, 3_145_728);
  assert.equal(r.data.status, 'Downloading');
  assert.equal(r.data.items[0].progress, 0.75);
  assert.equal(r.data.items[0].eta, Math.round((250 * 1048576) / 3_145_728));
  assert.equal(r.data.items[1].eta, null, 'no ETA for queued items');
  assert.deepEqual(
    r.data.events.map(e => [e.source, e.level, e.message]),
    [
      ['Log', 'warn', 'Server news.example.com: connection timed out'],
      ['Failed download', 'error', 'Broken.Thing: unpack failed'],
    ],
  );
  await assert.rejects(c.nzbget({ url: srv.url, username: 'nzbget', password: 'wrong' }), /HTTP 401/);
});

test('transmission: session-id handshake (409), torrents and tracker errors', async t => {
  let sessionId = 'abc';
  const methods = [];
  const srv = await fakeServer({
    'POST /transmission/rpc': (req, url, body) => {
      if (req.headers['x-transmission-session-id'] !== sessionId)
        return { status: 409, headers: { 'X-Transmission-Session-Id': sessionId }, body: '' };
      const { method } = JSON.parse(body);
      methods.push(method);
      const args = {
        'session-get': { version: '4.0.6 (38c164933e)' },
        'session-stats': {
          downloadSpeed: 500_000,
          uploadSpeed: 120_000,
          'cumulative-stats': { downloadedBytes: 1000, uploadedBytes: 2500 },
        },
        'torrent-get': {
          torrents: [
            { name: 'Done', percentDone: 1, status: 6, error: 0, rateDownload: 0 },
            { name: 'Slow', percentDone: 0.2, sizeWhenDone: 10, eta: -1, status: 4, rateDownload: 10, error: 0 },
            {
              name: 'Broken',
              percentDone: 0.5,
              status: 0,
              error: 3,
              errorString: 'No data found! Ensure your drives are connected',
              rateDownload: 0,
            },
          ],
        },
      }[method];
      return { result: 'success', arguments: args };
    },
  });
  t.after(() => srv.close());
  const cfg = { url: `${srv.url}/transmission/web/` };
  const r = await c.transmission(cfg);
  assert.equal(r.version, '4.0.6');
  assert.equal(r.data.client, 'torrent');
  assert.equal(r.data.ratio, 2.5);
  assert.deepEqual(
    r.data.items.map(i => [i.title, i.eta]),
    [
      ['Slow', null],
      ['Broken', null],
    ],
  );
  assert.deepEqual(r.data.states, { seeding: 1, downloading: 1, stopped: 1 });
  assert.deepEqual(
    r.data.events.map(e => [e.level, e.message, e.live]),
    [['error', 'Broken: No data found! Ensure your drives are connected', true]],
  );
  sessionId = 'def'; // Transmission restarted
  await c.transmission(cfg);
  assert.equal(methods.filter(m => m === 'session-get').length, 2, 'retried after a new 409');
});

test('deluge: logs in, connects the Web UI to its daemon, renews an expired session', async t => {
  let logins = 0,
    connected = false,
    valid = 'one';
  const srv = await fakeServer({
    'POST /json': (req, url, body) => {
      const { method, params, id } = JSON.parse(body);
      if (method === 'auth.login') {
        logins++;
        const ok = params[0] === 'deluge';
        return {
          status: 200,
          headers: ok ? { 'Set-Cookie': `_session_id=${valid}; Path=/json` } : {},
          body: JSON.stringify({ result: ok, error: null, id }),
        };
      }
      if (req.headers.cookie !== `_session_id=${valid}`)
        return { result: null, error: { message: 'Not authenticated', code: 1 }, id };
      if (method === 'web.connect') {
        connected = params[0] === 'h1';
        return { result: null, error: null, id };
      }
      const result = {
        'web.connected': connected,
        'web.get_hosts': [['h1', '127.0.0.1', 58846, 'localclient']],
        'daemon.info': '2.1.1',
        'web.update_ui': {
          stats: { download_rate: 2048, upload_rate: 512, free_space: 1e12 },
          torrents: {
            a: { name: 'Seed', progress: 100, total_done: 100, total_uploaded: 300, state: 'Seeding' },
            b: {
              name: 'Get',
              progress: 40,
              total_wanted: 50,
              eta: 120,
              state: 'Downloading',
              download_payload_rate: 9,
            },
            c: { name: 'Bad', progress: 10, total_done: 0, state: 'Error', message: 'Disk full' },
          },
        },
      }[method];
      return { result, error: null, id };
    },
  });
  t.after(() => srv.close());
  const cfg = { url: srv.url, password: 'deluge' };
  const r = await c.deluge(cfg);
  assert.equal(connected, true, 'connected to the daemon');
  assert.equal(r.version, '2.1.1');
  assert.equal(r.data.ratio, 3);
  assert.deepEqual(
    r.data.items.map(i => [i.title, i.progress, i.eta]),
    [
      ['Get', 0.4, 120],
      ['Bad', 0.1, null],
    ],
  );
  assert.deepEqual(
    r.data.events.map(e => e.message),
    ['Bad: Disk full'],
  );
  await c.deluge(cfg);
  assert.equal(logins, 1, 'session reused');
  valid = 'two';
  await c.deluge(cfg);
  assert.equal(logins, 2, 'expired session renewed');
  await assert.rejects(c.deluge({ url: srv.url, password: 'nope' }), /login failed/);
});

test('jellyfin: streams with the transcode reason, libraries, recently added; API key in the header', async t => {
  const srv = await fakeServer({
    '/System/Info': req =>
      req.headers.authorization === 'MediaBrowser Token="k"'
        ? { Version: '10.11.2', HasUpdateAvailable: false }
        : { status: 401, body: '' },
    '/Sessions': fixture('jellyfin-sessions'),
    '/Library/VirtualFolders': [
      { Name: 'Movies', CollectionType: 'movies', ItemId: 'm1' },
      { Name: 'Shows', CollectionType: 'tvshows', ItemId: 't1' },
    ],
    '/Items': (req, url) => {
      const q = Object.fromEntries(url.searchParams);
      if (q.SortBy === 'DateCreated')
        return {
          Items: [
            {
              Id: 'e1',
              Type: 'Episode',
              Name: 'Pilot',
              SeriesName: 'Andor',
              SeriesId: 's9',
              ParentIndexNumber: 1,
              IndexNumber: 1,
              DateCreated: '2026-10-01T10:00:00Z',
            },
            { Id: 'm9', Type: 'Movie', Name: 'Sinners', ProductionYear: 2025, DateCreated: '2026-09-30T10:00:00Z' },
          ],
        };
      const counts = { 'm1:Movie': 812, 't1:Series': 64, 't1:Episode': 3120 };
      return { Items: [], TotalRecordCount: counts[`${q.ParentId}:${q.IncludeItemTypes}`] ?? 0 };
    },
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.jellyfin({ url: srv.url, apiKey: 'k' });
  assert.equal(r.version, '10.11.2');
  const [ep, movie] = r.data.streams;
  assert.equal(r.data.streams.length, 2, 'idle sessions are skipped');
  assert.equal(ep.title, 'Severance');
  assert.equal(ep.subtitle, 'S02E07 · Chikhai Bardo');
  assert.equal(ep.decision, 'Transcode');
  assert.equal(ep.reason, "client can't play HEVC → H264 · audio EAC3 → AAC");
  assert.equal(ep.fourKTranscode, true);
  assert.equal(ep.hw, true);
  assert.equal(ep.resolution, '4k');
  assert.equal(ep.offset, 1_260_000);
  assert.equal(ep.bandwidth, 12000);
  assert.equal(ep.local, true);
  assert.equal(ep.thumb, '/Items/22222222222222222222222222222222/Images/Primary', 'the series poster');
  assert.equal(movie.decision, 'Direct Play');
  assert.equal(movie.state, 'paused');
  assert.equal(movie.ip, '2001:db8::42', 'IPv6 endpoint with a port');
  assert.equal(movie.local, false);
  assert.equal(movie.bandwidth, 8256);
  assert.deepEqual(r.data.libraries, [
    { title: 'Movies', type: 'movie', count: 812 },
    { title: 'Shows', type: 'show', count: 64, episodes: 3120 },
  ]);
  assert.deepEqual(
    r.data.recentlyAdded.map(x => [x.title, x.sub, x.thumb]),
    [
      ['Andor', 'S01E01 · Pilot', '/Items/s9/Images/Primary'],
      ['Sinners', '2025', '/Items/m9/Images/Primary'],
    ],
  );
  await assert.rejects(c.jellyfin({ url: srv.url, apiKey: 'wrong' }), /HTTP 401/);
});

test('emby: same data, API key as X-Emby-Token', async t => {
  const seen = [];
  const srv = await fakeServer({
    '/System/Info': req => (seen.push(req.headers['x-emby-token']), { Version: '4.9.1.80', HasUpdateAvailable: true }),
    '/Sessions': [],
    '/Library/VirtualFolders': [],
    '/Items': { Items: [] },
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.emby({ url: srv.url, apiKey: 'k2' });
  assert.equal(r.version, '4.9.1.80');
  assert.deepEqual(r.data.update, { version: null }, 'update available');
  assert.deepEqual(seen, ['k2']);
});

test('tautulli: home stats and plays by date', async t => {
  const srv = await fakeServer({
    '/api/v2': (req, url) => ({
      response: {
        result: 'success',
        data: {
          get_tautulli_info: { tautulli_version: 'v2.15.3' },
          get_home_stats: fixture('tautulli-home'),
          get_plays_by_date: fixture('tautulli-plays'),
          get_logs: [],
        }[url.searchParams.get('cmd')],
      },
    }),
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
  const full = await fakeServer({
    '/api/widget/summary': req => (req.headers['x-api-key'] === 'ck' ? fixture('clonarr-summary') : { status: 401 }),
  });
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

test('cloudflared: connections and version from metrics; public addresses checked through Cloudflare', async t => {
  const metrics = [
    '# HELP build_info Build and version information',
    'build_info{goversion="go1.24",revision="abc",type="",version="2026.9.1"} 1',
    'cloudflared_tunnel_ha_connections 4',
    'cloudflared_tunnel_total_requests 1834',
    'cloudflared_tunnel_request_errors 3',
    'cloudflared_tunnel_server_locations{connection_id="0",edge_location="dfw08"} 1',
    'cloudflared_tunnel_server_locations{connection_id="1",edge_location="iah01"} 1',
    'cloudflared_tunnel_server_locations{connection_id="2",edge_location="ord02"} 0',
  ].join('\n');
  const tunnel = await fakeServer({
    '/ready': { status: 200, body: '{"status":200,"readyConnections":4}' },
    '/metrics': metrics,
  });
  const site = await fakeServer({
    '/': { status: 302, headers: { Location: '/login' } }, // Seerr's login redirect: reachable
    '/gone': { status: 530, headers: { 'cf-ray': '1-DFW' }, body: 'error code: 1033' },
    '/app-down': { status: 502, headers: { 'cf-ray': '1-DFW' }, body: 'Bad gateway' },
  });
  t.after(() => (tunnel.close(), site.close()));

  const r = await c.cloudflared({
    url: tunnel.url,
    publicUrls: `${site.url}/, ${site.url}/gone\n${site.url}/app-down not-a-url http://127.0.0.1:1/`,
  });
  assert.equal(r.version, '2026.9.1');
  assert.equal(r.data.stats.connections, 4);
  assert.deepEqual(r.data.stats.locations, ['dfw08', 'iah01']);
  assert.equal(r.data.stats.requests, 1834);
  assert.deepEqual(
    r.data.public.map(p => [p.ok, p.problem]),
    [
      [true, undefined],
      [false, 'Cloudflare has no connected tunnel for this address'],
      [false, "the tunnel can't reach the app behind it"],
      [false, "it can't be reached"],
    ],
  );
  assert.equal(r.data.stats.publicOk, 1);
  assert.equal(r.data.stats.publicTotal, 4);
  // One live error per failing address, worded without changing numbers (event keys are hashes).
  assert.equal(r.data.events.filter(e => e.source === 'Public address' && e.live).length, 3);
  assert.match(r.data.note, /^4 connections to Cloudflare \(dfw08, iah01\)\./);

  // http:// → https:// on the same host is answered by Cloudflare's edge, not the tunnel, so it's
  // followed. (This fake has no TLS: the followed request fails, which shows it was made.) A
  // redirect anywhere else, like Seerr's to /login, counts as loading.
  const edge = await fakeServer({
    '/upgrade': req => ({ status: 301, headers: { Location: `https://${req.headers.host}/upgrade` } }),
    '/login-redirect': { status: 307, headers: { Location: '/login' } },
  });
  t.after(() => edge.close());
  const r3 = await c.cloudflared({ url: tunnel.url, publicUrls: `${edge.url}/upgrade ${edge.url}/login-redirect` });
  assert.deepEqual(
    r3.data.public.map(p => [p.ok, p.status]),
    [
      [false, null],
      [true, 307],
    ],
  );

  // No connections: the tunnel is down.
  const off = await fakeServer({ '/ready': { status: 503, body: '{"status":503,"readyConnections":0}' } });
  t.after(() => off.close());
  await assert.rejects(c.cloudflared({ url: off.url }), /not connected to Cloudflare/);
  // An older cloudflared without /ready: the connection count from /metrics decides.
  const old = await fakeServer({ '/metrics': 'cloudflared_tunnel_ha_connections 1' });
  t.after(() => old.close());
  const r2 = await c.cloudflared({ url: old.url });
  assert.equal(r2.data.stats.connections, 1);
  assert.match(r2.data.events[0].message, /only one connection/);
});

test('truenas websocket: text outside ASCII is framed by its length in bytes', async t => {
  const rpc = require('../lib/jsonrpc-ws');
  const nas = await fakeTrueNAS({ __users: { u: 'k' }, 'core.echo': params => params });
  t.after(() => nas.close());
  const conn = await rpc.connect('127.0.0.1', Number(new URL(nas.url).port));
  t.after(() => conn.close());
  await conn.call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: 'u', api_key: 'k' }]);
  const text = 'Café Tönnies · 名前 ✓'; // 4 more bytes than characters, and more
  assert.deepEqual(await conn.call('core.echo', [text]), [text]);
});

test('truenas: logs in over wss with the key, reuses the connection, maps pools, disks, alerts, apps', async t => {
  const big = 'x'.repeat(70000); // forces the 64-bit frame length path
  const nas = await fakeTrueNAS({
    __users: { mediaops: 'tn-key' },
    'system.info': { version: 'TrueNAS-SCALE-25.10.1', hostname: 'nas', padding: big },
    'pool.query': [
      {
        name: 'tank',
        status: 'DEGRADED',
        healthy: false,
        size: 100,
        allocated: 85,
        free: 15,
        scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 3, end_time: { $date: 1790000000000 } },
      },
      { name: 'apps', status: 'ONLINE', healthy: true, size: 10, allocated: 1, free: 9, scan: null },
    ],
    'disk.query': [
      { name: 'sda', type: 'HDD', size: 18e12, pool: 'tank', serial: 'SECRET123' },
      { name: 'nvme0n1', type: 'SSD', size: 2e12, pool: 'apps' },
    ],
    'disk.temperatures': ([names]) => Object.fromEntries(names.map(n => [n, n === 'sda' ? 56 : 41])),
    'alert.list': [
      { level: 'CRITICAL', klass: 'VolumeStatus', formatted: 'Pool tank state is <b>DEGRADED</b>', dismissed: false },
      { level: 'WARNING', klass: 'Update', text: 'Update available', dismissed: true },
      { level: 'INFO', klass: 'Info', text: 'fyi', dismissed: false },
    ],
    'app.query': [
      { name: 'plex', state: 'RUNNING', upgrade_available: true },
      { name: 'bazarr', state: 'CRASHED' },
    ],
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
  assert.ok(!msgs.some(m => /Pool tank is degraded/.test(m)), 'no duplicate when TrueNAS already alerts on the pool');
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
  const nas = await fakeTrueNAS({
    __users: { u: 'k' },
    'system.info': { version: '25.10', hostname: 'nas' },
    'pool.query': [],
    'disk.query': [],
  });
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

test('truenas: alert HTML becomes plain text, with no stray angle brackets left', () => {
  const { stripHtml } = require('../lib/collectors/truenas');
  assert.equal(
    stripHtml('Pool <b>tank</b> is <i>DEGRADED</i>.<br>Replace disk sda.'),
    'Pool tank is DEGRADED. Replace disk sda.',
  );
  assert.equal(stripHtml('a&nbsp;b'), 'a b');
  for (const tricky of ['<scr<script>ipt>alert(1)</script>', '<<b>img src=x onerror=alert(1)>', 'x < y > z'])
    assert.doesNotMatch(stripHtml(tricky), /[<>]/, tricky);
});
