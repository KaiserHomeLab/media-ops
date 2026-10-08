// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification destinations that need more than a fake web server: Telegram (fixed address,
// token in the URL), email (our own SMTP client against a fake mail server), and keeping
// secrets out of error messages.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, fakeSmtp } = require('./helpers');

// Catch calls to api.telegram.org before lib/notify.js captures `req`.
const http = require('../lib/http');
const realReq = http.req;
/** @type {{ url: string, body: any }[]} */
const telegramCalls = [];
let telegramReply = () => 'ok';
http.req = async (url, opts) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return realReq(url, opts);
  telegramCalls.push({ url, body: JSON.parse(opts.body) });
  return telegramReply(url);
};
const notify = require('../lib/notify');
const smtp = require('../lib/smtp');

const message = { title: 'Media Ops: 1 alert', lines: ['❌ Sonarr: Disk full', 'second line'], level: 'error' };

test('telegram: plain-text message to the chat; chat id checked', async () => {
  const t = notify.mergeTarget(null, { type: 'telegram', botToken: '123456:ABC-secret', chatId: '-1001234' });
  await notify.test(t);
  const call = telegramCalls.at(-1);
  assert.equal(call.url, 'https://api.telegram.org/bot123456:ABC-secret/sendMessage');
  assert.equal(call.body.chat_id, '-1001234');
  assert.equal(call.body.parse_mode, undefined, 'no Markdown/HTML: app text could inject links');
  assert.match(call.body.text, /^Media Ops test notification\n\n✅/);
  assert.throws(
    () => notify.mergeTarget(null, { type: 'telegram', botToken: 'x', chatId: 'me; drop' }),
    /Chat ID must be/,
  );
  assert.equal(
    notify.mergeTarget(null, { type: 'telegram', botToken: 'x', chatId: '@my_channel' }).chatId,
    '@my_channel',
  );
});

test('send errors never show a secret, even when it is part of the address', async t => {
  telegramReply = url => {
    throw new Error(`HTTP 401 on ${new URL(url).pathname}`);
  };
  const tg = notify.mergeTarget(null, { type: 'telegram', botToken: '123456:ABC-secret', chatId: '42' });
  await assert.rejects(notify.test(tg), e => {
    assert.equal(e.message, 'HTTP 401 on /bot•••/sendMessage');
    return true;
  });
  telegramReply = () => 'ok';

  const srv = await fakeServer({}); // every path is a 404
  t.after(() => srv.close());
  const discord = notify.mergeTarget(null, { type: 'discord', webhookUrl: `${srv.url}/api/webhooks/1/tok-en_SECRET` });
  await assert.rejects(notify.test(discord), e => {
    assert.doesNotMatch(e.message, /tok-en_SECRET/);
    assert.match(e.message, /HTTP 404/);
    return true;
  });
});

test('email: STARTTLS, login, headers and body; password only after encryption', async t => {
  const mail = await fakeSmtp({ starttls: true });
  t.after(() => mail.close());
  await smtp.sendMail({
    host: '127.0.0.1',
    port: mail.port,
    username: 'me@example.com',
    password: 'app-password',
    from: 'media-ops@example.com',
    to: 'me@example.com, other@example.com',
    subject: message.title + ' ❌',
    text: '.leading dot\nline two',
    tlsOptions: mail.tlsOptions,
  });
  const s = mail.sessions.at(-1);
  assert.equal(s.encrypted, true);
  assert.deepEqual(s.auth, { user: 'me@example.com', pass: 'app-password' });
  assert.equal(s.from, '<media-ops@example.com>');
  assert.deepEqual(s.to, ['<me@example.com>', '<other@example.com>']);
  const [head, body] = s.data.split('\n\n');
  assert.match(head, /^From: Media Ops <media-ops@example.com>$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  const subject = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(m => Buffer.from(m[1], 'base64')).join('');
  assert.equal(subject, 'Media Ops: 1 alert ❌');
  assert.equal(Buffer.from(body.replace(/\s/g, ''), 'base64').toString(), '.leading dot\r\nline two');
});

test('email: no password over an unencrypted connection; a relay without login works', async t => {
  const plain = await fakeSmtp({ starttls: false });
  t.after(() => plain.close());
  const base = {
    host: '127.0.0.1',
    port: plain.port,
    from: 'a@example.com',
    to: 'b@example.com',
    subject: 'x',
    text: 'y',
  };
  await assert.rejects(smtp.sendMail({ ...base, username: 'a', password: 'secret' }), /doesn't offer encryption/);
  assert.equal(plain.sessions.at(-1).auth, null, 'the password was never sent');
  await smtp.sendMail(base);
  assert.equal(plain.sessions.at(-1).to[0], '<b@example.com>');
});

test('email: port 465 is encrypted from the start; AUTH LOGIN when the server has no PLAIN', async t => {
  const mail = await fakeSmtp({ tls: true, auth: 'LOGIN' });
  t.after(() => mail.close());
  await smtp.sendMail({
    host: '127.0.0.1',
    port: 465,
    from: 'a@example.com',
    to: 'b@example.com',
    subject: 'x',
    text: 'y',
    username: 'u',
    password: 'p',
    tlsOptions: { ...mail.tlsOptions, port: mail.port }, // 465 picks implicit TLS; the fake listens elsewhere
  });
  assert.equal(mail.sessions.at(-1).encrypted, true);
  assert.deepEqual(mail.sessions.at(-1).auth, { user: 'u', pass: 'p' });
});

test('email: a certificate that does not match is refused', async t => {
  const mail = await fakeSmtp({ starttls: true });
  t.after(() => mail.close());
  await assert.rejects(
    smtp.sendMail({
      host: '127.0.0.1',
      port: mail.port,
      from: 'a@example.com',
      to: 'b@example.com',
      subject: 'x',
      text: 'y',
      username: 'u',
      password: 'p',
      tlsOptions: { ca: mail.tlsOptions.ca, servername: 'smtp.example.com' },
    }),
    /altnames|does not match|Hostname\/IP/i,
  );
  assert.equal(mail.sessions.at(-1).auth, null);
});

test('email settings: addresses checked (no header injection), password only reused for the same server', () => {
  const base = {
    type: 'email',
    smtpHost: 'smtp.example.com',
    password: 'pw',
    from: 'a@example.com',
    to: 'b@example.com',
  };
  const t = notify.mergeTarget(null, base);
  assert.equal(t.smtpPort, '587');
  assert.throws(
    () => notify.mergeTarget(null, { ...base, from: 'a@example.com\r\nBcc: x@evil.example' }),
    /From must be/,
  );
  assert.throws(() => notify.mergeTarget(null, { ...base, to: 'b@example.com>, <x@evil.example' }), /To must be/);
  assert.throws(() => notify.mergeTarget(null, { ...base, smtpHost: 'smtp.example.com:25' }), /Mail server must be/);
  assert.throws(() => notify.mergeTarget(null, { ...base, smtpPort: '99999' }), /Port must be/);
  assert.equal(notify.mergeTarget(t, { ...base, password: '' }).password, 'pw', 'blank keeps the saved password');
  assert.throws(
    () => notify.mergeTarget(t, { ...base, smtpHost: 'smtp.evil.example', password: '' }),
    /Re-enter the Password/,
  );
  assert.throws(() => notify.mergeTarget(t, { ...base, smtpPort: '2525', password: '' }), /Re-enter the Password/);
  assert.equal(notify.publicTarget(t).password, undefined);
});
