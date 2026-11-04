// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Discord output: Markdown escaping, a destination's name/avatar/colour, digests packed into
// Discord's limits, and webhooks that answer 429 or 5xx (waits, retries, order kept).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer } = require('./helpers');
const discord = require('../lib/discord');
const notify = require('../lib/notify');
discord.timing.retryMs = 1;

/** @type {any} */
const T = { id: 'd1', type: 'discord', name: 'News', enabled: true, webhookUrl: 'https://x', events: {} };

test('escape: titles show as written in Discord', () => {
  assert.equal(discord.escape('M*A*S*H'), 'M\\*A\\*S\\*H');
  assert.equal(
    discord.escape('_x_ ~y~ `z` |a| > b # c - d [e](f) \\'),
    '\\_x\\_ \\~y\\~ \\`z\\` \\|a\\| \\> b \\# c \\- d \\[e\\]\\(f\\) \\\\',
  );
  assert.equal(discord.escape('Plain words, 2024: ok!'), 'Plain words, 2024: ok!');
});

test('alert: a destination’s own name, avatar and colour; otherwise Media Ops and the level’s colour', () => {
  const plain = discord.alert(T, { title: 'M*A*S*H', lines: ['a_b'], color: 0x123456 });
  assert.equal(plain.username, 'Media Ops');
  assert.ok(!('avatar_url' in plain));
  assert.equal(plain.embeds[0].color, 0x123456);
  assert.equal(plain.embeds[0].title, 'M\\*A\\*S\\*H');
  assert.equal(plain.embeds[0].description, 'a\\_b');
  assert.deepEqual(plain.allowed_mentions, { parse: [] }, '@everyone in a log line never pings');
  const branded = discord.alert(
    { ...T, username: 'Plex Bot', avatarUrl: 'https://example.com/i.png', color: '#E5A00D' },
    { title: 't', lines: [], color: 1 },
  );
  assert.deepEqual(
    [branded.username, branded.avatar_url, branded.embeds[0].color],
    ['Plex Bot', 'https://example.com/i.png', 0xe5a00d],
  );
  assert.ok(
    !('avatar_url' in discord.alert({ ...T, avatarUrl: 'http://insecure/i.png' }, { title: 't', lines: [], color: 1 })),
  );
});

/** @param {number} n @param {Partial<{ posterUrl: string | null, overview: string | null }>} [over] */
const movies = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({
    line: `Film ${i + 1} (2020)`,
    posterUrl: `https://img.example/${i}.jpg`,
    overview: `Film ${i + 1} is good. More words.`,
    ...over,
  }));

test('digest: four movies with posters each get a small embed; more is a list; the footer goes last', () => {
  const few = movies(2);
  const [m] = discord.digest(T, {
    title: 'Added to Plex · Wednesday, Nov 4',
    sections: [
      { name: 'Movies', lines: few.map(i => i.line), more: 0, items: few },
      { name: 'TV Shows', lines: ['Severance: Season 2, episodes 1–3'], more: 0 },
    ],
    footer: '3 new · 1 upgraded quietly',
  });
  assert.equal(m.content, '**Added to Plex** · Wednesday, Nov 4');
  assert.deepEqual(
    m.embeds.map((/** @type {any} */ e) => [e.author?.name ?? null, e.title, e.thumbnail?.url ?? null]),
    [
      ['MOVIES', 'Film 1 \\(2020\\)', 'https://img.example/0.jpg'],
      ['MOVIES', 'Film 2 \\(2020\\)', 'https://img.example/1.jpg'],
      [null, 'TV Shows', null],
    ],
  );
  assert.equal(m.embeds[0].description, 'Film 1 is good.', 'one line about it');
  assert.equal(m.embeds[2].footer.text, '3 new · 1 upgraded quietly');
  assert.ok(!m.embeds[0].footer);

  const many = movies(6);
  const [list] = discord.digest(T, {
    title: 'x',
    sections: [{ name: 'Movies', lines: many.map(i => i.line), more: 0, items: many }],
    footer: '',
  });
  assert.equal(list.embeds.length, 1);
  assert.equal(list.embeds[0].description.split('\n').length, 6);
  const noPosters = movies(2, { posterUrl: null });
  const [plain] = discord.digest(T, {
    title: 'x',
    sections: [{ name: 'Movies', lines: noPosters.map(i => i.line), more: 0, items: noPosters }],
    footer: '',
  });
  assert.equal(plain.embeds.length, 1, 'without posters, a list');
});

test('digest: long sections continue in another embed, and messages stay within 10 embeds and 6000 characters', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `Show number ${i}: Season 1, episodes 1–10`);
  const sections = [
    { name: 'TV Shows', lines, more: 0 },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `Library ${i}`, lines: ['One title'], more: 0 })),
  ];
  const msgs = discord.digest(T, { title: 'Added to Plex · Wednesday, Nov 4', sections, footer: 'end' });
  assert.ok(msgs.length > 1);
  for (const m of msgs) {
    assert.ok(m.embeds.length <= 10, 'at most 10 embeds');
    const total = m.embeds.reduce(
      (/** @type {number} */ a, /** @type {any} */ e) =>
        a +
        (e.title?.length || 0) +
        (e.description?.length || 0) +
        (e.footer?.text?.length || 0) +
        (e.author?.name?.length || 0),
      0,
    );
    assert.ok(total <= 6000, `at most 6000 characters (${total})`);
    for (const e of m.embeds) assert.ok((e.description || '').length <= 4096);
  }
  assert.ok(msgs[0].content && msgs.slice(1).every(m => !('content' in m)), 'the title once, on the first message');
  const all = msgs.flatMap(m => m.embeds);
  assert.equal(all.filter((/** @type {any} */ e) => e.title === 'TV Shows').length, 1);
  assert.ok(all.some((/** @type {any} */ e) => e.title === 'TV Shows (continued)'));
  assert.equal(all.at(-1).footer.text, 'end');
  const shown = all
    .filter((/** @type {any} */ e) => /^TV Shows/.test(e.title))
    .flatMap((/** @type {any} */ e) => e.description.split('\n'));
  assert.equal(shown.length, 400, 'every line, none lost in the split');
});

test('post: a 429 waits as long as Discord says and retries; a 5xx three times; order is kept per webhook', async t => {
  /** @type {string[]} */
  const got = [];
  let limited = 1;
  const srv = await fakeServer({
    '/hook': (/** @type {any} */ req, /** @type {any} */ url, /** @type {string} */ body) => {
      const { n } = JSON.parse(body);
      if (n === 1 && limited-- > 0)
        return { status: 429, headers: { 'Retry-After': '0.05' }, body: '{"retry_after":0.05}' };
      got.push(n);
      return { status: 204 };
    },
    '/down': { status: 502 },
  });
  t.after(() => srv.close());
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(n => discord.post(`${srv.url}/hook`, { n })));
  assert.deepEqual(got, [1, 2, 3], 'the rate-limited one was not lost, and 2 and 3 waited behind it');
  assert.ok(Date.now() - t0 >= 45, 'it waited');
  await assert.rejects(discord.post(`${srv.url}/down`, { n: 9 }), /HTTP 502/);
  assert.equal(srv.calls.filter((/** @type {any} */ c) => c.path === '/down').length, 3);
  await discord.post(`${srv.url}/hook`, { n: 4 });
  assert.deepEqual(got, [1, 2, 3, 4], 'a failure on one webhook does not block later sends');
});

test('destination form: Discord name, https avatar and #RRGGBB colour; changing the avatar keeps the saved webhook', () => {
  const saved = notify.mergeTarget(null, {
    type: 'discord',
    webhookUrl: 'https://discord.com/api/webhooks/1/abc',
    color: 'e5a00d',
    username: 'Plex',
  });
  assert.equal(saved.color, '#e5a00d');
  const moved = notify.mergeTarget(saved, { ...saved, webhookUrl: '', avatarUrl: 'https://cdn.example/icon.png' });
  assert.equal(moved.webhookUrl, saved.webhookUrl, 'the avatar is not where messages go');
  assert.throws(
    () => notify.mergeTarget(null, { type: 'discord', webhookUrl: 'https://d/x', avatarUrl: 'http://x/i.png' }),
    /Avatar URL must start with https/,
  );
  assert.throws(
    () => notify.mergeTarget(null, { type: 'discord', webhookUrl: 'https://d/x', color: 'gold' }),
    /Colour must look like/,
  );
});
