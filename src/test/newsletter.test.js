// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub email: the HTML digest (escaped, posters), one copy per newsletter address
// with its own signed unsubscribe link and List-Unsubscribe headers, and unsubscribing (asks on
// GET, removes on POST, refuses a tampered link), against a fake mail server.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-newsletter-'));
process.env.CONFIG = path.join(dir, 'config.json');
process.env.HUB_DB = path.join(dir, 'hub.db');
const { fakeSmtp } = require('./helpers');
const config = require('../lib/config');
const newsletter = require('../lib/hub/newsletter');
const digests = require('../lib/hub/digests');
const { finish, media, dedupeKey } = require('../lib/hub/normalize');

/** @type {import('../lib/hub/digests').Digest} */
const D = {
  id: 'added_daily',
  title: 'Added to Plex',
  enabled: true,
  cron: '0 8 * * *',
  timezone: '',
  destinations: ['m1'],
  skipIfEmpty: true,
  maxItemsPerSection: 25,
  footer: '',
  recipients: ['ann@example.com', 'bob@example.com'],
};
/** @param {Record<string, any>} m */
const added = m => {
  const md = media(m);
  return finish(
    { source: 'radarr', sourceInstance: 'radarr', raw: null },
    { type: 'media.added', severity: 'info', summary: '', media: md, isUpgrade: false, dedupeKey: dedupeKey(md) },
  );
};
const built = () =>
  digests.build(D, [
    added({
      kind: 'movie',
      title: '<script>alert(1)</script>',
      year: 2020,
      library: 'Movies',
      ids: { tmdb: 1 },
      posterUrl: 'https://img.example/p.jpg',
    }),
    added({ kind: 'movie', title: 'M*A*S*H', year: 1970, library: 'Movies', ids: { tmdb: 651 } }),
  ]);

/** @param {string} data a message as the fake server got it @returns {{ head: string, parts: Record<string, string> }} */
function parse(data) {
  const [head, ...rest] = data.split('\n\n');
  const body = rest.join('\n\n');
  /** @type {Record<string, string>} */
  const parts = {};
  for (const m of body.matchAll(
    /Content-Type: (text\/\w+); charset=utf-8\nContent-Transfer-Encoding: base64\n\n([\s\S]*?)\n--/g,
  ))
    parts[m[1]] = Buffer.from(m[2].replace(/\s/g, ''), 'base64').toString();
  return { head, parts };
}

test('html: everything escaped, posters as a grid, an unsubscribe link only when there is one', () => {
  const b = built();
  const h = newsletter.html(b, 'https://media.example.com/hub/unsubscribe?d=x&e=y&s=z');
  assert.ok(!h.includes('<script>alert'), 'titles are escaped');
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt; (2020)'));
  assert.ok(h.includes('<img src="https://img.example/p.jpg"'));
  assert.ok(h.includes('<li style="margin:2px 0">M*A*S*H (1970)</li>'), 'no poster: a list line, as written');
  assert.ok(h.includes('href="https://media.example.com/hub/unsubscribe?d=x&amp;e=y&amp;s=z"'));
  assert.ok(!newsletter.html(b, null).includes('Unsubscribe'));
});

test('sendDigest: each newsletter address gets its own copy, HTML and text, with its own unsubscribe link', async t => {
  const mail = await fakeSmtp({ starttls: false });
  t.after(() => mail.close());
  config.save({ hub: { enabled: true, sources: [], publicUrl: 'https://media.example.com' } });
  /** @type {any} */
  const target = {
    id: 'm1',
    type: 'email',
    name: 'Mail',
    enabled: true,
    smtpHost: '127.0.0.1',
    smtpPort: String(mail.port),
    from: 'plex@example.com',
    to: 'me@example.com',
    events: {},
  };
  const b = built();
  const r = await newsletter.sendDigest(config.load(), D, b, digests.asText(b), target);
  assert.deepEqual(r, { sent: 2, failed: 0 });
  assert.deepEqual(
    mail.sessions.map(s => s.to),
    [['<ann@example.com>'], ['<bob@example.com>']],
    'one message per address: nobody sees the others',
  );
  const { head, parts } = parse(mail.sessions[0].data);
  assert.match(head, /^From: Added to Plex <plex@example.com>$/m);
  assert.match(head, /^To: ann@example.com$/m);
  assert.match(head, /^Content-Type: multipart\/alternative; boundary="mo-/m);
  assert.match(head, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  const link = /** @type {RegExpMatchArray} */ (head.match(/^List-Unsubscribe: <(.+)>$/m))[1];
  assert.match(link, /^https:\/\/media\.example\.com\/hub\/unsubscribe\?d=added_daily&e=/);
  assert.ok(parts['text/plain'].endsWith(`Unsubscribe: ${link}`));
  assert.ok(parts['text/html'].includes('Unsubscribe</a>'));
  const ann = new URL(link).searchParams;
  const bob = new URL(
    /** @type {RegExpMatchArray} */ (parse(mail.sessions[1].data).head.match(/^List-Unsubscribe: <(.+)>$/m))[1],
  ).searchParams;
  assert.notEqual(ann.get('s'), bob.get('s'), 'a link of its own');
  assert.deepEqual(newsletter.verify(ann), { digestId: 'added_daily', email: 'ann@example.com' });
  ann.set('e', Buffer.from('mallory@example.com').toString('base64url'));
  assert.equal(newsletter.verify(ann), null, 'a link changed to another address is refused');

  await newsletter.sendDigest(config.load(), { ...D, recipients: [] }, b, digests.asText(b), target);
  const own = parse(mail.sessions.at(-1).data).head;
  assert.match(own, /^To: me@example.com$/m, 'no newsletter list: the destination’s own address');
  assert.doesNotMatch(own, /List-Unsubscribe/);
  config.save({ hub: { enabled: true, sources: [] } });
  await assert.rejects(newsletter.sendDigest(config.load(), D, b, digests.asText(b), target), /Set the public address/);
});

/** @param {string} method @param {string} url */
async function call(method, url) {
  /** @type {{ status: number, body: string }} */
  const out = { status: 0, body: '' };
  const res = /** @type {any} */ ({
    writeHead: (/** @type {number} */ s) => (out.status = s),
    setHeader() {},
    end: (/** @type {string} */ b) => (out.body = String(b ?? '')),
  });
  await newsletter.unsubscribe(
    /** @type {any} */ ({ method, headers: {}, resume() {} }),
    res,
    new URL(url, 'http://x'),
  );
  return out;
}

test('unsubscribe: GET asks, POST removes just that address from just that digest; a bad link is refused', async () => {
  config.save({
    hub: {
      enabled: true,
      sources: [],
      publicUrl: 'https://media.example.com',
      digests: [D, { ...D, id: 'weekly', title: 'Weekly' }],
    },
  });
  const link = newsletter.unsubscribeUrl(
    'https://media.example.com',
    newsletter.secret(),
    'added_daily',
    'Ann@Example.com',
  );
  const u = new URL(link);
  const ask = await call('GET', u.pathname + u.search);
  assert.equal(ask.status, 200);
  assert.match(ask.body, /Unsubscribe\?[\s\S]*Ann@Example\.com[\s\S]*<form method="post"/);
  assert.deepEqual(
    config.load().hub?.digests?.[0].recipients,
    ['ann@example.com', 'bob@example.com'],
    'opening the link changes nothing (mail apps open links on their own)',
  );
  const done = await call('POST', u.pathname + u.search);
  assert.match(done.body, /Unsubscribed/);
  assert.deepEqual(config.load().hub?.digests?.[0].recipients, ['bob@example.com'], 'case doesn’t matter');
  assert.deepEqual(
    config.load().hub?.digests?.[1].recipients,
    ['ann@example.com', 'bob@example.com'],
    'other digests untouched',
  );
  const bad = await call(
    'POST',
    `${u.pathname}?d=added_daily&e=${Buffer.from('bob@example.com').toString('base64url')}&s=${u.searchParams.get('s')}`,
  );
  assert.equal(bad.status, 400);
  assert.deepEqual(config.load().hub?.digests?.[0].recipients, ['bob@example.com']);
});

test('digest settings: newsletter addresses checked and de-duplicated', () => {
  const [d] = digests.clean([{ ...D, recipients: 'a@example.com, B@example.com\nb@example.com' }], ['m1']);
  assert.deepEqual(d.recipients, ['a@example.com', 'B@example.com']);
  assert.throws(() => digests.clean([{ ...D, recipients: ['not an address'] }], []), /isn't an email address/);
});
