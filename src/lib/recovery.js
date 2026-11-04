// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// One-time codes that prove you control the server: read from the container log (or a file in
// the config folder), like Jellyfin's "forgot password".
//   reset: a forgotten settings password. Asked for from the login page, valid 15 minutes.
//   setup: the first password (no password set yet). Printed at every start until one is set,
//          so nobody else on the network can set it before you.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const MAX_TRIES = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
const DIR = path.dirname(config.FILE);

/** @param {string} s */
const sha = s => crypto.createHash('sha256').update(s).digest();
/** @param {unknown} code */
const normalize = code =>
  String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * @param {{ file: string, ttl: number, title: string, label: string, where: string }} o
 */
function codes({ file, ttl, title, label, where }) {
  const FILE = path.join(DIR, file);
  /** @type {{ code: string, hash: Buffer, expires: number, tries: number, at: number } | null} */
  let pending = null;
  const removeFile = () => {
    try {
      fs.unlinkSync(FILE);
    } catch {
      /* already gone */
    }
  };
  const show = () => {
    if (!pending) return;
    const until = new Date(pending.expires).toLocaleString();
    console.log(
      [
        '',
        '──────────────────────────────────────────',
        `  Media Ops: ${title}`,
        `  ${label}: ${pending.code}   (valid until ${until})`,
        `  ${where}`,
        "  Didn't ask for this? Ignore it: it expires.",
        '──────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    try {
      fs.writeFileSync(
        FILE,
        `Media Ops ${label.toLowerCase()}: ${pending.code}\nValid until ${until}. This file is deleted once it's used or expires.\n`,
        { mode: 0o600 },
      );
    } catch (e) {
      console.error(`Could not write ${FILE}: ${e.message}`);
    }
  };
  const drop = () => {
    pending = null;
    removeFile();
  };

  // A code that's still valid is shown again, not replaced: asking over and over can't void the
  // one you're about to type. At most once per 30 s, so the button can't spam the log either.
  function ask() {
    if (pending && pending.expires > Date.now()) {
      if (Date.now() - pending.at >= 30e3) {
        pending.at = Date.now();
        show();
      }
      return { file: FILE, reused: true };
    }
    const raw = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    pending = {
      code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
      hash: sha(raw),
      expires: Date.now() + ttl,
      tries: 0,
      at: Date.now(),
    };
    show();
    const mine = pending;
    setTimeout(() => {
      if (pending === mine && mine.expires <= Date.now()) drop();
    }, ttl + 1000).unref();
    return { file: FILE, reused: false };
  }

  // Returns null when the code is good (and consumes it), otherwise an error message.
  /** @param {unknown} code */
  function verify(code) {
    if (!pending) return 'No active code (it was used, expired, or the server restarted). Request a new one.';
    if (Date.now() > pending.expires) {
      drop();
      return 'That code has expired. Request a new one.';
    }
    if (crypto.timingSafeEqual(sha(normalize(code)), pending.hash)) {
      drop();
      return null;
    }
    if (++pending.tries >= MAX_TRIES) {
      drop();
      return 'Too many wrong codes. Request a new one.';
    }
    const left = MAX_TRIES - pending.tries;
    return `Wrong code (${left} ${left === 1 ? 'try' : 'tries'} left)`;
  }

  return { request: ask, verify, FILE, clear: drop };
}

const reset = codes({
  file: 'password-reset.txt',
  ttl: 15 * 60e3,
  title: 'settings password reset',
  label: 'Reset code',
  where: 'Enter it on the Settings login page.',
});
const setup = codes({
  file: 'setup-code.txt',
  ttl: 7 * 864e5, // a new one at every start anyway
  title: 'set a settings password to finish setup',
  label: 'Setup code',
  where: 'Open Settings in your browser and enter it with the password you want.',
});

// Forgot password: only when there is one to reset.
/** @returns {{ ok: true, file: string } | { ok: false, error: string }} */
function request() {
  if (!config.load().auth) return { ok: false, error: 'No password is set' };
  return { ok: true, file: reset.request().file };
}

module.exports = { request, verify: reset.verify, FILE: reset.FILE, setup };
