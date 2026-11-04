// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub rules and delivery: matching, the first-match order, checking what Settings
// sends, the rules the hub starts with, and sending "now" events (batched per destination,
// repeats suppressed, quiet hours held in hub.db), against a fake Discord.
'use strict';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-hub-rules-'));
process.env.HUB_DB = path.join(dir, 'hub.db');
const { fakeServer } = require('./helpers');
const rules = require('../lib/hub/rules');
const deliver = require('../lib/hub/deliver');
const store = require('../lib/hub/store');
const notify = require('../lib/notify');
const { finish, media } = require('../lib/hub/normalize');
require('../lib/discord').timing.retryMs = 1;
after(() => store.close());

/** @param {Partial<import('../lib/hub/normalize').HubEvent>} over @returns {import('../lib/hub/normalize').HubEvent} */
const ev = (over = {}) => ({
  ...finish(
    { source: 'radarr', sourceInstance: 'radarr', raw: null },
    {
      type: 'media.added',
      severity: 'info',
      summary: 'Added: Dune (2021)',
      media: media({ kind: 'movie', title: 'Dune', year: 2021, library: 'Movies', ids: { tmdb: 438631 } }),
      isUpgrade: false,
      dedupeKey: 'movie:tmdb:438631',
    },
  ),
  ...over,
});

// A minute either side of now, so the test is "in quiet hours" whatever the time.
const quietNow = () => {
  /** @param {number} m */
  const hhmm = m => {
    const d = new Date(Date.now() + m * 60e3);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return { enabled: true, from: hhmm(-1), to: hhmm(2), allowDown: true };
};

beforeEach(() => {
  const { DatabaseSync } = require('node:sqlite');
  store.close();
  const db = new DatabaseSync(process.env.HUB_DB || '');
  db.exec(
    'DROP TABLE IF EXISTS hub_events; DROP TABLE IF EXISTS hub_sources; DROP TABLE IF EXISTS hub_deliveries; DROP TABLE IF EXISTS hub_digest_runs; PRAGMA user_version = 0;',
  );
  db.close();
});

test('match: lists, families, case, not, min_severity and booleans', () => {
  const e = ev();
  assert.ok(rules.matches({ type: ['media.added', 'media.upgraded'] }, e));
  assert.ok(rules.matches({ type: 'media.*' }, e), 'a family');
  assert.ok(!rules.matches({ type: 'media.request.*' }, e));
  assert.ok(rules.matches({ 'media.library': ['movies'] }, e), 'library names ignore case');
  assert.ok(!rules.matches({ type: 'media.added', not: { 'media.library': 'Movies' } }, e));
  assert.ok(rules.matches({ is_upgrade: false }, e));
  assert.ok(!rules.matches({ is_upgrade: true }, e));
  assert.ok(!rules.matches({ min_severity: 'warning' }, e));
  assert.ok(rules.matches({ min_severity: 'warning' }, ev({ severity: 'error' })));
  assert.ok(rules.matches({}, e), 'an empty match matches everything');
});

test('evaluate: first enabled match wins; the catch-all drops everything else', () => {
  const list = rules.clean(
    [
      { name: 'off', enabled: false, match: { type: 'media.added' }, action: 'now', destinations: ['d1'] },
      { name: 'upgrades', match: { type: 'media.upgraded' }, action: 'drop' },
      { name: 'added', match: { type: 'media.added' }, action: 'digest', digest: 'added_daily' },
      { name: 'also added', match: { type: 'media.added' }, action: 'now', destinations: ['d1'] },
    ],
    ['d1'],
  );
  assert.equal(rules.evaluate(ev(), list).name, 'added');
  assert.equal(rules.evaluate(ev({ type: 'app.down' }), list).id, rules.CATCH_ALL_ID);
  assert.equal(rules.evaluate(ev({ type: 'app.down' }), list).action, 'drop');
});

test('clean: catch-all forced last, unknown destinations dropped, bad rules refused with a reason', () => {
  const list = rules.clean(
    [
      { id: rules.CATCH_ALL_ID, name: 'moved to the top', match: {}, action: 'now', destinations: ['d1'] },
      { name: 'a', match: { type: ['app.down'] }, action: 'now', destinations: ['d1', 'gone', 'd1'] },
    ],
    ['d1'],
  );
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].destinations, ['d1']);
  assert.deepEqual(list.at(-1), rules.catchAll(), 'the catch-all is always the locked drop, last');
  assert.throws(() => rules.clean('x', []), /must be a list/);
  assert.throws(() => rules.clean([{ name: 'x', action: 'shout' }], []), /action must be/);
  assert.throws(() => rules.clean([{ name: 'x', action: 'digest' }], []), /pick a digest/);
  assert.throws(
    () => rules.clean([{ name: 'x', action: 'drop', match: { password: 'y' } }], []),
    /can't match on "password"/,
  );
  assert.throws(
    () => rules.clean([{ name: 'x', action: 'drop', match: { min_severity: 'huge' } }], []),
    /min_severity/,
  );
  assert.throws(
    () => rules.clean([{ name: 'x', action: 'drop', match: { not: { not: {} } } }], []),
    /can't match on "not"/,
  );
});

test('starting rules: today’s checkboxes become rules, so turning the hub on changes nothing', () => {
  /** @type {any[]} */
  const targets = [
    { id: 'phone', type: 'ntfy', enabled: true, events: { down: true, streams: true } },
    { id: 'discord', type: 'discord', enabled: true, events: { down: false } },
    { id: 'off', type: 'discord', enabled: false, events: { down: true } },
  ];
  const list = rules.starting(targets, notify.eventsOf, notify.EVENTS);
  const byId = Object.fromEntries(list.map(r => [r.id, r]));
  assert.deepEqual(
    byId['today-down'].destinations,
    ['phone'],
    'only destinations that want it, never switched-off ones',
  );
  assert.deepEqual(byId['today-down'].match, { type: ['app.down'] });
  assert.deepEqual(byId['today-streams'].destinations, ['phone']);
  assert.deepEqual(byId['today-errors'].destinations, ['phone', 'discord'], 'defaults for unticked-but-default events');
  assert.equal(byId['today-warnings'].action, 'drop', 'ticked nowhere (off by default): "don\'t tell me"');
  assert.ok(!byId['today-digest'], 'the daily digest is not a "now" event');
  assert.ok(
    list.filter(r => r.id.startsWith('suggested-')).every(r => !r.enabled),
    'suggestions start off',
  );
  assert.equal(list.at(-1)?.id, rules.CATCH_ALL_ID);
  assert.doesNotThrow(
    () =>
      rules.clean(
        list,
        targets.map(t => t.id),
      ),
    'starting rules pass the same checks',
  );
});

test('route: drop, digest, no destination, pending, and a repeat within the window suppressed', () => {
  const cfg = /** @type {any} */ ({
    notifications: { targets: [] },
    hub: {
      enabled: true,
      rules: rules.clean(
        [
          { name: 'down', match: { type: 'app.down' }, action: 'now', destinations: ['d1'] },
          { name: 'nobody', match: { type: 'app.up' }, action: 'now', destinations: [] },
          { name: 'digest', match: { type: 'media.added' }, action: 'digest', digest: 'added_daily' },
        ],
        ['d1'],
      ),
    },
  });
  assert.equal(deliver.route(cfg, ev({ type: 'media.upgraded' })).status, 'dropped');
  assert.deepEqual([deliver.route(cfg, ev()).status, deliver.route(cfg, ev()).digestId], ['queued', 'added_daily']);
  assert.equal(deliver.route(cfg, ev({ type: 'app.up' })).status, 'unrouted');
  const down = { type: 'app.down', severity: /** @type {const} */ ('error'), dedupeKey: 'app.down:svc1' };
  assert.equal(deliver.route(cfg, ev(down)).status, 'pending');
  assert.equal(deliver.route(cfg, ev(down)).status, 'suppressed', 'flapping');
  assert.equal(deliver.route(cfg, ev({ ...down, dedupeKey: 'app.down:svc2' })).status, 'pending', 'another app');
  assert.equal(
    deliver.route({ ...cfg, hub: { ...cfg.hub, flapMinutes: 0 } }, ev(down)).status,
    'pending',
    '0 = never suppress',
  );
  const activity = store.recent();
  assert.equal(activity.find(e => e.status === 'suppressed')?.rule, 'down', 'Activity shows the rule that matched');
});

test('deliverNow: one message per destination, Discord never pings, results in Activity; failures recorded', async t => {
  /** @type {any[]} */
  const posts = [];
  const srv = await fakeServer({
    '/ok': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      posts.push(JSON.parse(body));
      return { status: 204 };
    },
    '/broken': { status: 500 },
  });
  t.after(() => srv.close());
  const targets = [
    { id: 'd1', type: 'discord', name: 'Ops', enabled: true, webhookUrl: `${srv.url}/ok`, events: {} },
    { id: 'd2', type: 'discord', name: 'Broken', enabled: true, webhookUrl: `${srv.url}/broken`, events: {} },
  ];
  const cfg = /** @type {any} */ ({
    notifications: { targets },
    hub: {
      enabled: true,
      flapMinutes: 0,
      rules: rules.clean([{ name: 'all', match: {}, action: 'now', destinations: ['d1', 'd2'] }], ['d1', 'd2']),
    },
  });
  deliver.route(
    cfg,
    ev({ type: 'app.down', severity: 'error', summary: '🔴 Sonarr is down: Timed out', dedupeKey: 'a' }),
  );
  deliver.route(cfg, ev({ type: 'media.added', summary: 'Added: M*A*S*H (1970)', dedupeKey: 'b' }));
  assert.equal(await deliver.deliverNow(cfg), 2);
  assert.equal(posts.length, 1, 'both events in one message to the working destination');
  assert.equal(posts[0].embeds[0].title, 'Media Ops: 2 updates');
  // Escaped for Discord, so it shows as written ("M*A*S*H", not "MAS*H").
  assert.equal(posts[0].embeds[0].description, '🔴 Sonarr is down: Timed out\nAdded: M\\*A\\*S\\*H \\(1970\\)');
  assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
  const activity = store.recent();
  assert.ok(
    activity.every(e => e.status === 'sent'),
    'sent: it reached at least one destination',
  );
  const sends = activity[0].deliveries;
  assert.deepEqual(sends.map((/** @type {any} */ d) => [d.destination, d.ok]).sort(), [
    ['d1', true],
    ['d2', false],
  ]);
  assert.match(sends.find((/** @type {any} */ d) => !d.ok).error, /HTTP 500/);
  assert.equal(notify.lastResult('d2')?.ok, false, 'Settings shows the failure under the destination');
  assert.equal(await deliver.deliverNow(cfg), 0, 'nothing sent twice');

  const lone = {
    ...cfg,
    notifications: { targets: [targets[1]] },
    hub: { ...cfg.hub, rules: rules.clean([{ name: 'b', match: {}, action: 'now', destinations: ['d2'] }], ['d2']) },
  };
  deliver.route(lone, ev({ dedupeKey: 'c', summary: 'Added: Caveat (2020)' }));
  await deliver.deliverNow(lone);
  assert.equal(store.recent()[0].status, 'failed');
  deliver.route(cfg, ev({ dedupeKey: 'd' }));
  await deliver.deliverNow({ ...cfg, notifications: { targets: [] } });
  assert.equal(store.recent()[0].status, 'unrouted', 'its destinations were removed since');
});

test('quiet hours: held in hub.db and sent in the morning with 🌙; app down still gets through; who started watching is skipped', async t => {
  /** @type {any[]} */
  const posts = [];
  const srv = await fakeServer({
    '/ok': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      posts.push(JSON.parse(body));
      return { status: 204 };
    },
  });
  t.after(() => srv.close());
  const targets = [{ id: 'd1', type: 'discord', name: 'Ops', enabled: true, webhookUrl: `${srv.url}/ok`, events: {} }];
  const night = /** @type {any} */ ({
    notifications: { targets, quiet: quietNow() },
    hub: {
      enabled: true,
      flapMinutes: 0,
      rules: rules.clean([{ name: 'all', match: {}, action: 'now', destinations: ['d1'] }], ['d1']),
    },
  });
  deliver.route(night, ev({ dedupeKey: 'n1', summary: 'Added: Dune (2021)' }));
  deliver.route(night, ev({ type: 'playback.started', dedupeKey: 'n2', summary: '▶️ Someone started Dune' }));
  deliver.route(night, ev({ type: 'app.down', severity: 'error', dedupeKey: 'n3', summary: '🔴 Plex is down' }));
  await deliver.deliverNow(night);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].title, 'Plex is down', 'only the urgent one, emoji left off the title');
  const st = Object.fromEntries(store.recent().map(e => [e.dedupeKey, e.status]));
  assert.deepEqual(st, { n1: 'held', n2: 'skipped', n3: 'sent' });
  await deliver.deliverNow(night);
  assert.equal(posts.length, 1, 'still quiet');

  store.close(); // a restart: held events are in hub.db, not in memory
  const morning = { ...night, notifications: { targets, quiet: { ...night.notifications.quiet, enabled: false } } };
  await deliver.deliverNow(morning);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].embeds[0].description, '🌙 Added: Dune \\(2021\\)');
  assert.equal(store.recent().find(e => e.dedupeKey === 'n1')?.status, 'sent');
});

test('notify.handle: when the hub takes a round nothing is sent from notify; when it can’t, notify sends as always', async t => {
  /** @type {any[]} */
  const posts = [];
  const srv = await fakeServer({
    '/ok': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      posts.push(JSON.parse(body));
      return { status: 204 };
    },
  });
  t.after(() => srv.close());
  const cfg = /** @type {any} */ ({
    notifications: {
      targets: [
        { id: 'd1', type: 'discord', name: 'Ops', enabled: true, webhookUrl: `${srv.url}/ok`, events: { down: true } },
      ],
    },
  });
  /** @param {boolean} up */
  const poll = up =>
    /** @type {any} */ ({ services: [{ id: 's1', kind: 'sonarr', name: 'Sonarr', up, error: 'Timed out' }] });
  await notify.handle(poll(true), [], [], cfg); // first poll only learns
  await notify.handle(poll(false), [], [], cfg);
  /** @type {any[]} */
  let taken = [];
  const found = await notify.handle(poll(false), [], [], cfg, [], f => ((taken = f), true));
  assert.equal(found[0].kind, 'down');
  assert.equal(found[0].ref, 's1', 'the app id travels with it, for a stable dedupe key');
  assert.deepEqual(taken, found);
  assert.equal(posts.length, 0, 'the hub took it');
  await notify.handle(poll(true), [], [], cfg, [], () => false);
  assert.equal(posts.length, 1, 'the hub could not: sent the usual way');
  assert.match(posts[0].embeds[0].title, /Sonarr is back up/);
});
