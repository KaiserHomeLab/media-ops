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
// No password yet, and not run without one on purpose: Settings asks for the setup code and a
// password first, and nothing can be changed until then (demo mode has no real apps, so it's open).
const DEMO = ['1', 'truenas'].includes(process.env.DEMO ?? '');
/** @param {import('./types').Config} [cfg] */
const setupRequired = (cfg = config.load()) => !DEMO && !cfg.auth && !cfg.openByChoice;

/** @param {import('node:http').IncomingMessage} req */
function loggedIn(req) {
  const cfg = config.load();
  if (!cfg.auth) return !setupRequired(cfg); // removed on purpose: open, as before
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
// Who's asking. Behind a reverse proxy or Cloudflare Tunnel every request comes from the proxy,
// so one stranger's wrong guesses would lock everyone out: with TRUST_PROXY=1 the address the
// proxy passes on is used instead. Off by default, because without a proxy in front anyone can
// send those headers and dodge the lockout.
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
/** @param {import('node:http').IncomingMessage} req */
function clientIp(req) {
  const socket = req.socket.remoteAddress || '?';
  if (!TRUST_PROXY) return socket;
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf; // set by Cloudflare (and cloudflared), replacing whatever the client sent
  // X-Forwarded-For: the last address is the one the nearest proxy saw; earlier ones the client could invent.
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return xff.at(-1) || socket;
}
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

module.exports = {
  sessions,
  cookie,
  loggedIn,
  setupRequired,
  startSession,
  lockedOut,
  noteFailure,
  clientIp,
  TRUST_PROXY,
};
