// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The logic that doesn't talk to apps directly: errors feed + dismissals, notification rules,
// history/forecast, geo lookups, password recovery, settings merging and redaction.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dir, fakeServer } = require('./helpers');

// Stub plex.tv for lib/geo.js before it's loaded (it captures `req` at require time).
const http = require('../lib/http');
const realReq = http.req;
const geoCalls = [];
http.req = async (url, opts) => {
  if (!String(url).includes('plex.tv') && !String(url).includes('/myplex/account')) return realReq(url, opts);
  geoCalls.push(url);
  if (url.includes('/myplex/account')) return '<MyPlex publicAddress="203.0.113.9"/>';
  if (url.includes('203.0.113.9'))
    return '<location city="Chicago" subdivisions="Illinois" country="United States" code="US" coordinates="41.85, -87.65"/>';
  if (url.includes('198.51.100.7'))
    return '<location city="London" country="United Kingdom" code="GB" coordinates="51.5, -0.12"/>';
  if (url.includes('198.51.100.66')) return '<location city="Unknown" country="" code="" coordinates="0.0, 0.0"/>';
  throw new Error('HTTP 404');
};

const config = require('../lib/config');
const feed = require('../lib/events');
const notify = require('../lib/notify');
const history = require('../lib/history');
const geo = require('../lib/geo');
const recovery = require('../lib/recovery');

const svc = (id, up, extra = {}) => ({
  id,
  name: id,
  kind: 'sonarr',
  up,
  error: up ? undefined : 'Connection refused',
  data: up ? { health: [], events: [], ...extra } : undefined,
});

test('errors feed: live conditions first, dismissals stick, cleared conditions are forgotten', () => {
  const now = new Date().toISOString();
  let services = [
    svc('a', true, {
      health: [{ type: 'warning', message: 'Indexer down' }],
      events: [{ time: now, level: 'error', source: 'Import', message: 'denied' }],
    }),
    svc('b', false),
  ];
  const events = feed.collect(services);
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).source, 'Import', 'live conditions (health, unreachable) come before log lines');
  assert.ok(events.slice(0, 2).every(e => e.live));
  let state = feed.dismiss(feed.emptyState(), events, { keys: [events.find(e => e.healthCheck).key] });
  let applied = feed.apply(feed.collect(services), services, state);
  assert.equal(applied.events.find(e => e.healthCheck).dismissed, true);
  assert.equal(applied.changed, null, 'nothing to prune while the warning is still there');
  // The warning clears -> its dismissal is forgotten, so it shows again if it ever comes back.
  services = [
    svc('a', true, { events: [{ time: now, level: 'error', source: 'Import', message: 'denied' }] }),
    svc('b', false),
  ];
  applied = feed.apply(feed.collect(services), services, state);
  assert.equal(applied.changed.items.length, 0);
  // Dismiss everything from one app: watermark hides its log lines.
  state = feed.dismiss(feed.emptyState(), applied.events, { svcId: 'a' });
  assert.ok(
    feed
      .apply(feed.collect(services), services, state)
      .events.filter(e => e.svcId === 'a')
      .every(e => e.dismissed),
  );
});

test('notifications: no flood on start, down after 2 fails, back up, new errors, disk threshold', async t => {
  const got = [];
  const srv = await fakeServer({
    'POST /hook': (req, url, body) => {
      got.push(JSON.parse(body));
      return {};
    },
  });
  t.after(() => srv.close());
  const cfg = {
    notifications: {
      diskThreshold: 90,
      targets: [notify.mergeTarget(null, { type: 'webhook', url: `${srv.url}/hook` })],
    },
  };
  const disks = pct => [{ path: '/mnt/user', total: 100, free: 100 - pct }];
  const raw = (up, events = []) => ({ services: [svc('sonarr', up, { events })] });
  const run = async (r, d = disks(50)) => notify.handle(r, feed.collect(r.services), d, cfg);

  await run(
    raw(true, [{ time: new Date(Date.now() - 60e3).toISOString(), level: 'error', source: 'X', message: 'old' }]),
  );
  assert.equal(got.length, 0, 'first poll only learns');
  await run(raw(false));
  assert.equal(got.length, 0, 'one failed poll is not an outage');
  await run(raw(false));
  assert.match(got.at(-1).message, /sonarr is down/);
  await run(raw(true));
  assert.match(got.at(-1).message, /back up/);
  await run(raw(true, [{ time: new Date().toISOString(), level: 'error', source: 'Import', message: 'disk full' }]));
  assert.match(got.at(-1).message, /disk full/);
  await run(raw(true), disks(95));
  assert.match(got.at(-1).message, /95% full/);
  const before = got.length;
  await run(raw(true), disks(95));
  assert.equal(got.length, before, 'disk warning fires once, not every poll');
});

test('notification targets: blank secret keeps the saved one; bad URLs rejected', () => {
  const t = notify.mergeTarget(null, { type: 'discord', webhookUrl: 'https://discord.example/hook' });
  const edited = notify.mergeTarget(t, { name: 'Renamed', webhookUrl: '' });
  assert.equal(edited.webhookUrl, 'https://discord.example/hook');
  assert.equal(notify.publicTarget(edited).webhookUrl, undefined);
  assert.equal(notify.publicTarget(edited).webhookUrlSaved, true);
  assert.throws(
    () => notify.mergeTarget(null, { type: 'gotify', url: 'ftp://x', appToken: 'a' }),
    /must start with http/,
  );
  const g = notify.mergeTarget(null, { type: 'gotify', url: 'http://gotify.lan', appToken: 'tok' });
  assert.equal(notify.mergeTarget(g, { name: 'x', url: 'http://gotify.lan', appToken: '' }).appToken, 'tok');
  assert.throws(() => notify.mergeTarget(g, { url: 'http://evil.example', appToken: '' }), /Re-enter the App token/);
});

test('history: uptime cells and disk forecast', () => {
  const svcs = [
    { id: 's', up: true },
    { id: 'd', up: false },
  ];
  for (let i = 0; i < 4; i++) history.record({ services: svcs, disks: [] });
  assert.equal(history.uptime('s').day, 1);
  assert.equal(history.uptime('d').day, 0);
  assert.equal(history.uptime('s').cells.length, 48);
  assert.equal(history.forecast('/nope').status, 'collecting');
});

test('geo: remote viewers located via plex.tv, private IPs never looked up, IPs stripped', async () => {
  const results = [
    {
      kind: 'plex',
      id: 'p',
      up: true,
      data: {
        streams: [
          { local: false, ip: '198.51.100.7' },
          { local: false, ip: '100.100.1.1', publicIp: '198.51.100.7' }, // Tailscale -> falls back to public
          { local: true, ip: '192.168.1.5' },
        ],
      },
    },
  ];
  await geo.enrich(results, { services: [{ id: 'p', kind: 'plex', url: 'http://pms', token: 't' }], map: {} });
  const [a, b, c] = results[0].data.streams;
  assert.equal(a.geo.city, 'London');
  assert.equal(b.geo.city, 'London');
  assert.equal(c.geo, null);
  assert.ok(results[0].data.streams.every(s => !('ip' in s) && !('publicIp' in s)));
  assert.equal(results[0].data.home.city, 'Chicago');
  assert.ok(!geoCalls.some(u => /192\.168|100\.100/.test(u)));
});

test('geo: Jellyfin and Emby viewers are never sent to plex.tv; the home location can come from Plex; IPs always stripped', async () => {
  const jf = () => [
    { kind: 'jellyfin', id: 'j', up: true, data: { streams: [{ local: false, ip: '198.51.100.7' }] } },
    { kind: 'sonarr', id: 's', up: true, data: { streams: [{ ip: '198.51.100.8' }] } }, // anything with streams
  ];
  let results = jf();
  await geo.enrich(results, { services: [{ id: 'j', kind: 'jellyfin' }], map: { home: '41.88, -87.63' } });
  assert.equal(results[0].data.streams[0].geo, null, 'no Plex: no lookup');
  assert.equal(results[0].data.home.manual, true, 'typed-in home location still used');
  assert.ok(
    results.every(r => r.data.streams.every(st => !('ip' in st))),
    'IPs stripped everywhere',
  );
  results = jf();
  const before = geoCalls.length;
  await geo.enrich(results, {
    services: [
      { id: 'j', kind: 'jellyfin' },
      { id: 'p', kind: 'plex', url: 'http://pms', token: 't' },
    ],
    map: {},
  });
  assert.equal(results[0].data.streams[0].geo, null, 'a Jellyfin viewer is not looked up');
  assert.ok(!geoCalls.slice(before).some(u => u.includes('198.51.100.7')), "the viewer's IP never went to plex.tv");
  assert.equal(results[0].data.home.city, 'Chicago', "the server's own location from Plex");
  results = jf();
  await geo.enrich(results, { services: [{ id: 'j', kind: 'jellyfin' }], map: { enabled: false } });
  assert.ok(!('ip' in results[0].data.streams[0]), 'stripped with the map off too');
});

test('geo: every viewer without a location says why; plex.tv "Unknown" at 0, 0 is not a location', async () => {
  const results = [
    {
      kind: 'plex',
      id: 'p',
      up: true,
      data: {
        streams: [
          { local: false, ip: '198.51.100.7' }, // London
          { local: false, ip: '198.51.100.66' }, // plex.tv: Unknown, 0, 0
          { local: false, ip: '100.100.1.1' }, // Tailscale, no public address
          { local: false, ip: '203.0.113.200' }, // plex.tv errors
          { local: true, ip: '192.168.1.5' },
        ],
      },
    },
    { kind: 'jellyfin', id: 'j', up: true, data: { streams: [{ local: false, ip: '198.51.100.7' }] } },
  ];
  await geo.enrich(results, {
    services: [
      { id: 'p', kind: 'plex', url: 'http://pms', token: 't' },
      { id: 'j', kind: 'jellyfin' },
    ],
    map: {},
  });
  const [london, zero, tailscale, broken, home] = results[0].data.streams;
  assert.equal(london.geo.city, 'London');
  assert.equal(zero.geo, null, 'not a dot at 0, 0');
  assert.equal(zero.geoWhy, 'no-location');
  assert.equal(tailscale.geoWhy, 'private');
  assert.equal(broken.geoWhy, 'failed');
  assert.equal(home.geoWhy, undefined, 'viewers at home need no reason');
  assert.equal(results[1].data.streams[0].geoWhy, 'not-plex');
  assert.deepEqual(geo.summary(), {
    remote: 5,
    located: 1,
    unknown: { 'no-location': 1, private: 1, failed: 1, 'not-plex': 1 },
  });
});

test('settings: blank API key keeps the saved one, but only for the same address; secrets never public', () => {
  const s = config.mergeService(null, { kind: 'sonarr', url: 'http://10.0.0.2:8989/', apiKey: 'abc' });
  assert.equal(s.url, 'http://10.0.0.2:8989');
  const renamed = config.mergeService(s, { name: 'Sonarr 4K', url: 'http://10.0.0.2:8989', apiKey: '' });
  assert.equal(renamed.apiKey, 'abc');
  assert.deepEqual(Object.keys(config.publicService(renamed)).includes('apiKey'), false);
  assert.throws(
    () => config.mergeService(s, { url: 'http://attacker.example:8989', apiKey: '' }),
    /Re-enter the API key/,
    'a saved key is never sent to a new address',
  );
  assert.equal(config.mergeService(s, { url: 'http://10.0.0.3:8989', apiKey: 'new' }).apiKey, 'new');
  assert.throws(() => config.mergeService(null, { kind: 'sonarr', url: '10.0.0.2:8989', apiKey: 'x' }), /http/);
  assert.throws(
    // eslint-disable-next-line no-script-url -- the link must be refused
    () => config.mergeService(null, { kind: 'sonarr', url: 'http://s', apiKey: 'x', link: 'javascript:alert(1)' }),
    /Link must start/,
  );
});

test('password recovery: code works once, wrong codes limited', () => {
  config.update(c => ({ ...c, auth: config.hashPassword('old-password') }));
  const log = [];
  const orig = console.log;
  console.log = m => log.push(String(m));
  recovery.request();
  console.log = orig;
  const code = /Reset code: (\S+)/.exec(log.join('\n'))[1];
  assert.ok(fs.existsSync(path.join(dir, 'password-reset.txt')));
  assert.match(recovery.verify('AAAA-BBBB'), /Wrong code \(4 tries left\)/);
  assert.equal(recovery.verify(code.toLowerCase().replace('-', '')), null, 'case and dash insensitive');
  assert.ok(!fs.existsSync(path.join(dir, 'password-reset.txt')), 'file removed after use');
  assert.match(recovery.verify(code), /No active code/);
});

test('redaction: keys, tokens, IPs and people never reach a debug report', () => {
  const out = JSON.stringify(
    http.redactValue({
      apiKey: 'k',
      token: 't',
      Player: { address: '1.2.3.4', title: 'TV' },
      User: { title: 'alice' },
      requestedBy: { displayName: 'bob', email: 'b@x' },
      friendly_name: 'carol',
      title: 'Dune',
    }),
  );
  for (const secret of ['"k"', '"t"', '1.2.3.4', 'alice', 'bob', 'b@x', 'carol'])
    assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('Dune') && out.includes('TV'), 'ordinary fields kept');
});

test('platform: names the host from the kernel release, HOST_OS wins', () => {
  const { detect } = require('../lib/platform');
  const id = (hint, rel) => detect(hint, rel).id;
  assert.equal(id('', '6.12.54-Unraid'), 'unraid');
  assert.equal(id(undefined, '6.12.15-production+truenas'), 'truenas');
  assert.equal(id('', '5.15.167.4-microsoft-standard-WSL2'), 'windows');
  assert.equal(id('', '6.10.14-linuxkit'), 'docker-desktop');
  assert.equal(id('', '6.11.6-orbstack-00281-g'), 'mac');
  assert.equal(id('', '4.4.302+'), 'synology');
  assert.equal(id('', '6.8.12-4-pve'), 'proxmox');
  assert.equal(id('', '6.8.0-45-generic'), 'linux');
  assert.equal(id('', '6.6.31+rpt-rpi-v8'), 'linux'); // Raspberry Pi, not Synology
  assert.equal(id('Unraid', '6.8.0-45-generic'), 'unraid');
  assert.equal(id('Synology', '5.10.55'), 'synology');
  assert.deepEqual(detect('', '5.15.167.4-microsoft-standard-WSL2'), { id: 'windows', label: 'Windows', vm: true });
  assert.equal(detect('', '6.12.54-Unraid').vm, false);
});

test('actions: ids from the browser must be whole numbers before they go into a URL', async () => {
  const actions = require('../lib/actions');
  const sonarr = { kind: 'sonarr', name: 'Sonarr', url: 'http://127.0.0.1:1', apiKey: 'k' };
  for (const bad of ['', null, '-1', '1e21', '1.5', '1/../2']) {
    await assert.rejects(actions.queueRemove(sonarr, bad), /Bad queue item/);
    await assert.rejects(actions.seerrRequest({ ...sonarr, kind: 'seerr' }, bad, 'approve'), /Bad request/);
  }
});

test('password check: async, and a broken hash in config.json fails closed instead of crashing', async () => {
  const auth = config.hashPassword('right-password');
  config.save({ ...config.load(), auth });
  assert.equal(await config.checkPassword('right-password'), true);
  assert.equal(await config.checkPassword('wrong'), false);
  config.save({ ...config.load(), auth: { salt: auth.salt, hash: 'abcd' } });
  assert.equal(await config.checkPassword('right-password'), false);
  config.save({ ...config.load(), auth: null });
});

test('geo: XML entities are decoded once (an escaped entity stays escaped)', () => {
  const { unescapeXml } = require('../lib/geo');
  assert.equal(unescapeXml('Saint-Jean &amp; Pierre'), 'Saint-Jean & Pierre');
  assert.equal(unescapeXml('&quot;A&quot; &lt;b&gt; it&#39;s &apos;x&apos;'), `"A" <b> it's 'x'`);
  assert.equal(unescapeXml('&amp;quot;'), '&quot;', 'not decoded twice');
  assert.equal(unescapeXml('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  assert.equal(unescapeXml(undefined), undefined);
});

test('docker discovery: recognises apps by image and picks how to reach them', () => {
  const { findApps, kindOfImage } = require('../lib/discover');
  assert.equal(kindOfImage('lscr.io/linuxserver/sonarr:latest'), 'sonarr');
  assert.equal(kindOfImage('ghcr.io/hotio/radarr:release@sha256:abc'), 'radarr');
  assert.equal(kindOfImage('binhex/arch-qbittorrentvpn'), null, 'unknown image');
  assert.equal(kindOfImage('binhex/arch-sabnzbd'), 'sabnzbd');
  assert.equal(kindOfImage('plexinc/pms-docker'), 'plex');
  assert.equal(kindOfImage('sha256:0123'), null);
  const net = (...names) => ({ Networks: Object.fromEntries(names.map(n => [n, {}])) });
  const containers = [
    {
      Id: 'abc123self0000',
      Names: ['/media-ops'],
      Image: 'ghcr.io/kaiserhomelab/media-ops',
      State: 'running',
      NetworkSettings: net('media'),
    },
    {
      Id: 's1',
      Names: ['/sonarr'],
      Image: 'lscr.io/linuxserver/sonarr',
      State: 'running',
      NetworkSettings: net('media'),
      Ports: [{ PrivatePort: 8989, PublicPort: 18989, Type: 'tcp' }],
    },
    {
      Id: 'r1',
      Names: ['/radarr'],
      Image: 'lscr.io/linuxserver/radarr',
      State: 'running',
      NetworkSettings: net('bridge'),
      Ports: [
        { PrivatePort: 7878, PublicPort: 7878, Type: 'tcp', IP: '0.0.0.0' },
        { PrivatePort: 7878, PublicPort: 7878, Type: 'tcp', IP: '::' },
      ],
    },
    {
      Id: 'p1',
      Names: ['/plex'],
      Image: 'plexinc/pms-docker',
      State: 'running',
      HostConfig: { NetworkMode: 'host' },
      NetworkSettings: net('host'),
    },
    {
      Id: 'q1',
      Names: ['/qbit'],
      Image: 'lscr.io/linuxserver/qbittorrent',
      State: 'exited',
      NetworkSettings: net('media'),
    },
    { Id: 'x1', Names: ['/nginx'], Image: 'nginx:alpine', State: 'running', NetworkSettings: net('media') },
    { Id: 'b1', Names: ['/bazarr'], Image: 'hotio/bazarr', State: 'running', NetworkSettings: net('bridge') },
  ];
  assert.deepEqual(findApps(containers, 'abc123self00'), [
    { kind: 'plex', label: 'Plex', container: 'plex', via: 'host', host: null, port: 32400 },
    { kind: 'radarr', label: 'Radarr', container: 'radarr', via: 'published', host: null, port: 7878 },
    { kind: 'sonarr', label: 'Sonarr', container: 'sonarr', via: 'network', host: 'sonarr', port: 8989 },
  ]);
  const notMe = findApps(containers, 'zzz');
  assert.equal(
    notMe.find(a => a.kind === 'sonarr').via,
    'published',
    'without our own container, only published ports',
  );
});

test('dashboard layout: only known rows and cards, every row placed, ids match index.html', () => {
  const layout = require('../lib/layout');
  const all = layout.BLOCKS.map(b => b.id);
  assert.deepEqual(layout.clean(null), { order: all, hidden: [] });
  const c = layout.clean({ order: ['system', 'nope', 'system', 'map'], hidden: ['host-card', 'x', 'host-card'] });
  assert.deepEqual(c.order.slice(0, 2), ['system', 'map']);
  assert.equal(c.order.length, all.length, 'rows missing from the saved order are added at the end');
  assert.deepEqual(c.hidden, ['host-card']);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const b of layout.BLOCKS) {
    const single = b.cards.length === 1;
    assert.match(html, new RegExp(`data-block="${b.id}"`), `row ${b.id} in index.html`);
    for (const card of b.cards) assert.match(html, new RegExp(`id="${card.id}"`), `card ${card.id} in index.html`);
    if (single)
      assert.match(html, new RegExp(`id="${b.cards[0].id}"[^>]*data-block="${b.id}"`), `${b.id} is the card itself`);
  }
});

test('stuck downloads: re-check at half the wait, replace at the end, 3 per app per hour, off by default', async () => {
  const autofix = require('../lib/autofix');
  const calls = [];
  const act = {
    queueRetry: async app => calls.push(['retry', app.id]),
    queueRemove: async (app, id) => {
      if (id === 99) throw new Error('HTTP 500');
      calls.push(['remove', app.id, id]);
    },
  };
  const item = id => ({
    id,
    title: `Show ${id}`,
    warning: true,
    status: 'importPending',
    messages: ['No files found'],
  });
  const raw = queue => ({ services: [{ id: 'son', kind: 'sonarr', name: 'Sonarr', up: true, data: { queue } }] });
  const services = [{ id: 'son', kind: 'sonarr', name: 'Sonarr', url: 'http://x', apiKey: 'k' }];
  const MIN = 60e3;
  const t0 = 1_000_000_000;

  // Off: tracked, never acted on.
  assert.deepEqual(await autofix.tick(raw([item(1)]), { services }, t0, act), []);
  assert.deepEqual(await autofix.tick(raw([item(1)]), { services }, t0 + 120 * MIN, act), []);
  assert.deepEqual(calls, []);

  const cfg = { services, autoFix: { enabled: true, minutes: 60 } };
  // Item 1 has been stuck since t0 (counted while off): replaced at once.
  let out = await autofix.tick(raw([item(1), item(2)]), cfg, t0 + 121 * MIN, act);
  assert.deepEqual(calls, [['remove', 'son', 1]]);
  assert.match(out[0].line, /^🔁 Sonarr: replaced Show 1 after 2 h stuck \(No files found\)$/);
  assert.equal(out[0].kind, 'downloads');

  // Item 2 (first seen now): one re-check at 30 min, nothing more until 60.
  calls.length = 0;
  await autofix.tick(raw([item(2)]), cfg, t0 + 151 * MIN, act);
  await autofix.tick(raw([item(2)]), cfg, t0 + 160 * MIN, act);
  assert.deepEqual(calls, [['retry', 'son']]);
  await autofix.tick(raw([item(2)]), cfg, t0 + 181 * MIN, act);
  assert.deepEqual(calls.at(-1), ['remove', 'son', 2]);

  // An item that clears on its own starts over if it comes back.
  calls.length = 0;
  await autofix.tick(raw([item(3)]), cfg, t0 + 200 * MIN, act);
  await autofix.tick(raw([]), cfg, t0 + 250 * MIN, act);
  await autofix.tick(raw([item(3)]), cfg, t0 + 265 * MIN, act);
  assert.deepEqual(calls, [], 'not replaced: the clock restarted');

  // At most 3 removals per app per hour (1 and 2 above were more than an hour ago).
  calls.length = 0;
  const many = [4, 5, 6, 7].map(item);
  await autofix.tick(raw(many), cfg, t0 + 300 * MIN, act);
  await autofix.tick(raw(many), cfg, t0 + 400 * MIN, act);
  assert.equal(calls.filter(c => c[0] === 'remove').length, 3);
  await autofix.tick(raw(many), cfg, t0 + 461 * MIN, act);
  assert.equal(calls.filter(c => c[0] === 'remove').length, 4, 'the fourth waits for room in the hour');

  // A failed removal is logged and waits a full period.
  calls.length = 0;
  await autofix.tick(raw([item(99)]), cfg, t0 + 500 * MIN, act);
  out = await autofix.tick(raw([item(99)]), cfg, t0 + 561 * MIN, act);
  assert.deepEqual(out, []);
  assert.equal(autofix.recent()[0].ok, false);
  assert.equal(autofix.recent()[0].error, 'HTTP 500');

  // Imports in progress and other apps are left alone.
  calls.length = 0;
  const busy = { ...item(8), status: 'importing' };
  await autofix.tick(raw([busy]), cfg, t0 + 600 * MIN, act);
  await autofix.tick(raw([busy]), cfg, t0 + 700 * MIN, act);
  assert.deepEqual(calls, []);
  assert.deepEqual(autofix.clean({ enabled: 1, minutes: 5 }), { enabled: true, minutes: 15 }, 'minutes clamped');
});

test('appearance: settings checked, logo must be a real PNG/JPEG/WebP, pages get the theme and an escaped title', () => {
  const appearance = require('../lib/appearance');
  assert.deepEqual(appearance.settingsOf({}), {
    theme: 'auto',
    accent: 'amber',
    title: '',
    statusTheme: 'auto',
    liveStrip: true,
    logo: null,
  });
  assert.deepEqual(appearance.clean({ theme: 'neon', accent: 'pink', title: ' Home ', statusTheme: 'light' }, null), {
    theme: 'auto',
    accent: 'amber',
    title: 'Home',
    statusTheme: 'light',
    liveStrip: true,
    logo: null,
  });
  assert.throws(() => appearance.clean({ title: '<script>' }, null), /can't contain/);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]).toString('base64');
  assert.equal(appearance.logoFrom(png).type, 'image/png');
  for (const bad of ['<svg onload="alert(1)"/>', '<html><script>x</script>', 'GIF89a……'])
    assert.throws(() => appearance.logoFrom(Buffer.from(bad).toString('base64')), /PNG, JPEG or WebP/, bad);
  assert.throws(() => appearance.logoFrom(Buffer.alloc(300 * 1024, 0xff).toString('base64')), /256 KB/);

  const html =
    '<html lang="en"><head><title>Media Ops</title></head><body><span class="logo" aria-hidden="true"></span><h1>Media Ops</h1><!--brand-logo--></body></html>';
  const cfg = {
    appearance: {
      theme: 'light',
      accent: 'teal',
      title: "Tom & Jerry's",
      statusTheme: 'dark',
      logo: appearance.logoFrom(png),
    },
  };
  const page = appearance.renderPage(html, cfg, 'dashboard');
  assert.match(page, /<html lang="en" data-theme="light" data-accent="teal">/);
  assert.match(page, /<title>Tom &amp; Jerry&#39;s<\/title>/);
  assert.match(page, /<h1>Tom &amp; Jerry&#39;s<\/h1>/);
  assert.match(page, /<img class="logo custom" src="\/branding\/logo\?v=[0-9a-f]{16}" alt="">/);
  assert.match(appearance.renderPage(html, cfg, 'status'), /data-theme="dark"/, 'the status page has its own theme');
  const noStrip = { appearance: { liveStrip: false } };
  assert.match(appearance.renderPage(html, noStrip, 'dashboard'), /<html lang="en" data-strip="off">/);
  assert.doesNotMatch(
    appearance.renderPage(html, noStrip, 'settings'),
    /data-strip/,
    'only the dashboard has the strip',
  );
  assert.equal(
    appearance.renderPage(html, {}, 'dashboard'),
    html.replace('<!--brand-logo-->', ''),
    'defaults change nothing',
  );

  // The swatches' colors are the ones in the stylesheet.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  for (const a of appearance.ACCENTS) {
    const block =
      a.id === 'amber'
        ? css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
        : css.slice(css.indexOf(`:root[data-accent='${a.id}']`)).split('}')[0];
    assert.match(block, new RegExp(`--accent-dark: ${a.dark};`), `${a.id} dark`);
    assert.match(block, new RegExp(`--accent-light: ${a.light};`), `${a.id} light`);
  }
});

test('metrics: Prometheus text with escaped labels, nothing private, bearer token checked', () => {
  const metrics = require('../lib/metrics');
  const raw = {
    generatedAt: 1_760_000_000_000,
    host: { cpu: 25, memTotal: 1000, memUsed: 400 },
    services: [
      {
        id: 'p',
        kind: 'plex',
        name: 'Plex "Main"',
        up: true,
        latency: 20,
        url: 'http://192.0.2.9:32400',
        data: {
          streams: [
            { decision: 'Transcode', local: false, bandwidth: 8000, user: 'casey', ip: '198.51.100.7' },
            { decision: 'Direct Play', local: true, bandwidth: 20000, user: 'alex' },
          ],
        },
      },
      {
        id: 's',
        kind: 'sonarr',
        name: 'Sonarr',
        up: true,
        latency: 15,
        data: { queue: [{}, {}], stats: { missing: 12 }, update: { version: '4.1' } },
      },
      {
        id: 'q',
        kind: 'qbittorrent',
        name: 'qBit\\',
        up: true,
        latency: 5,
        data: { client: 'torrent', downBps: 100, upBps: 50, items: [{}] },
      },
      { id: 'r', kind: 'radarr', name: 'Radarr', up: false, error: 'Connection refused' },
    ],
  };
  const events = [
    { level: 'error', t: Date.now() },
    { level: 'warn', t: Date.now() },
    { level: 'error', t: Date.now(), dismissed: true },
  ];
  const text = metrics.render(raw, events, [{ path: '/mnt/user', total: 1000, free: 250 }]);
  const has = line => assert.ok(text.split('\n').includes(line), `missing: ${line}`);
  has('media_ops_app_up{app="Plex \\"Main\\"",kind="plex"} 1');
  has('media_ops_app_up{app="Radarr",kind="radarr"} 0');
  has('media_ops_app_latency_seconds{app="Sonarr",kind="sonarr"} 0.015');
  has('media_ops_app_update_available{app="Sonarr",kind="sonarr"} 1');
  has('media_ops_arr_queue_items{app="Sonarr",kind="sonarr"} 2');
  has('media_ops_arr_missing{app="Sonarr",kind="sonarr"} 12');
  has('media_ops_download_bytes_per_second{client="qBit\\\\",protocol="torrent"} 100');
  has('media_ops_streams{server="Plex \\"Main\\"",decision="transcode"} 1');
  has('media_ops_streams{server="Plex \\"Main\\"",decision="direct_stream"} 0');
  has('media_ops_stream_bandwidth_bits_per_second{server="Plex \\"Main\\"",location="wan"} 8000000');
  has('media_ops_events{level="error"} 1');
  has('media_ops_events{level="warning"} 1');
  has('media_ops_disk_used_bytes{path="/mnt/user"} 750');
  has('media_ops_host_cpu_ratio 0.25');
  assert.match(text, /^# HELP media_ops_info .*\n# TYPE media_ops_info gauge\n/m);
  assert.doesNotMatch(text, /192\.0\.2|198\.51|casey|alex|refused/, 'no addresses, viewers or error text');
  assert.equal(
    metrics
      .render(null, [], [])
      .split('\n')
      .filter(l => l && !l.startsWith('#')).length,
    3,
    'only info and event counts before the first poll',
  );

  const cfg = { metrics: { enabled: true, token: 'abc123' } };
  assert.equal(metrics.authorized('Bearer abc123', cfg), true);
  assert.equal(metrics.authorized('bearer abc123', cfg), true);
  for (const bad of [undefined, '', 'Bearer abc124', 'Bearer abc12', 'Basic abc123', 'abc123'])
    assert.equal(metrics.authorized(bad, cfg), false, String(bad));
  assert.equal(
    metrics.authorized('Bearer ', { metrics: { enabled: true, token: '' } }),
    false,
    'no token set: nothing passes',
  );
});
