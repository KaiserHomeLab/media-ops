// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub: parsing each source's webhooks, the event format, source tokens, and the
// SQLite store. The HTTP side (token checks, the hub switch) is in server.test.js.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-hub-'));
process.env.HUB_DB = path.join(dir, 'hub.db');
const { fixture } = require('./helpers');
const parsers = require('../lib/hub/parsers');
const normalize = require('../lib/hub/normalize');
const sources = require('../lib/hub/sources');
const store = require('../lib/hub/store');
after(() => store.close());

/** @param {string} name */
const hubFixture = name => fixture(`hub/${name}`);

test('radarr: a new movie is media.added; the same import flagged isUpgrade is media.upgraded, never new', () => {
  const body = hubFixture('radarr-download');
  const [added] = parsers.arr(body, 'radarr', {});
  assert.equal(added.type, 'media.added');
  assert.equal(added.isUpgrade, false);
  assert.equal(added.dedupeKey, 'movie:tmdb:651');
  assert.equal(added.media?.title, 'M*A*S*H', 'kept as is; escaping is for each output to do');
  assert.equal(added.media?.library, 'Movies');
  assert.equal(added.media?.quality, 'Bluray-1080p');
  assert.equal(added.media?.posterUrl, 'https://image.tmdb.org/t/p/original/mash-poster.jpg');
  assert.equal(added.summary, 'Added: M*A*S*H (1970)');

  const [up] = parsers.arr({ ...body, isUpgrade: true }, 'radarr', {});
  assert.equal(up.type, 'media.upgraded');
  assert.equal(up.isUpgrade, true);
  assert.equal(up.dedupeKey, added.dedupeKey, 'same title, same key');
});

test('sonarr: one file holding two episodes is two events; anime goes to Anime unless the source names a library', () => {
  const body = hubFixture('sonarr-download');
  const evs = parsers.arr(body, 'sonarr', {});
  assert.deepEqual(
    evs.map(e => [e.type, e.dedupeKey, e.media?.library]),
    [
      ['media.added', 'episode:tvdb:371980:S02E01', 'TV Shows'],
      ['media.added', 'episode:tvdb:371980:S02E02', 'TV Shows'],
    ],
  );
  assert.equal(evs[0].summary, 'Added: Severance S02E01 "Hello, Ms. Cobel"');
  assert.equal(evs[0].media?.quality, 'WEBDL-2160p');
  const anime = { ...body, series: { ...body.series, type: 'anime' } };
  assert.equal(parsers.arr(anime, 'sonarr', {})[0].media?.library, 'Anime');
  assert.equal(parsers.arr(anime, 'sonarr', { library: 'Cartoons' })[0].media?.library, 'Cartoons');
});

test('arr: health keeps one key per check, test and unknown events still arrive, upgrade deletes are not removals', () => {
  const issue = parsers.arr(
    {
      eventType: 'Health',
      level: 'warning',
      type: 'IndexerStatusCheck',
      message: 'Indexers unavailable: A, B',
      instanceName: 'Sonarr',
    },
    'sonarr',
    {},
  )[0];
  assert.equal(issue.type, 'app.health_issue');
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.dedupeKey, 'health:sonarr:IndexerStatusCheck');
  const restored = parsers.arr(
    { eventType: 'HealthRestored', level: 'warning', type: 'IndexerStatusCheck', message: 'Indexers unavailable: A' },
    'sonarr',
    {},
  )[0];
  assert.equal(restored.type, 'app.health_restored');
  assert.equal(restored.dedupeKey, issue.dedupeKey);

  assert.equal(parsers.arr({ eventType: 'Test', instanceName: 'Radarr' }, 'radarr', {})[0].type, 'hub.test');
  assert.equal(
    parsers.arr({ ...hubFixture('radarr-download'), eventType: 'Grab' }, 'radarr', {})[0].type,
    'hub.unhandled',
  );

  const del = { ...hubFixture('radarr-download'), eventType: 'MovieFileDelete', deleteReason: 'upgrade' };
  assert.equal(parsers.arr(del, 'radarr', {})[0].type, 'hub.unhandled');
  assert.equal(parsers.arr({ ...del, deleteReason: 'manual' }, 'radarr', {})[0].type, 'media.removed');
  const manual = { ...hubFixture('radarr-download'), eventType: 'ManualInteractionRequired' };
  assert.deepEqual(
    [parsers.arr(manual, 'radarr', {})[0].type, parsers.arr(manual, 'radarr', {})[0].severity],
    ['download.stuck', 'warning'],
  );
});

test('seerr: request states map to types, the title and year come out of the subject, a test is a test', () => {
  const [e] = parsers.seerr(hubFixture('seerr-pending'));
  assert.equal(e.type, 'media.request.created');
  assert.equal(e.media?.title, 'Caveat');
  assert.equal(e.media?.year, 2020);
  assert.equal(e.media?.ids.tmdb, 656563);
  assert.equal(e.dedupeKey, 'movie:tmdb:656563:media.request.created');
  assert.equal(e.summary, 'Requested: Caveat (2020) (by friend)');
  const available = parsers.seerr({ ...hubFixture('seerr-pending'), notification_type: 'MEDIA_AVAILABLE' })[0];
  assert.equal(available.type, 'media.request.available');
  assert.notEqual(available.dedupeKey, e.dedupeKey, 'each state of a request is its own event');
  assert.equal(parsers.seerr({ notification_type: 'TEST_NOTIFICATION' })[0].type, 'hub.test');
  assert.equal(parsers.seerr({ notification_type: 'SOMETHING_NEW', subject: 'X' })[0].type, 'hub.unhandled');
});

test('seerr: a long subject is parsed in linear time (no regex stall from a crafted payload)', () => {
  const t0 = performance.now();
  const [e] = parsers.seerr({ notification_type: 'MEDIA_PENDING', subject: `x${' '.repeat(400000)}x`, media: {} });
  assert.ok(performance.now() - t0 < 200, 'fast');
  assert.ok(e.media && e.media.title.length <= 300, 'capped');
  assert.deepEqual(
    [
      parsers.seerr({ notification_type: 'MEDIA_PENDING', subject: 'Dune: Part Two (2024)' })[0].media?.title,
      parsers.seerr({ notification_type: 'MEDIA_PENDING', subject: 'Dune: Part Two (2024)' })[0].media?.year,
    ],
    ['Dune: Part Two', 2024],
  );
});

test('generic: the hub format with only a type and summary required; bad types refused', () => {
  const [e] = parsers.generic({ type: 'backup.finished', summary: 'Nightly backup finished', severity: 'warn' });
  assert.deepEqual([e.type, e.severity, e.summary], ['backup.finished', 'warning', 'Nightly backup finished']);
  const [m] = parsers.generic({
    type: 'media.added',
    media: { kind: 'movie', title: 'Dune', year: 2021, ids: { tmdb: 438631 }, poster_url: 'https://x.example/p.jpg' },
  });
  assert.equal(m.dedupeKey, 'movie:tmdb:438631');
  assert.equal(m.media?.posterUrl, 'https://x.example/p.jpg');
  for (const bad of [[], 'x', { type: 'Bad Type', summary: 's' }, { type: 'hub.test', summary: 's' }, { type: 'ok' }])
    assert.throws(
      () => parsers.generic(bad),
      (/** @type {any} */ err) => err.status === 400,
    );
});

test('normalize: posters must be https, episodes without ids fall back to the show name', () => {
  const m = normalize.media({ kind: 'movie', title: 'X', posterUrl: 'http://insecure/p.jpg' });
  assert.equal(m.posterUrl, null);
  const ep = normalize.media({ kind: 'episode', title: 'Show', show: 'The Bear', season: 3, episode: 1 });
  assert.equal(normalize.dedupeKey(ep), 'episode:title:the bear:S03E01');
});

test('polled events: the dedupe key follows what it is about, not the changing line', () => {
  const a = normalize.fromPolled({
    kind: 'recovered',
    level: 'good',
    line: '🟢 Sonarr is back up (down for 3 min)',
    ref: 'svc1',
  });
  const b = normalize.fromPolled({
    kind: 'recovered',
    level: 'good',
    line: '🟢 Sonarr is back up (down for 9 min)',
    ref: 'svc1',
  });
  assert.equal(a.type, 'app.up');
  assert.equal(a.severity, 'info');
  assert.equal(a.dedupeKey, b.dedupeKey);
  assert.equal(normalize.fromPolled({ kind: 'down', level: 'error', line: 'x' }).type, 'app.down');
});

test('media review: Leaving Soon titles are announced once, and not the ones already there at first sight', () => {
  /** @param {string[]} keys */
  const poll = keys => [
    {
      id: 'mr1',
      kind: 'mediareview',
      up: true,
      data: {
        leavingSoon: keys.map(k => ({ ratingKey: k, title: `Title ${k}`, year: 2001, kind: 'movie', daysLeft: 14 })),
      },
    },
  ];
  assert.deepEqual(normalize.fromMediaReview(poll(['1'])), [], 'first sight only learns');
  const fresh = normalize.fromMediaReview(poll(['1', '2']));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].type, 'media.leaving_soon');
  assert.equal(fresh[0].summary, 'Title 2 (2001) is leaving soon (14 days left)');
  assert.deepEqual(normalize.fromMediaReview(poll(['1', '2'])), []);
});

test('sources: a new source gets a token shown once (only its hash kept), from any of the ways apps send it', () => {
  const { source, token } = sources.merge([], null, { type: 'sonarr', instance: 'sonarr-anime', library: 'Anime' });
  assert.match(String(token), /^mohub_[\w-]{32}$/);
  assert.equal(source.tokenHash, sources.hashOf(String(token)));
  assert.ok(!JSON.stringify(source).includes(String(token)), 'the token itself is not stored');
  assert.ok(!('tokenHash' in sources.publicSource(source)), 'nor is its hash shown');
  assert.equal(sources.publicSource(source).path, '/api/hub/in/sonarr/sonarr-anime');
  const all = [source];
  assert.equal(sources.verify(all, 'sonarr', 'sonarr-anime', String(token)), source);
  assert.equal(sources.verify(all, 'sonarr', 'sonarr-anime', 'wrong'), null);
  assert.equal(sources.verify(all, 'radarr', 'sonarr-anime', String(token)), null, 'token is per source');
  assert.equal(sources.verify(all, 'sonarr', 'sonarr-anime', ''), null);

  const q = new URLSearchParams();
  const t = String(token);
  assert.equal(sources.tokenFrom({ 'x-hub-token': t }, q), t);
  assert.equal(sources.tokenFrom({ authorization: `Bearer ${t}` }, q), t);
  assert.equal(sources.tokenFrom({ authorization: `Basic ${Buffer.from(`sonarr:${t}`).toString('base64')}` }, q), t);
  assert.equal(sources.tokenFrom({}, new URLSearchParams({ token: t })), t);

  assert.throws(() => sources.merge(all, null, { type: 'sonarr', instance: 'sonarr-anime' }), /already/);
  assert.throws(() => sources.merge(all, null, { type: 'sonarr', instance: 'Bad Name' }), /lowercase/);
  assert.throws(() => sources.merge(all, null, { type: 'plex' }), /Unknown source type/);
  const again = sources.regenerate(source);
  assert.notEqual(again.source.tokenHash, source.tokenHash);
  assert.deepEqual(sources.clean([source, { ...source, tokenHash: 'nope' }, 'junk']), [source]);
});

test('store: events in, newest first, without raw payloads; raw dropped after 7 days, events after 90', () => {
  const ev = normalize.finish(
    { source: 'radarr', sourceInstance: 'radarr', raw: { secretish: 'friend@example.com' } },
    parsers.arr(hubFixture('radarr-download'), 'radarr', {})[0],
  );
  store.add(ev);
  const old = { ...ev, id: 'old', receivedAt: Date.now() - 10 * 864e5 };
  store.add(old);
  const ancient = { ...ev, id: 'ancient', receivedAt: Date.now() - 100 * 864e5 };
  store.add(ancient);
  const list = store.recent();
  assert.deepEqual(
    list.map(e => e.id),
    [ev.id, 'old', 'ancient'],
  );
  assert.equal(list[0].media.title, 'M*A*S*H');
  assert.equal(list[0].status, 'logged');
  assert.ok(!JSON.stringify(list).includes('friend@example.com'), 'raw payloads never leave the server');
  store.prune();
  assert.deepEqual(
    store.recent().map(e => e.id),
    [ev.id, 'old'],
  );
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.HUB_DB || '');
  const raws = /** @type {any[]} */ (db.prepare('SELECT id, raw_json FROM hub_events ORDER BY received_at DESC').all());
  db.close();
  assert.ok(raws[0].raw_json, 'recent raw kept');
  assert.equal(raws[1].raw_json, null, 'raw older than 7 days dropped');
  store.sawSource('s1', 'media.added');
  store.sawSource('s1', 'hub.test');
  assert.equal(store.sourceStats().s1.received, 2);
  assert.equal(store.sourceStats().s1.lastType, 'hub.test');
  if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.HUB_DB || '').mode & 0o777, 0o600);
});

test('clean-up runs whenever hub.db exists, even with the hub turned off (no keeping requesters past 7 days)', async () => {
  const hub = require('../lib/hub');
  const old = normalize.finish(
    { source: 'seerr', sourceInstance: 'seerr', raw: { requestedBy_email: 'friend@example.com' } },
    parsers.seerr(hubFixture('seerr-pending'))[0],
  );
  store.add({ ...old, id: 'very-old', receivedAt: Date.now() - 200 * 864e5 });
  await hub.tick(/** @type {any} */ ({ hub: { enabled: false } }));
  assert.ok(!store.recent(1000).some(e => e.id === 'very-old'));
});
