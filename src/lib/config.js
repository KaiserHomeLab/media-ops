// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Config lives in one JSON file (in Docker: /config/config.json on a volume) and is edited from the Settings page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BY_KIND, secretKeys } = require('./kinds');

const FILE = process.env.CONFIG || path.join(__dirname, '..', 'data', 'config.json');

const DEFAULTS = {
  refreshSeconds: 10,
  docker: { socket: '/var/run/docker.sock' },
  paths: ['/mnt/user', '/mnt/cache'], // Unraid array + cache; paths that don't exist are skipped
  services: [],
  auth: null, // { salt, hash } once a settings password is set
  map: { enabled: true, home: '' }, // stream map; home = optional "lat, lon" override
  notifications: { diskThreshold: 90, targets: [] }, // see lib/notify.js
  statusPage: null, // public /status page, see lib/status.js
  layout: null, // dashboard card order and which cards are off, see lib/layout.js
  autoFix: null, // fix stuck downloads automatically, see lib/autofix.js
  appearance: null, // theme, accent, title, logo, see lib/appearance.js
  metrics: null, // Prometheus /metrics: { enabled, token }, see lib/metrics.js
  dismissed: { before: {}, items: [] }, // errors feed: what's been dismissed (see lib/events.js)
};

/** @type {import('./types').Config | null} */
let current = null;
let loadedMtime = 0;
let checkedAt = 0;
const mtime = () => {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
};

// Fill in defaults and give every service a stable id (used by the UI and by dismissals).
/** @param {any} cfg parsed config.json @returns {import('./types').Config} */
function normalize(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  out.services = /** @type {any[]} */ (out.services || []).map(s => ({
    ...s,
    id: s.id || crypto.randomUUID(),
    name: s.name || BY_KIND[s.kind]?.label || s.kind,
    url: String(s.url || '')
      .trim()
      .replace(/\/+$/, ''),
  }));
  return out;
}

// Re-reads the file when it changes on disk, so hand edits (or the reset-password command)
// take effect without a restart.
/** @returns {import('./types').Config} */
function load() {
  // load() runs many times per request; look at the file at most once a second.
  if (current && Date.now() - checkedAt < 1000) return current;
  checkedAt = Date.now();
  const m = mtime();
  if (current && m === loadedMtime) return current;
  try {
    current = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT')
      console.error(
        `Could not read ${FILE}: ${e.message} — ${current ? 'keeping the last good settings' : 'starting with an empty config'}.`,
      );
  }
  current ??= normalize({}); // first start with no (or a broken) config.json
  loadedMtime = m;
  return current;
}

/** @param {any} next */
function save(next) {
  current = normalize(next);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE); // atomic: a crash mid-write never leaves a half-written config
  loadedMtime = mtime();
  checkedAt = Date.now();
  return current;
}

/** @param {(cfg: import('./types').Config) => any} fn the next config, made from a copy of the current one */
const update = fn => save(fn(structuredClone(load())));

// What the browser is allowed to see: secrets become a "saved" flag, never the value.
/** @param {import('./types').Service} s */
function publicService(s) {
  const out = { ...s };
  for (const k of secretKeys(s.kind)) {
    out[`${k}Saved`] = !!s[k];
    delete out[k];
  }
  return out;
}

// Origin (scheme + host + port) of an address, for "is this still the same server?".
/** @param {string} u */
const originOf = u => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

// A saved secret is only ever sent to the address it was saved for. Changing the address
// without re-entering it would let anyone who can edit settings point an app at their own
// server and receive the stored key.
/** @param {string} existing @param {string} oldUrl @param {string} newUrl @param {string} label */
function keepSecret(existing, oldUrl, newUrl, label) {
  if (existing && oldUrl && originOf(oldUrl) !== originOf(newUrl))
    throw new Error(
      `Re-enter the ${label}: the address changed, and a saved ${label} is only sent to the address it was saved for.`,
    );
  return existing;
}
/** @param {unknown} v */
const safeLink = v => {
  const link = String(v || '').trim();
  if (link && !/^https?:\/\/[^\s]+$/i.test(link)) throw new Error('Link must start with http:// or https://');
  return link || undefined;
};

// Merge a form submission onto the stored service; a blank secret means "keep the saved one".
/** @param {import('./types').Service | null | undefined} existing @param {any} input @returns {import('./types').Service} */
function mergeService(existing, input) {
  const kind = input.kind || existing?.kind;
  const def = BY_KIND[kind];
  if (!def) throw new Error(`Unknown app type "${kind}"`);
  const url = String(input.url || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url))
    throw new Error('Address must start with http:// or https:// — e.g. http://192.168.1.10:8989');
  /** @type {import('./types').Service} */
  const out = {
    id: existing?.id || crypto.randomUUID(),
    kind,
    name: String(input.name || '').trim() || def.label,
    url,
    link: safeLink(input.link),
    enabled: input.enabled !== false,
  };
  for (const f of def.fields) {
    const v = input[f.key];
    if (f.type === 'secret')
      out[f.key] = v
        ? String(v).trim()
        : existing?.[f.key]
          ? keepSecret(existing[f.key], existing.url, url, f.label)
          : '';
    else out[f.key] = String(v ?? '').trim();
    if (!f.optional && !out[f.key]) throw new Error(`${f.label} is required`);
  }
  return out;
}

// ---- settings password (scrypt, never stored in plain text)
/** @param {string} pw */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
// Constant-time comparison. Always true when no password is set. Async: scrypt takes ~50 ms of
// CPU, and the sync version would freeze the whole server for every guess.
const scrypt = require('node:util').promisify(crypto.scrypt);
/** @param {string} pw */
async function checkPassword(pw) {
  const a = load().auth;
  if (!a) return true;
  const want = Buffer.from(String(a.hash || ''), 'hex');
  const h = await scrypt(String(pw || '').slice(0, 1024), String(a.salt || ''), 64);
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

module.exports = { FILE, load, save, update, publicService, mergeService, hashPassword, checkPassword, originOf };
