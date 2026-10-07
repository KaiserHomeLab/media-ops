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
  if (url.includes('203.0.113.9')) return '<location city="Chicago" subdivisions="Illinois" country="United States" code="US" coordinates="41.85, -87.65"/>';
  if (url.includes('198.51.100.7')) return '<location city="London" country="United Kingdom" code="GB" coordinates="51.5, -0.12"/>';
  throw new Error('HTTP 404');
};

const config = require('../lib/config');
const feed = require('../lib/events');
const notify = require('../lib/notify');
const history = require('../lib/history');
const geo = require('../lib/geo');
const recovery = require('../lib/recovery');

const svc = (id, up, extra = {}) => ({ id, name: id, kind: 'sonarr', up, error: up ? undefined : 'Connection refused', data: up ? { health: [], events: [], ...extra } : undefined });

test('errors feed: live conditions first, dismissals stick, cleared conditions are forgotten', () => {
  const now = new Date().toISOString();
  let services = [
    svc('a', true, { health: [{ type: 'warning', message: 'Indexer down' }], events: [{ time: now, level: 'error', source: 'Import', message: 'denied' }] }),
    svc('b', false),
  ];
  let events = feed.collect(services);
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).source, 'Import', 'live conditions (health, unreachable) come before log lines');
  assert.ok(events.slice(0, 2).every(e => e.live));
  let state = feed.dismiss(feed.emptyState(), events, { keys: [events.find(e => e.healthCheck).key] });
  let applied = feed.apply(feed.collect(services), services, state);
  assert.equal(applied.events.find(e => e.healthCheck).dismissed, true);
  assert.equal(applied.changed, null, 'nothing to prune while the warning is still there');
  // The warning clears -> its dismissal is forgotten, so it shows again if it ever comes back.
  services = [svc('a', true, { events: [{ time: now, level: 'error', source: 'Import', message: 'denied' }] }), svc('b', false)];
  applied = feed.apply(feed.collect(services), services, state);
  assert.equal(applied.changed.items.length, 0);
  // Dismiss everything from one app: watermark hides its log lines.
  state = feed.dismiss(feed.emptyState(), applied.events, { svcId: 'a' });
  assert.ok(feed.apply(feed.collect(services), services, state).events.filter(e => e.svcId === 'a').every(e => e.dismissed));
});

test('notifications: no flood on start, down after 2 fails, back up, new errors, disk threshold', async t => {
  const got = [];
  const srv = await fakeServer({ 'POST /hook': (req, url, body) => { got.push(JSON.parse(body)); return {}; } });
  t.after(() => srv.close());
  const cfg = { notifications: { diskThreshold: 90, targets: [notify.mergeTarget(null, { type: 'webhook', url: `${srv.url}/hook` })] } };
  const disks = pct => [{ path: '/mnt/user', total: 100, free: 100 - pct }];
  const raw = (up, events = []) => ({ services: [svc('sonarr', up, { events })] });
  const run = async (r, d = disks(50)) => notify.handle(r, feed.collect(r.services), d, cfg);

  await run(raw(true, [{ time: new Date(Date.now() - 60e3).toISOString(), level: 'error', source: 'X', message: 'old' }]));
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
  assert.throws(() => notify.mergeTarget(null, { type: 'gotify', url: 'ftp://x', appToken: 'a' }), /must start with http/);
});

test('history: uptime cells and disk forecast', () => {
  const svcs = [{ id: 's', up: true }, { id: 'd', up: false }];
  for (let i = 0; i < 4; i++) history.record({ services: svcs, disks: [] });
  assert.equal(history.uptime('s').day, 1);
  assert.equal(history.uptime('d').day, 0);
  assert.equal(history.uptime('s').cells.length, 48);
  assert.equal(history.forecast('/nope').status, 'collecting');
});

test('geo: remote viewers located via plex.tv, private IPs never looked up, IPs stripped', async () => {
  const results = [{ kind: 'plex', id: 'p', up: true, data: { streams: [
    { local: false, ip: '198.51.100.7' },
    { local: false, ip: '100.100.1.1', publicIp: '198.51.100.7' }, // Tailscale -> falls back to public
    { local: true, ip: '192.168.1.5' },
  ] } }];
  await geo.enrich(results, { services: [{ id: 'p', url: 'http://pms', token: 't' }], map: {} });
  const [a, b, c] = results[0].data.streams;
  assert.equal(a.geo.city, 'London');
  assert.equal(b.geo.city, 'London');
  assert.equal(c.geo, null);
  assert.ok(results[0].data.streams.every(s => !('ip' in s) && !('publicIp' in s)));
  assert.equal(results[0].data.home.city, 'Chicago');
  assert.ok(!geoCalls.some(u => /192\.168|100\.100/.test(u)));
});

test('settings: blank API key keeps the saved one; secrets never public', () => {
  const s = config.mergeService(null, { kind: 'sonarr', url: 'http://10.0.0.2:8989/', apiKey: 'abc' });
  assert.equal(s.url, 'http://10.0.0.2:8989');
  const edited = config.mergeService(s, { url: 'http://10.0.0.3:8989', apiKey: '' });
  assert.equal(edited.apiKey, 'abc');
  assert.deepEqual(Object.keys(config.publicService(edited)).includes('apiKey'), false);
  assert.throws(() => config.mergeService(null, { kind: 'sonarr', url: '10.0.0.2:8989', apiKey: 'x' }), /http/);
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
  const out = JSON.stringify(http.redactValue({
    apiKey: 'k', token: 't', Player: { address: '1.2.3.4', title: 'TV' }, User: { title: 'alice' },
    requestedBy: { displayName: 'bob', email: 'b@x' }, friendly_name: 'carol', title: 'Dune',
  }));
  for (const secret of ['"k"', '"t"', '1.2.3.4', 'alice', 'bob', 'b@x', 'carol']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('Dune') && out.includes('TV'), 'ordinary fields kept');
});
