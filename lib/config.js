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
};

let current = null;

function normalize(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  out.services = (out.services || []).map(s => ({
    ...s,
    id: s.id || crypto.randomUUID(),
    name: s.name || BY_KIND[s.kind]?.label || s.kind,
    url: String(s.url || '').trim().replace(/\/+$/, ''),
  }));
  return out;
}

function load() {
  if (current) return current;
  try {
    current = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Could not read ${FILE}: ${e.message} — starting with an empty config.`);
    current = normalize({});
  }
  return current;
}

function save(next) {
  current = normalize(next);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE); // atomic: a crash mid-write never leaves a half-written config
  return current;
}

const update = fn => save(fn(structuredClone(load())));

// What the browser is allowed to see: secrets become a "saved" flag, never the value.
function publicService(s) {
  const out = { ...s };
  for (const k of secretKeys(s.kind)) {
    out[`${k}Saved`] = !!s[k];
    delete out[k];
  }
  return out;
}

// Merge a form submission onto the stored service; a blank secret means "keep the saved one".
function mergeService(existing, input) {
  const kind = input.kind || existing?.kind;
  const def = BY_KIND[kind];
  if (!def) throw new Error(`Unknown app type "${kind}"`);
  const url = String(input.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('Address must start with http:// or https:// — e.g. http://192.168.1.10:8989');
  const out = {
    id: existing?.id || crypto.randomUUID(),
    kind,
    name: String(input.name || '').trim() || def.label,
    url,
    link: String(input.link || '').trim() || undefined,
    enabled: input.enabled !== false,
  };
  for (const f of def.fields) {
    const v = input[f.key];
    if (f.type === 'secret') out[f.key] = v ? String(v).trim() : existing?.[f.key] || '';
    else out[f.key] = String(v ?? '').trim();
    if (!f.optional && !out[f.key]) throw new Error(`${f.label} is required`);
  }
  return out;
}

// ---- settings password (scrypt, never stored in plain text)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw) {
  const a = load().auth;
  if (!a) return true;
  const h = crypto.scryptSync(String(pw || ''), a.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'));
}

module.exports = { FILE, load, save, update, publicService, mergeService, hashPassword, checkPassword };
