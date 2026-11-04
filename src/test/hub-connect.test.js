// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub, connecting an app: how it should reach Media Ops (its saved address, and
// Docker's networks when the container list is there), and "Set it up for me" against a fake
// Radarr and a fake Seerr: the right webhook, a test before saving, updating rather than
// duplicating, and never taking over Seerr's one webhook without asking.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer } = require('./helpers');
const connect = require('../lib/hub/connect');

/** @param {string} id @param {string} name @param {string[]} nets */
const container = (id, name, nets) => ({
  Id: id,
  Names: [`/${name}`],
  NetworkSettings: { Networks: Object.fromEntries(nets.map(n => [n, {}])) },
});
const radarr = { name: 'Radarr', url: 'http://radarr:7878' };

test('looksDocker: container names yes; IPs, domains and localhost no', () => {
  for (const h of ['radarr', 'sonarr-anime', 'media_ops']) assert.ok(connect.looksDocker(h), h);
  for (const h of ['192.168.1.10', 'radarr.lan', 'host.docker.internal', 'localhost', '1234', ''])
    assert.ok(!connect.looksDocker(h), h);
});

test('suggest: from the saved address alone, and with Docker confirming (or not) a shared network', () => {
  let s = connect.suggest({ service: radarr, containers: null, hostname: 'abc', port: 8484 });
  assert.equal(s.recommend, 'docker', 'a plain name means Docker');
  assert.equal(s.dockerBase, 'http://media-ops:8484', 'the usual name, and the port inside the container');
  assert.match(String(s.note), /Radarr is at http:\/\/radarr:7878/);

  s = connect.suggest({
    service: { name: 'Radarr', url: 'http://192.168.1.20:7878' },
    containers: null,
    hostname: 'abc',
    port: 8484,
  });
  assert.equal(s.recommend, 'host');
  assert.equal(connect.suggest({ service: null, containers: null, hostname: 'x', port: 8484 }).recommend, 'host');

  const self = container('3f2a9c1b7d4e0000', 'mediaops', ['media', 'bridge']);
  s = connect.suggest({
    service: radarr,
    containers: [self, container('ff00', 'radarr', ['media'])],
    hostname: '3f2a9c1b7d4e',
    port: 9000,
  });
  assert.deepEqual([s.recommend, s.self, s.appContainer, s.shared], ['docker', 'mediaops', 'radarr', ['media']]);
  assert.equal(s.dockerBase, 'http://mediaops:9000', 'its real container name');
  assert.match(String(s.note), /share the Docker network “media”/);

  s = connect.suggest({
    service: radarr,
    containers: [self, container('ff00', 'radarr', ['arr'])],
    hostname: '3f2a9c1b7d4e',
    port: 8484,
  });
  assert.equal(s.recommend, 'host', 'Docker says they share no network');
  assert.match(String(s.warning), /aren’t on the same Docker network[\s\S]*docker network connect arr mediaops/);

  s = connect.suggest({
    service: radarr,
    containers: [container('3f2a9c1b7d4e', 'mediaops', ['bridge']), container('ff00', 'radarr', ['bridge'])],
    hostname: '3f2a9c1b7d4e',
    port: 8484,
  });
  assert.equal(s.recommend, 'host', "Docker's default bridge network has no name lookup");
  assert.ok(s.warning);

  s = connect.suggest({
    service: radarr,
    containers: [container('3f2a9c1b7d4e', 'mediaops', ['host'])],
    hostname: '3f2a9c1b7d4e',
    port: 8484,
  });
  assert.equal(s.recommend, 'host');
  assert.match(String(s.note), /host network/);
});

const HOOK = 'http://media-ops:8484/api/hub/in/radarr/radarr?token=mohub_SECRET';

test('setUp, Radarr: tests first, then adds a "Media Ops" webhook with the right events', async t => {
  /** @type {any[]} */
  const seen = [];
  const srv = await fakeServer({
    'GET /api/v3/notification': [],
    'POST /api/v3/notification/test': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      seen.push(['test', JSON.parse(body), req.headers['x-api-key']]);
      return { status: 200, body: '' };
    },
    'POST /api/v3/notification': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      seen.push(['save', JSON.parse(body)]);
      return { id: 9 };
    },
  });
  t.after(() => srv.close());
  const r = await connect.setUp({ kind: 'radarr', name: 'Radarr', url: srv.url, apiKey: 'rk' }, HOOK, 'mohub_SECRET');
  assert.deepEqual(r, { updated: false });
  assert.deepEqual(
    seen.map(x => x[0]),
    ['test', 'save'],
    'the test runs before anything is saved',
  );
  assert.equal(seen[0][2], 'rk', 'with the saved API key');
  const body = seen[1][1];
  assert.equal(body.name, 'Media Ops');
  assert.equal(body.implementation, 'Webhook');
  assert.deepEqual(
    body.fields.find((/** @type {any} */ f) => f.name === 'url'),
    { name: 'url', value: HOOK },
  );
  assert.equal(body.onDownload, true);
  assert.equal(body.onUpgrade, true);
  assert.equal(body.onHealthIssue, true);
  assert.equal(body.onMovieFileDeleteForUpgrade, false, 'replacing a file is an upgrade, not a removal');
  assert.equal(body.onGrab, false);
});

test('setUp, Radarr: updates its existing Media Ops webhook; a failed test saves nothing and says why', async t => {
  /** @type {any[]} */
  const seen = [];
  const existing = {
    id: 5,
    name: 'Media Ops',
    implementation: 'Webhook',
    tags: [3],
    fields: [
      { name: 'url', value: 'http://old:8484/x' },
      { name: 'method', value: 2 },
      { name: 'username', value: 'kept' },
    ],
  };
  let failTest = false;
  const srv = await fakeServer({
    'GET /api/v3/notification': [{ id: 1, name: 'Discord', implementation: 'Discord' }, existing],
    'POST /api/v3/notification/test': () =>
      failTest
        ? {
            status: 400,
            body: JSON.stringify([
              { errorMessage: 'Unable to send test message: Connection refused (media-ops:8484) mohub_SECRET' },
            ]),
          }
        : { status: 200, body: '' },
    'PUT /api/v3/notification/5': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      seen.push(JSON.parse(body));
      return { id: 5 };
    },
  });
  t.after(() => srv.close());
  const svc = { kind: 'radarr', name: 'Radarr', url: srv.url, apiKey: 'rk' };
  assert.deepEqual(await connect.setUp(svc, HOOK, 'mohub_SECRET'), { updated: true });
  assert.equal(seen.length, 1, 'updated in place, not added twice');
  assert.deepEqual(seen[0].fields, [
    { name: 'url', value: HOOK },
    { name: 'method', value: 1 },
    { name: 'username', value: 'kept' },
  ]);
  assert.deepEqual(seen[0].tags, [3]);

  failTest = true;
  await assert.rejects(connect.setUp(svc, HOOK, 'mohub_SECRET'), e => {
    assert.match(
      e.message,
      /Radarr couldn't reach Media Ops at that address: Unable to send test message: Connection refused/,
    );
    assert.doesNotMatch(e.message, /mohub_SECRET/, 'the token never shows in an error');
    return true;
  });
  assert.equal(seen.length, 1, 'nothing saved after a failed test');
});

test('setUp, Seerr: asks before replacing its one webhook; then tests and saves, keeping the payload', async t => {
  /** @type {any[]} */
  const saved = [];
  let current = {
    enabled: true,
    types: 2,
    options: { webhookUrl: 'https://notifiarr.example/hook', jsonPayload: 'e30=' },
  };
  const srv = await fakeServer({
    'GET /api/v1/settings/notifications/webhook': () => current,
    'POST /api/v1/settings/notifications/webhook/test': { status: 204 },
    'POST /api/v1/settings/notifications/webhook': (
      /** @type {any} */ req,
      /** @type {any} */ url,
      /** @type {string} */ body,
    ) => {
      saved.push(JSON.parse(body));
      return {};
    },
  });
  t.after(() => srv.close());
  const svc = { kind: 'seerr', name: 'Seerr', url: srv.url, apiKey: 'sk' };
  const hook = 'http://media-ops:8484/api/hub/in/seerr/seerr?token=t0k';
  assert.deepEqual(await connect.setUp(svc, hook, 't0k'), { needsConfirm: true, current: 'notifiarr.example' });
  assert.equal(saved.length, 0, 'nothing changed without a yes');
  assert.deepEqual(await connect.setUp(svc, hook, 't0k', { replace: true }), { updated: true });
  assert.equal(saved[0].enabled, true);
  assert.equal(saved[0].options.webhookUrl, hook);
  assert.equal(saved[0].options.jsonPayload, 'e30=', 'their payload template is kept');
  assert.equal(saved[0].types, connect.SEERR_TYPES);
  assert.equal(saved[0].types & 32, 0, 'not the test-notification type');

  current = { enabled: false, types: 0, options: {} };
  saved.length = 0;
  await connect.setUp(svc, hook, 't0k');
  assert.ok(
    Buffer.from(saved[0].options.jsonPayload, 'base64').toString().includes('{{notification_type}}'),
    'Seerr’s default payload when none is saved',
  );
});
