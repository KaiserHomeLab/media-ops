// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Forgotten settings password: prove you control the server by reading a one-time code
// from the container log (or a file in the config folder), like Jellyfin's "forgot password".
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const TTL = 15 * 60e3;
const MAX_TRIES = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
const FILE = path.join(path.dirname(config.FILE), 'password-reset.txt');

/** @type {{ hash: Buffer, expires: number, tries: number, at: number } | null} */
let pending = null;

/** @param {string} s */
const sha = s => crypto.createHash('sha256').update(s).digest();
/** @param {unknown} code */
const normalize = code =>
  String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

function removeFile() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already gone */
  }
}

function request() {
  if (!config.load().auth) return { ok: false, error: 'No password is set' };
  // One new code per 30 s, so the button can't be used to spam the log.
  if (pending && Date.now() - pending.at < 30e3) return { ok: true, file: FILE, reused: true };

  const raw = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  pending = { hash: sha(raw), expires: Date.now() + TTL, tries: 0, at: Date.now() };

  const until = new Date(pending.expires).toLocaleTimeString();
  console.log(
    [
      '',
      '──────────────────────────────────────────',
      '  Media Ops: settings password reset',
      `  Reset code: ${code}   (valid until ${until})`,
      '  Enter it on the Settings login page.',
      "  Didn't ask for this? Ignore it: it expires.",
      '──────────────────────────────────────────',
      '',
    ].join('\n'),
  );
  try {
    fs.writeFileSync(
      FILE,
      `Media Ops password reset code: ${code}\nValid until ${until}. This file is deleted once it's used or expires.\n`,
      { mode: 0o600 },
    );
  } catch (e) {
    console.error(`Could not write ${FILE}: ${e.message}`);
  }
  setTimeout(() => {
    if (pending && pending.expires <= Date.now()) {
      pending = null;
      removeFile();
    }
  }, TTL + 1000).unref();
  return { ok: true, file: FILE };
}

// Returns null when the code is good (and consumes it), otherwise an error message.
/** @param {unknown} code */
function verify(code) {
  if (!pending) return 'No active code (it was used, expired, or the server restarted). Request a new one.';
  if (Date.now() > pending.expires) {
    pending = null;
    removeFile();
    return 'That code has expired. Request a new one.';
  }
  const ok = crypto.timingSafeEqual(sha(normalize(code)), pending.hash);
  if (ok) {
    pending = null;
    removeFile();
    return null;
  }
  if (++pending.tries >= MAX_TRIES) {
    pending = null;
    removeFile();
    return 'Too many wrong codes. Request a new one.';
  }
  const left = MAX_TRIES - pending.tries;
  return `Wrong code (${left} ${left === 1 ? 'try' : 'tries'} left)`;
}

module.exports = { request, verify, FILE };
