// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Media Review's new Problem Reports as notifications, in a file of their own: notify keeps state per process.
const test = require('node:test');
const assert = require('node:assert/strict');
const notify = require('../lib/notify');
const { fakeServer } = require('./helpers');

/** @param {number} id @param {string} title */
const report = (id, title) => ({
  id,
  title,
  year: 2020,
  part: id === 2 ? 'S1 E2 · Two' : null,
  reason: 'Audio',
  reporters: [{ voter: 'alice', note: id === 2 ? 'no sound' : null }],
});
/** @param {any[] | null} reports null: Media Review couldn't list them */
const raw = reports => ({
  services: [
    { id: 'mr', name: 'Media Review', kind: 'mediareview', up: true, data: { problemReports: reports ?? [] } },
  ],
});

test("a friend's new Problem Report is sent once; those already there are not; on by default, and can be turned off", async t => {
  const got = /** @type {any[]} */ ([]);
  const srv = await fakeServer({
    'POST /hook': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      got.push(JSON.parse(body));
      return {};
    },
  });
  t.after(() => srv.close());
  // A destination saved before this event existed: it gets it, as the default says.
  const old = notify.mergeTarget(null, { type: 'webhook', url: `${srv.url}/hook` });
  delete old.events.problems;
  const off = { ...notify.mergeTarget(null, { type: 'webhook', url: `${srv.url}/off` }), id: 'off' };
  off.events.problems = false;
  const cfg = /** @type {any} */ ({ notifications: { targets: [old, off] } });
  assert.equal(notify.publicTarget(old).events.problems, true, 'the Settings form shows it on');

  await notify.handle(raw([report(1, 'Old One')]), [], [], cfg); // the first poll only learns
  await notify.handle(raw([report(1, 'Old One')]), [], [], cfg);
  assert.equal(got.length, 0);
  await notify.handle(raw([report(1, 'Old One'), report(2, 'Loud Show')]), [], [], cfg);
  assert.equal(got.length, 1);
  assert.equal(got[0].events[0].kind, 'problems');
  assert.equal(got[0].events[0].text, '⚑ Problem Report: Loud Show (2020), S1 E2 · Two: Audio, from alice: “no sound”');
  // A round that couldn't list them, then all of them again: nothing is new.
  await notify.handle(raw(null), [], [], cfg);
  await notify.handle(raw([report(1, 'Old One'), report(2, 'Loud Show')]), [], [], cfg);
  assert.equal(got.length, 1);
});
