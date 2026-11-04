// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub digests: the cron schedule (time zones, daylight saving), building one (each
// title once, TV folded into seasons, sections, upgrades only counted), and running them on
// time against a fake Discord: empty days post nothing, failures keep the titles for next time.
'use strict';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-hub-digests-'));
process.env.HUB_DB = path.join(dir, 'hub.db');
const { fakeServer } = require('./helpers');
const schedule = require('../lib/hub/schedule');
const digests = require('../lib/hub/digests');
const store = require('../lib/hub/store');
const rules = require('../lib/hub/rules');
const deliver = require('../lib/hub/deliver');
const { finish, media, dedupeKey } = require('../lib/hub/normalize');
after(() => store.close());

beforeEach(() => {
  const { DatabaseSync } = require('node:sqlite');
  store.close();
  const db = new DatabaseSync(process.env.HUB_DB || '');
  db.exec(
    'DROP TABLE IF EXISTS hub_events; DROP TABLE IF EXISTS hub_sources; DROP TABLE IF EXISTS hub_deliveries; DROP TABLE IF EXISTS hub_digest_runs; PRAGMA user_version = 0;',
  );
  db.close();
});

/** @param {string} type @param {Record<string, any>} m @param {string} [summary] */
const ev = (type, m, summary) => {
  const md = media(m);
  return finish(
    { source: 'sonarr', sourceInstance: 'sonarr', raw: null },
    {
      type,
      severity: 'info',
      summary: summary || `${type}: ${md.title}`,
      media: md,
      isUpgrade: type === 'media.upgraded',
      dedupeKey: dedupeKey(md),
    },
  );
};
/** @param {number} n @param {number} [season] @param {string} [show] @param {number} [tvdb] */
const episode = (n, season = 2, show = 'Severance', tvdb = 371980) => ({
  kind: 'episode',
  title: show,
  show,
  season,
  episode: n,
  library: 'TV Shows',
  ids: { tvdb },
  episodeTitle: `Ep ${n}`,
});
/** @type {import('../lib/hub/digests').Digest} */
const D = {
  id: 'added_daily',
  title: 'Added to Plex',
  enabled: true,
  cron: '0 8 * * *',
  timezone: 'America/Chicago',
  destinations: ['d1'],
  skipIfEmpty: true,
  maxItemsPerSection: 25,
  footer: 'Request more at requests.example.com',
};

test('schedule: next time in a time zone, weekly, steps, daylight saving, and clear errors', () => {
  const at = Date.parse('2026-11-03T15:30:00Z');
  /** @param {string} c @param {string} tz @param {number} [t] */
  const next = (c, tz, t = at) => new Date(/** @type {number} */ (schedule.next(c, tz, t))).toISOString();
  assert.equal(next('0 8 * * *', 'America/Chicago'), '2026-11-04T14:00:00.000Z', '08:00 CST');
  assert.equal(next('0 10 * * 6', 'America/Chicago'), '2026-11-07T16:00:00.000Z', 'Saturday 10:00');
  assert.equal(next('0 10 * * 7', 'UTC'), '2026-11-08T10:00:00.000Z', 'Sunday as 7');
  assert.equal(next('*/15 * * * *', 'UTC'), '2026-11-03T15:45:00.000Z');
  assert.equal(next('0 9-17/4 * * 1-5', 'UTC'), '2026-11-03T17:00:00.000Z');
  assert.equal(next('0 8 1,15 * *', 'UTC'), '2026-11-15T08:00:00.000Z');
  // 2 AM doesn't exist the night clocks go forward: the next one is the night after.
  assert.equal(next('0 2 * * *', 'America/Chicago', Date.parse('2026-03-07T12:00:00Z')), '2026-03-09T07:00:00.000Z');
  assert.throws(() => schedule.parse('0 25 * * *'), /hour: 25 is outside 0-23/);
  assert.throws(() => schedule.parse('0 8 * *'), /five parts/);
  assert.throws(() => schedule.parse('0 8 * * mon'), /isn't a number/);
  assert.ok(schedule.validZone('Europe/Berlin') && schedule.validZone('') && !schedule.validZone('Mars/Olympus'));
});

test('build: ten episodes of one season are one line; a new series says so; one episode by name', () => {
  assert.equal(digests.ranges([1, 2, 3, 5, 7, 8]), '1–3, 5, 7–8');
  const events = [
    ...Array.from({ length: 10 }, (_, i) => ev('media.added', episode(i + 1))),
    ev('media.added', episode(1, 1, 'Frieren', 424536)),
    ev('media.added', episode(2, 1, 'Frieren', 424536)),
    ev('media.added', episode(1, 3, 'The Bear', 403294)),
  ];
  const b = digests.build({ ...D, maxItemsPerSection: 25 }, events);
  assert.deepEqual(b.sections, [
    {
      name: 'TV Shows',
      lines: [
        'Frieren (new series): Season 1, episodes 1–2',
        'Severance: Season 2, episodes 1–10',
        'The Bear S03E01 "Ep 1"',
      ],
      more: 0,
    },
  ]);
  assert.equal(b.items, 13);
});

test('build: each title once, an upgrade is only a count, sections in library order, the footer, and the date in its zone', () => {
  const movie = (/** @type {string} */ title, /** @type {number} */ tmdb, lib = 'Movies') => ({
    kind: 'movie',
    title,
    year: 1970,
    library: lib,
    ids: { tmdb },
  });
  const events = [
    ev('media.added', { ...episode(1, 1, 'Frieren', 424536), library: 'Anime' }),
    ev('media.added', movie('M*A*S*H', 651)),
    ev('media.upgraded', movie('M*A*S*H', 651)), // same title: added wins
    ev('media.added', movie('M*A*S*H', 651)), // twice: once
    ev('media.upgraded', movie('Caveat', 656563)),
    ev('media.upgraded', movie('Dune', 438631)),
    ev('media.added', { ...episode(4), library: 'TV Shows' }),
    ev('media.leaving_soon', movie('Paper Moons', 1), 'Paper Moons (2004) is leaving soon (3 days left)'),
  ];
  const b = digests.build(D, events, Date.parse('2026-11-04T14:00:00Z'));
  assert.deepEqual(
    b.sections.map(s => s.name),
    ['Movies', 'TV Shows', 'Anime', 'Leaving soon'],
  );
  assert.deepEqual(b.sections[0].lines, ['M*A*S*H (1970)'], 'kept literal; Discord escaping is for the Discord output');
  assert.equal(b.upgrades, 2, 'Caveat and Dune; M*A*S*H was new');
  assert.equal(b.footer, '3 new · 2 upgraded quietly · Request more at requests.example.com');
  assert.equal(b.title, 'Added to Plex · Wednesday, Nov 4');
  const text = digests.asText(b);
  assert.deepEqual(text.lines.slice(0, 3), ['MOVIES', '• M*A*S*H (1970)', '']);
  assert.equal(text.lines.at(-1), b.footer);
  const capped = digests.build(
    { ...D, maxItemsPerSection: 2 },
    [1, 2, 3, 4].map(n => ev('media.added', movie(`Film ${n}`, n))),
  );
  assert.equal(capped.sections[0].lines.length, 2);
  assert.equal(capped.sections[0].more, 2);
});

test('clean: schedules, zones and ids checked; unknown destinations dropped', () => {
  const [d] = digests.clean([{ ...D, destinations: ['d1', 'gone'], maxItemsPerSection: 500 }], ['d1']);
  assert.deepEqual(d.destinations, ['d1']);
  assert.equal(d.maxItemsPerSection, 100);
  assert.throws(() => digests.clean([{ ...D, cron: 'daily' }], []), /five parts/);
  assert.throws(() => digests.clean([{ ...D, timezone: 'Mars/Olympus' }], []), /unknown time zone/);
  assert.throws(() => digests.clean([{ ...D, id: 'Bad Id' }], []), /lowercase/);
  assert.throws(() => digests.clean([D, D], []), /Two digests/);
  assert.equal(
    digests.starting().every(x => !x.enabled),
    true,
    'digests start off',
  );
});

/** @param {import('node:test').TestContext} t @param {number} [status] */
async function discord(t, status = 204) {
  /** @type {any[]} */
  const posts = [];
  const srv = await fakeServer({
    '/hook': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      posts.push(JSON.parse(body));
      return { status };
    },
  });
  t.after(() => srv.close());
  const cfg = /** @type {any} */ ({
    notifications: {
      targets: [{ id: 'd1', type: 'discord', name: 'News', enabled: true, webhookUrl: `${srv.url}/hook`, events: {} }],
    },
    hub: {
      enabled: true,
      flapMinutes: 0,
      digests: [D],
      rules: rules.clean(
        [{ name: 'new', match: { type: ['media.added', 'media.upgraded'] }, action: 'digest', digest: 'added_daily' }],
        ['d1'],
      ),
    },
  });
  return { posts, cfg };
}

test('run: the queued titles go out once and are marked; a day with nothing new posts nothing', async t => {
  const { posts, cfg } = await discord(t);
  deliver.route(cfg, ev('media.added', episode(1)));
  deliver.route(cfg, ev('media.added', episode(2)));
  const r = await digests.run(cfg, D);
  assert.deepEqual(r, { status: 'sent', items: 2, upgrades: 0, sent: 1 });
  assert.equal(posts.length, 1);
  assert.match(posts[0].embeds[0].title, /^Added to Plex · /);
  assert.match(posts[0].embeds[0].description, /TV SHOWS\n• Severance: Season 2, episodes 1–2/);
  assert.ok(
    store.recent().every(e => e.status === 'digested' && e.sentAt),
    'Activity: in the digest, and when',
  );

  assert.equal((await digests.run(cfg, D)).status, 'empty', 'nothing new since');
  deliver.route(cfg, ev('media.upgraded', episode(1)));
  assert.equal((await digests.run(cfg, D)).status, 'empty', 'an upgrade alone is not news');
  assert.equal(posts.length, 1, 'no post on an empty day');
  assert.equal(store.recent()[0].status, 'digested', 'the counted-only upgrade is used up, not left to pile up');
});

test('run: a failed send keeps the titles queued for the next run; no destination likewise', async t => {
  const { posts, cfg } = await discord(t, 500);
  deliver.route(cfg, ev('media.added', episode(7)));
  assert.equal((await digests.run(cfg, D)).status, 'failed');
  assert.equal(posts.length, 1, 'it was tried');
  assert.equal(store.recent()[0].status, 'queued', 'still waiting');
  assert.equal((await digests.run({ ...cfg, notifications: { targets: [] } }, D)).status, 'no-destination');
  assert.equal(store.recent()[0].status, 'queued');
});

test('runDue: waits for its time, runs once, and catches up once after being down', async t => {
  const { posts, cfg } = await discord(t);
  deliver.route(cfg, ev('media.added', episode(1)));
  const start = Date.parse('2026-11-04T13:00:00Z'); // 07:00 in Chicago
  await digests.runDue(cfg, start);
  assert.equal(posts.length, 0, 'never run: waits for the next 08:00');
  await digests.runDue(cfg, start + 59 * 60e3);
  assert.equal(posts.length, 0, '07:59');
  // The run is stamped with the real clock, so pretend "now" is well after it to check it only runs once.
  await digests.runDue(cfg, start + 60 * 60e3);
  assert.equal(posts.length, 1, '08:00');
  deliver.route(cfg, ev('media.added', episode(2)));
  await digests.runDue(cfg, Date.now() + 1000);
  assert.equal(posts.length, 1, 'not again until the next 08:00 after the last run');
  await digests.runDue(cfg, Date.now() + 3 * 864e5);
  assert.equal(posts.length, 2, 'down over several 08:00s: one catch-up run, not three');
  await digests.runDue(cfg, Date.now() + 3 * 864e5);
  assert.equal(posts.length, 2);
  await digests.runDue({ ...cfg, hub: { ...cfg.hub, digests: [{ ...D, enabled: false }] } }, Date.now() + 9 * 864e5);
  assert.equal(posts.length, 2, 'a switched-off digest never runs');
});
