// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// A small SMTP client for email notifications (Node has none built in, and Media Ops has no
// dependencies). Plain-text messages only. Port 465 starts encrypted; any other port upgrades
// with STARTTLS when the server offers it. A password is never sent unencrypted: a server
// without STARTTLS only works without a login (a local relay). Certificates are always checked.
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

// One header value: no line breaks (they would start a new header), and RFC 2047 encoding when
// it isn't plain ASCII (emoji in the title): chunks of whole characters, each encoded word
// within the 75-character limit, folded onto continuation lines.
const headerText = s => {
  const flat = String(s).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  const words = [];
  let chunk = '';
  for (const ch of flat) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
};
// A bare address: something@something, nothing that could break out of <…> or a command.
const ADDRESS = /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+$/;
const isAddress = a => ADDRESS.test(String(a || ''));
const addressList = s =>
  String(s || '')
    .split(/[,;\s]+/)
    .filter(Boolean);

// Reads SMTP replies ("250-first\r\n250 last\r\n") from whichever socket is current.
function replies() {
  let buf = '';
  let lines = [];
  /** @type {{ code: number, text: string }[]} */
  const ready = [];
  /** @type {{ resolve: (r: { code: number, text: string }) => void, reject: (e: Error) => void }[]} */
  const waiting = [];
  /** @type {Error | null} */
  let failed = null;
  const deliver = r => (waiting.length ? waiting.shift()?.resolve(r) : ready.push(r));
  return {
    /** @param {Buffer | string} chunk */
    data(chunk) {
      buf += chunk;
      if (buf.length > 64 * 1024) return this.fail(new Error('SMTP reply too long'));
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          deliver({ code: Number(line.slice(0, 3)), text: lines.map(l => l.slice(4)).join('\n') });
          lines = [];
        }
      }
    },
    /** @param {Error} e */
    fail(e) {
      failed ??= e;
      while (waiting.length) waiting.shift()?.reject(e);
    },
    /** @returns {Promise<{ code: number, text: string }>} */
    next() {
      if (ready.length) return Promise.resolve(/** @type {{ code: number, text: string }} */ (ready.shift()));
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

/**
 * @param {{ host: string, port: number, username?: string, password?: string, from: string,
 *   to: string, subject: string, text: string, timeout?: number, tlsOptions?: tls.ConnectionOptions }} m
 *   tlsOptions is for tests (a test certificate authority); Settings never sets it.
 */
async function sendMail(m) {
  const to = addressList(m.to);
  if (!isAddress(m.from)) throw new Error('The From address is not valid');
  if (!to.length || !to.every(isAddress)) throw new Error('The To address is not valid');
  const port = Number(m.port) || 587;
  const timeout = m.timeout ?? 15000;
  const secureOpts = { host: m.host, port, servername: net.isIP(m.host) ? undefined : m.host, ...m.tlsOptions };

  const r = replies();
  /** @type {net.Socket} */
  let sock = await new Promise((resolve, reject) => {
    const s = port === 465 ? tls.connect(secureOpts) : net.connect({ host: m.host, port });
    s.once(port === 465 ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeout, () => s.destroy(new Error('Timed out')));
  });
  const listen = s => {
    s.on('data', d => r.data(d));
    s.on('error', e => r.fail(e));
    s.on('close', () => r.fail(new Error('The mail server closed the connection')));
  };
  listen(sock);

  /** @param {string} line @param {number[]} ok @param {string} [shown] what errors say was sent */
  const cmd = async (line, ok, shown = line) => {
    if (line) sock.write(`${line}\r\n`);
    const reply = await r.next();
    if (!ok.includes(reply.code)) throw new Error(`Mail server refused ${shown}: ${reply.code} ${reply.text}`);
    return reply;
  };

  try {
    await cmd('', [220], 'the connection');
    let caps = (await cmd('EHLO media-ops', [250])).text.toUpperCase().split('\n');
    let encrypted = port === 465;
    if (!encrypted && caps.includes('STARTTLS')) {
      await cmd('STARTTLS', [220]);
      sock.removeAllListeners('data');
      const plain = sock;
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ ...secureOpts, socket: plain });
        s.once('secureConnect', () => resolve(s));
        s.once('error', reject);
      });
      listen(sock);
      encrypted = true;
      caps = (await cmd('EHLO media-ops', [250])).text.toUpperCase().split('\n');
    }
    if (m.username) {
      if (!encrypted)
        throw new Error("The mail server doesn't offer encryption (STARTTLS), so the password wasn't sent");
      const auth = caps.find(c => c.startsWith('AUTH')) || '';
      if (/\bPLAIN\b/.test(auth)) {
        const token = Buffer.from(`\0${m.username}\0${m.password || ''}`).toString('base64');
        await cmd(`AUTH PLAIN ${token}`, [235], 'the login');
      } else {
        await cmd('AUTH LOGIN', [334], 'the login');
        await cmd(Buffer.from(m.username).toString('base64'), [334], 'the login');
        await cmd(Buffer.from(m.password || '').toString('base64'), [235], 'the login');
      }
    }
    await cmd(`MAIL FROM:<${m.from}>`, [250]);
    for (const a of to) await cmd(`RCPT TO:<${a}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
    const message = [
      `From: Media Ops <${m.from}>`,
      `To: ${to.join(', ')}`,
      `Subject: ${headerText(m.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@media-ops>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
    // Base64 lines never start with ".", so the message needs no dot-stuffing.
    await cmd(`${message}\r\n.`, [250], 'the message');
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}

module.exports = { sendMail, isAddress, addressList, headerText };
