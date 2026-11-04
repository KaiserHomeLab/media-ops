// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub sources: the apps allowed to send webhooks in, each with its own address
// (/api/hub/in/<type>/<instance>) and token. Kept in config.json under hub.sources, so backups
// carry them. Only a hash of each token is stored; the token itself is shown once.
'use strict';
const crypto = require('node:crypto');

/** @typedef {{ id: string, type: string, instance: string, name: string, library?: string, tokenHash: string, createdAt: number }} Source */

// `how`: the steps to add the address by hand, one per line (Settings shows them numbered).
const TYPES = [
  {
    type: 'sonarr',
    label: 'Sonarr',
    how: 'In Sonarr, open Settings → Connect and click +, then Webhook.\nName it Media Ops and paste the address into URL. Leave Method on POST.\nTick On Import, On Upgrade, On Health Issue, On Health Restored, On Manual Interaction Required, and the delete events.\nClick Test, then Save.',
  },
  {
    type: 'radarr',
    label: 'Radarr',
    how: 'In Radarr, open Settings → Connect and click +, then Webhook.\nName it Media Ops and paste the address into URL. Leave Method on POST.\nTick On Import, On Upgrade, On Health Issue, On Health Restored, On Manual Interaction Required, and the delete events.\nClick Test, then Save.',
  },
  {
    type: 'seerr',
    label: 'Seerr',
    how: 'In Seerr, open Settings → Notifications → Webhook.\nTick Enable Agent and paste the address into Webhook URL. Keep the default JSON payload.\nTick the kinds of notification you want (requests, approvals, available…).\nClick Test, then Save Changes.',
  },
  {
    type: 'generic',
    label: 'From a script',
    how: 'Send a POST with JSON like { "type": "custom", "summary": "Backup finished" } to the address.\nOptional fields: severity (info, warning, error, critical) and media (a title, see docs/notification-hub.md).',
  },
];
const BY_TYPE = new Set(TYPES.map(t => t.type));
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @param {string} token */
const hashOf = token => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => `mohub_${crypto.randomBytes(24).toString('base64url')}`;

/** @param {import('../types').Config} cfg @returns {Source[]} */
const list = cfg => /** @type {Source[]} */ (cfg.hub?.sources || []);

/** @param {Source} s */
const pathOf = s => `/api/hub/in/${s.type}/${s.instance}`;

// What Settings sees: never the hash.
/** @param {Source} s */
const publicSource = s => ({
  id: s.id,
  type: s.type,
  instance: s.instance,
  name: s.name,
  library: s.library || '',
  path: pathOf(s),
  createdAt: s.createdAt,
});

// A form submission -> a stored source. A new one (no `existing`) gets a token, returned once.
/** @param {Source[]} all @param {Source | null} existing @param {any} input @returns {{ source: Source, token: string | null }} */
function merge(all, existing, input) {
  const type = existing?.type || String(input?.type || '');
  if (!BY_TYPE.has(type)) throw new Error(`Unknown source type "${type}"`);
  const instance =
    existing?.instance ||
    String(input?.instance || type)
      .trim()
      .toLowerCase();
  if (!SLUG.test(instance))
    throw new Error('Instance must be lowercase letters, digits and dashes, like "sonarr-anime"');
  if (!existing && all.some(s => s.type === type && s.instance === instance))
    throw new Error(`There's already a ${type} source called "${instance}"`);
  const library = String(input?.library ?? existing?.library ?? '')
    .trim()
    .slice(0, 100);
  const token = existing ? null : newToken();
  return {
    source: {
      id: existing?.id || crypto.randomUUID(),
      type,
      instance,
      name:
        String(input?.name || '')
          .trim()
          .slice(0, 100) ||
        existing?.name ||
        instance,
      ...(library ? { library } : {}),
      tokenHash: existing?.tokenHash || hashOf(/** @type {string} */ (token)),
      createdAt: existing?.createdAt || Date.now(),
    },
    token,
  };
}

/** @param {Source} s @returns {{ source: Source, token: string }} */
function regenerate(s) {
  const token = newToken();
  return { source: { ...s, tokenHash: hashOf(token) }, token };
}

// The token a request carries: X-Hub-Token, a Bearer token, the password of Basic auth (what
// the *arr webhook form's username/password fields send), or ?token=.
/** @param {import('node:http').IncomingHttpHeaders} headers @param {URLSearchParams} query */
function tokenFrom(headers, query) {
  const h = headers['x-hub-token'];
  if (typeof h === 'string' && h) return h;
  const auth = String(headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1];
  const basic = auth.match(/^Basic\s+(\S+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return query.get('token') || '';
}

// The source a request is for, if its token matches. Constant-time on the hash.
/** @param {Source[]} all @param {string} type @param {string} instance @param {string} token */
function verify(all, type, instance, token) {
  const s = all.find(x => x.type === type && x.instance === instance);
  const want = Buffer.from(s?.tokenHash || '0'.repeat(64), 'hex');
  const got = Buffer.from(hashOf(String(token || '')), 'hex');
  const ok = crypto.timingSafeEqual(want, got);
  return s && ok && token ? s : null;
}

// From a backup: only well-formed sources, hashes kept (so the apps' webhooks keep working).
/** @param {unknown} v @returns {Source[]} */
function clean(v) {
  if (!Array.isArray(v)) return [];
  /** @type {Source[]} */
  const out = [];
  for (const s of v) {
    if (!s || !BY_TYPE.has(s.type) || !SLUG.test(String(s.instance)) || !/^[0-9a-f]{64}$/.test(String(s.tokenHash)))
      continue;
    if (out.some(x => x.type === s.type && x.instance === s.instance)) continue;
    out.push({
      id: /^[\w-]{1,64}$/.test(String(s.id)) ? String(s.id) : crypto.randomUUID(),
      type: s.type,
      instance: s.instance,
      name: String(s.name || s.instance).slice(0, 100),
      ...(s.library ? { library: String(s.library).slice(0, 100) } : {}),
      tokenHash: s.tokenHash,
      createdAt: Number(s.createdAt) || Date.now(),
    });
  }
  return out;
}

module.exports = { TYPES, list, merge, regenerate, tokenFrom, verify, publicSource, clean, hashOf };
