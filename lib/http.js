'use strict';
const http = require('node:http');

const join = (base, p) => base.replace(/\/+$/, '') + p;

async function req(url, { headers = {}, timeout = 8000, method = 'GET', body, as = 'json' } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeout),
    redirect: 'manual',
  });
  if (as === 'response') return res;
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${new URL(url).pathname}`);
  const text = await res.text();
  if (as === 'text') return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON reply from ${new URL(url).pathname}`);
  }
}

// GET over a unix socket (Docker Engine API).
function unixGet(socketPath, path, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const r = http.get({ socketPath, path, timeout }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Docker HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('Docker socket timeout')));
    r.on('error', reject);
  });
}

async function timed(fn) {
  const t = performance.now();
  const r = await fn();
  return [r, Math.round(performance.now() - t)];
}

// Tiny TTL memo so slow, rarely-changing calls (library counts) don't run every poll.
const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { join, req, unixGet, timed, cached };

// Settings changed (new URL/key): drop everything cached so the next poll is fresh.
module.exports.clearCache = () => memo.clear();
