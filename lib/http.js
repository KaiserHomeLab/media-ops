// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Small HTTP helpers shared by the collectors: JSON fetch with a timeout, GET over the
// Docker unix socket, timing, and a TTL cache for slow-changing data.
//
// Diagnostics: code run inside trace.run(store, fn) has every req() recorded into
// store.calls (redacted: no keys, tokens, viewer IPs or usernames) and bypasses the cache,
// so Settings → Diagnostics shows exactly what each app answered, live.
'use strict';
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');

const trace = new AsyncLocalStorage();
const join = (base, p) => base.replace(/\/+$/, '') + p;

// ------------------------------------------------------------------ redaction (for diagnostics)
const SECRET_PARAM = /([?&](?:apikey|api_key|token|x-plex-token|password|key)=)[^&]*/gi;
const redactUrl = url => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search.replace(SECRET_PARAM, '$1•••')}`;
  } catch { return String(url).replace(SECRET_PARAM, '$1•••'); }
};
// Keys whose values are secrets or personal: tokens, keys, IPs, emails, people's names.
const SECRET_KEY = /(key|token|password|secret|cookie|auth|email|address|ip$|^ip|username|friendly_?name|^user$|displayname|plexusername|serial)/i;
function redactValue(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 5).map(x => redactValue(x, depth + 1)).concat(v.length > 5 ? [`… ${v.length - 5} more`] : []);
  if (v && typeof v === 'object') {
    if (depth > 6) return '…';
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      // Plex puts the viewer in a `User` object; drop it whole.
      out[k] = SECRET_KEY.test(k) || k === 'User' ? '•••' : redactValue(x, depth + 1);
    }
    return out;
  }
  return v;
}
function sampleOf(text) {
  try {
    return JSON.stringify(redactValue(JSON.parse(text)), null, 2).slice(0, 3000);
  } catch {
    // XML (Plex, plex.tv) or plain text: blank out attribute values that look secret.
    return String(text).replace(/\b(\w*(?:token|key|address|email|username)\w*)="[^"]*"/gi, '$1="•••"').slice(0, 1500);
  }
}

// ------------------------------------------------------------------ requests
// fetch with a timeout, returning parsed JSON (or text, or the raw Response).
// Redirects aren't followed: an app bouncing us to its login page means a wrong URL or
// key, and should show up as an error, not as a successful HTML response.
async function req(url, { headers = {}, timeout = 8000, method = 'GET', body, as = 'json' } = {}) {
  const store = trace.getStore();
  const t0 = performance.now();
  const call = store && { method, url: redactUrl(url) };
  if (call) store.calls.push(call);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual',
    });
    if (call) Object.assign(call, { status: res.status, ms: Math.round(performance.now() - t0) });
    if (as === 'response') return res;
    const text = await res.text();
    if (call) Object.assign(call, { bytes: text.length, sample: sampleOf(text) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${new URL(url).pathname}`);
    if (as === 'text') return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON reply from ${new URL(url).pathname}`);
    }
  } catch (e) {
    if (call) Object.assign(call, { ms: call.ms ?? Math.round(performance.now() - t0), error: e.cause?.code || e.message });
    throw e;
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

// Run fn and return [result, milliseconds]; used for the latency shown on each service.
async function timed(fn) {
  const t = performance.now();
  const r = await fn();
  return [r, Math.round(performance.now() - t)];
}

// Tiny TTL memo so slow, rarely-changing calls (library counts) don't run every poll.
// Skipped during a diagnostics run, which should always show live answers.
const memo = new Map();
async function cached(key, ttlMs, fn) {
  if (trace.getStore()) return fn();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

// Settings changed (new URL/key): drop everything cached so the next poll is fresh.
const clearCache = () => memo.clear();

module.exports = { join, req, unixGet, timed, cached, clearCache, trace, redactValue, sampleOf };
