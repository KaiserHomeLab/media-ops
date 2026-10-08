// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings login: in-memory sessions and the per-address lockout against password guessing.
'use strict';
const crypto = require('node:crypto');
const config = require('./config');

// Sessions are kept in memory: a restart signs everyone out of Settings, which is fine for an
// admin page and means no session secrets are ever written to disk.
const sessions = new Map(); // token -> expiry
const SESSION_DAYS = 30;

/** @param {import('node:http').IncomingMessage} req @param {string} name */
function cookie(req, name) {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
}
/** @param {import('node:http').IncomingMessage} req */
function loggedIn(req) {
  if (!config.load().auth) return true;
  const t = cookie(req, 'mo_session');
  const exp = t && sessions.get(t);
  return !!exp && exp > Date.now();
}
// Served over https (directly or behind a reverse proxy): the cookie is then marked Secure.
/** @param {import('node:http').IncomingMessage} req */
const isHttps = req =>
  /** @type {import('node:tls').TLSSocket} */ (req.socket).encrypted ||
  String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim() === 'https';
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function startSession(req, res) {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, now + SESSION_DAYS * 864e5);
  res.setHeader(
    'Set-Cookie',
    `mo_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`,
  );
}

// Password guessing: 10 wrong passwords (or reset codes) from one address in 15 minutes locks
// that address out for the rest of the window. On top of the 0.8 s delay per wrong answer,
// which alone wouldn't stop many guesses sent in parallel.
const FAIL_WINDOW = 15 * 60e3,
  FAIL_MAX = 10;
const failures = new Map(); // ip -> { n, since }
/** @param {import('node:http').IncomingMessage} req */
const clientIp = req => req.socket.remoteAddress || '?';
/** @param {import('node:http').IncomingMessage} req */
function lockedOut(req) {
  const f = failures.get(clientIp(req));
  if (!f || Date.now() - f.since > FAIL_WINDOW) return 0;
  return f.n >= FAIL_MAX ? Math.ceil((f.since + FAIL_WINDOW - Date.now()) / 60e3) : 0;
}
/** @param {import('node:http').IncomingMessage} req */
function noteFailure(req) {
  const ip = clientIp(req),
    now = Date.now();
  const f = failures.get(ip);
  failures.set(ip, f && now - f.since < FAIL_WINDOW ? { n: f.n + 1, since: f.since } : { n: 1, since: now });
  if (failures.size > 1000) for (const [k, v] of failures) if (now - v.since > FAIL_WINDOW) failures.delete(k);
}

module.exports = { sessions, cookie, loggedIn, startSession, lockedOut, noteFailure };
