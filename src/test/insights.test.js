// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// "What's using space", indexer limits, update checks and how-to-fix hints.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer } = require('./helpers');
const c = require('../lib/collectors');
const space = require('../lib/space');
const { hintFor } = require('../lib/hints');
const selfupdate = require('../lib/selfupdate');
const feed = require('../lib/events');
const { clearCache, background } = require('../lib/http');

const DAY = 864e5;
const NOW = Date.parse('2026-10-07T12:00:00Z');
const TB = 1024 ** 4;

test('space: biggest, downloaded per title, cleanup only for matched and long-unwatched titles', () => {
  const cfg = {
    cleanupDays: 365,
    services: [
      { id: 's', url: 'http://sonarr:8989' },
      { id: 'r', url: 'http://radarr:7878', link: 'https://radarr.example' },
    ],
  };
  const added = days => new Date(NOW - days * DAY).toISOString();
  const results = [
    {
      id: 's',
      name: 'Sonarr',
      kind: 'sonarr',
      up: true,
      data: {
        _library: [
          {
            kind: 'series',
            id: 1,
            title: 'The Office',
            year: 2005,
            slug: 'the-office-us',
            added: added(900),
            size: 0.5 * TB,
          },
          {
            kind: 'series',
            id: 2,
            title: 'Severance',
            year: 2022,
            slug: 'severance',
            added: added(900),
            size: 0.2 * TB,
          },
          { kind: 'series', id: 3, title: 'New Show', year: 2026, slug: 'new-show', added: added(10), size: 0.1 * TB },
          { kind: 'series', id: 4, title: 'Not In Plex', year: 2001, slug: 'nip', added: added(900), size: 0.9 * TB },
        ],
        _downloaded30: [{ id: 2, bytes: 50e9, count: 5 }],
      },
    },
    {
      id: 'r',
      name: 'Radarr',
      kind: 'radarr',
      up: true,
      data: {
        _library: [
          { kind: 'movie', id: 9, title: 'Heat', year: 1995, slug: '949', added: added(800), size: 0.08 * TB },
          { kind: 'movie', id: 10, title: 'Dune', year: 1984, slug: '841', added: added(800), size: 0.05 * TB },
          { kind: 'movie', id: 11, title: 'Dune', year: 2021, slug: '438631', added: added(800), size: 0.06 * TB },
        ],
      },
    },
    {
      id: 't',
      name: 'Tautulli',
      kind: 'tautulli',
      up: true,
      data: {
        _watch: {
          since: NOW - 1000 * DAY,
          items: [
            { type: 'show', title: 'Office', year: 2005, lastPlayed: NOW - 500 * DAY, plays: 40 }, // "The" dropped by Plex: still matches
            { type: 'show', title: 'Severance', year: 2022, lastPlayed: NOW - 3 * DAY, plays: 9 },
            { type: 'show', title: 'New Show', year: 2026, lastPlayed: null, plays: 0 },
            { type: 'movie', title: 'Heat', year: 1995, lastPlayed: null, plays: 0 },
            { type: 'movie', title: 'Dune', year: 1984, lastPlayed: null, plays: 0 },
            { type: 'movie', title: 'Dune', year: 2021, lastPlayed: NOW - 20 * DAY, plays: 3 },
          ],
        },
      },
    },
  ];
  const sp = space.build(results, cfg, NOW);
  assert.deepEqual(sp.biggest.map(x => x.title).slice(0, 2), ['Not In Plex', 'The Office']);
  assert.equal(sp.biggest[1].link, 'http://sonarr:8989/series/the-office-us');
  assert.equal(sp.downloaded.items[0].title, 'Severance');
  assert.equal(sp.downloaded.total, 50e9);
  const names = sp.cleanup.items.map(x => `${x.title} ${x.year}`);
  assert.deepEqual(names.sort(), ['Dune 1984', 'Heat 1995', 'The Office 2005']);
  assert.ok(!names.includes('Not In Plex 2001'), 'unmatched titles are never called unwatched');
  assert.ok(!names.includes('New Show 2026'), 'recently added titles are left alone');
  assert.equal(sp.cleanup.items.find(x => x.title === 'Heat').link, 'https://radarr.example/movie/949');
  assert.equal(sp.cleanup.historyDays, 1000);

  space.stripPrivate(results);
  assert.ok(
    results.every(r => !Object.keys(r.data).some(k => k.startsWith('_'))),
    'per-title lists never reach the browser',
  );
});

test('prowlarr: per-indexer usage in the rolling window, warnings at 90% and 100%', async t => {
  const indexer = (id, name, q, g, unit = 0) => ({
    id,
    name,
    enable: true,
    fields: [
      { name: 'baseSettings.queryLimit', value: q },
      { name: 'baseSettings.grabLimit', value: g },
      { name: 'baseSettings.limitsUnit', value: unit },
    ],
  });
  const srv = await fakeServer({
    '/api/v1/system/status': { version: '2.6.5' },
    '/api/v1/indexer': [
      indexer(1, 'NZBgeek', 500, 100),
      indexer(2, 'Slug', 1000, null),
      indexer(3, 'Planet', 40, 10, 1),
      { id: 4, name: 'Off', enable: false, fields: [] },
    ],
    '/api/v1/indexerstatus': [{ indexerId: 3, disabledTill: new Date(Date.now() + 600e3).toISOString() }],
    '/api/v1/health': [],
    '/api/v1/log': { records: [] },
    '/api/v1/update': [],
    '/api/v1/indexerstats': (req, url) => {
      const start = url.searchParams.get('startDate');
      if (!start) return { indexers: [] };
      const hours = (Date.now() - Date.parse(start)) / 3600e3;
      return {
        indexers:
          hours > 2
            ? [
                { indexerId: 1, numberOfQueries: 400, numberOfRssQueries: 60, numberOfGrabs: 100 },
                { indexerId: 2, numberOfQueries: 10, numberOfGrabs: 1 },
              ]
            : [{ indexerId: 3, numberOfQueries: 20, numberOfRssQueries: 0, numberOfGrabs: 1 }],
      };
    },
  });
  t.after(() => srv.close());
  clearCache();
  const r = await c.prowlarr({ url: srv.url, apiKey: 'k' });
  const geek = r.data.limits.find(l => l.name === 'NZBgeek');
  assert.deepEqual(
    [geek.queries, geek.queryLimit, geek.grabs, geek.unit],
    [460, 500, 100, 'day'],
    'RSS counts toward the API limit',
  );
  const planet = r.data.limits.find(l => l.name === 'Planet');
  assert.deepEqual(
    [planet.queries, planet.unit, !!planet.pausedUntil],
    [20, 'hour', true],
    'hourly limits use the last hour',
  );
  assert.equal(r.data.limits.length, 3, 'disabled indexers left out');
  const msgs = r.data.events.filter(e => e.source === 'Indexer limits').map(e => `${e.level} ${e.message}`);
  assert.deepEqual(msgs.sort(), [
    'error NZBgeek has hit its daily grab limit',
    'warn NZBgeek has used 90% of its daily API limit',
  ]);
  const ev = feed.collect([{ id: 'p', name: 'Prowlarr', up: true, data: r.data }]).find(e => /90%/.test(e.message));
  assert.match(ev.hint, /Prowlarr/, 'limit warnings carry a how-to-fix hint');
});

test('updates: arr reports a newer release; installed latest means no update', async t => {
  let list = [
    { version: '4.0.16.3000', latest: true, installed: false },
    { version: '4.0.15', installed: true },
  ];
  const srv = await fakeServer({
    '/api/v3/system/status': { version: '4.0.15' },
    '/api/v3/update': () => list,
    '/api/v3/series': [],
    '/api/v3/queue': { records: [] },
    '/api/v3/wanted/missing': { totalRecords: 0 },
    '/api/v3/health': [],
    '/api/v3/diskspace': [],
    '/api/v3/calendar': [],
    '/api/v3/log': { records: [] },
    '/api/v3/history': { records: [] },
    '/api/v3/history/since': [],
  });
  t.after(() => srv.close());
  const poll = () => c.sonarr({ url: srv.url, apiKey: 'k' });
  const settle = () => new Promise(r => setTimeout(r, 50));
  clearCache();
  assert.equal((await poll()).data.update, null, "the first poll doesn't wait for the update check");
  await settle();
  assert.deepEqual((await poll()).data.update, { version: '4.0.16.3000' });
  list = [{ version: '4.0.15', latest: true, installed: true }];
  clearCache();
  await poll();
  await settle();
  assert.equal((await poll()).data.update, null);
  assert.equal(selfupdate.newer('1.12.0', '1.11.9'), true);
  assert.equal(selfupdate.newer('1.11.0', '1.11.0'), false);
  assert.equal(selfupdate.newer('1.9.0', '1.10.0'), false, 'compared as numbers, not text');
  assert.equal(selfupdate.versionOf({ tag_name: 'v1.16.0' }), '1.16.0');
  assert.equal(selfupdate.versionOf({ tag_name: 'v1.16.0', prerelease: true }), null);
  assert.equal(selfupdate.versionOf({ tag_name: 'nightly' }), null);
  assert.equal(selfupdate.versionOf(null), null);
});

test('hints: known causes get a how-to-fix line, unknown errors none', () => {
  assert.match(hintFor({ message: 'Error occurred while executing task RssSync: database is locked' }), /cache/);
  assert.match(
    hintFor({ message: 'API Request Limit reached for NZBgeek (Prowlarr). Disabled for 00:07:18' }),
    /API limit/,
  );
  assert.match(hintFor({ message: "Access to the path '/data/media/tv' is denied." }), /PUID\/PGID/);
  assert.match(
    hintFor({ source: 'Queue', message: 'Slow Horses S04E05: No files found are eligible for import' }),
    /Replace/,
  );
  assert.equal(hintFor({ message: 'Something nobody has seen before' }), null);
  assert.equal(hintFor({ message: 'Changed audio sample rate' }), null, "the word 'sample' alone isn't a bad download");
});

test('background cache: never waits after the first value, refreshes when stale, keeps the old value on failure', async () => {
  let n = 0,
    fail = false;
  const fn = async () => {
    await new Promise(r => setTimeout(r, 20));
    if (fail) throw new Error('down');
    return ++n;
  };
  clearCache();
  assert.equal(await background('k', 0, fn), null, 'nothing yet, and no waiting');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(await background('k', 0, fn), 1, 'returns the stored value at once while refreshing');
  await new Promise(r => setTimeout(r, 40));
  fail = true;
  assert.equal(await background('k', 0, fn), 2);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(await background('k', 60e3, fn), 2, 'a failed refresh keeps the last good value');
});

test('downloaded in 30 days: only imports count, even if the app ignores the eventType filter', async t => {
  const srv = await fakeServer({
    '/api/v3/system/status': { version: '6.4.4' },
    '/api/v3/movie': [{ id: 7, title: 'Heat', year: 1995, titleSlug: '949', sizeOnDisk: 9e9 }],
    '/api/v3/queue': { records: [] },
    '/api/v3/health': [],
    '/api/v3/diskspace': [],
    '/api/v3/calendar': [],
    '/api/v3/log': { records: [] },
    '/api/v3/history': { records: [] },
    '/api/v3/update': [],
    '/api/v3/history/since': [
      { movieId: 7, eventType: 'grabbed', data: { size: '9000000000' } },
      { movieId: 7, eventType: 'downloadFolderImported', data: { size: '8000000000' } },
    ],
  });
  t.after(() => srv.close());
  clearCache();
  await c.radarr({ url: srv.url, apiKey: 'k' });
  await new Promise(r => setTimeout(r, 50));
  const r = await c.radarr({ url: srv.url, apiKey: 'k' });
  assert.deepEqual(r.data._downloaded30, [{ id: 7, bytes: 8e9, count: 1 }]);
});
