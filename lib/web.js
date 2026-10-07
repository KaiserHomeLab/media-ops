// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Plumbing for Media Ops' own web server (lib/http.js is the client that talks to apps):
// security headers, the same-origin check for writes, JSON in and out with gzip, and static
// files cached in memory.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

// Sent with every response. The pages load nothing from other sites and run no inline script,
// so the policy can be strict: a value injected into the page can't run code, the pages can't
// be framed by another site (clickjacking), and links don't leak the dashboard's address.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; style-src-elem 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

// Static files are read once and kept in memory with an ETag, so a reload costs a 304. The

// Writes must come from this page (blocks other websites from silently changing your settings).
// Browsers send Origin on cross-site writes and Sec-Fetch-Site on everything; either one
// pointing elsewhere is refused.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req, limit = 64 * 1024) {
  if (!/^application\/json/.test(req.headers['content-type'] || ''))
    throw Object.assign(new Error('Expected JSON'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size).toString('utf8');
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  return reply(
    res,
    status,
    { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    Buffer.from(JSON.stringify(body)),
  );
}

// gzip text bodies over 1 KB when the browser accepts it: the overview JSON and the dashboard scripts
// shrink to a fifth, which matters on phones and wall tablets on Wi-Fi.
const gzip = promisify(zlib.gzip);
const COMPRESSIBLE = /json|text|javascript|css|svg|manifest/;
async function reply(res, status, headers, body) {
  const req = res.req;
  if (
    body.length > 1024 &&
    /\bgzip\b/.test(req.headers['accept-encoding'] || '') &&
    COMPRESSIBLE.test(headers['Content-Type'] || '')
  ) {
    body = await gzip(body, { level: 6 });
    headers = { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };
  }
  res.writeHead(status, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// file's mtime is checked (at most every 2 s) so edits during development still show up.
const statics = new Map(); // file -> { body, etag, mtime, checked }
async function staticFile(file) {
  let hit = statics.get(file);
  if (hit && Date.now() - hit.checked < 2000) return hit;
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
  if (hit && hit.mtime === st.mtimeMs) {
    hit.checked = Date.now();
    return hit;
  }
  const body = await fs.promises.readFile(file);
  hit = {
    body,
    etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
    mtime: st.mtimeMs,
    checked: Date.now(),
  };
  statics.set(file, hit);
  return hit;
}

// Serve a file from `root` (GET/HEAD only), with ETag revalidation and a gzip copy made once.
// `pages` maps clean URLs to files ('/settings' -> '/settings.html').
async function serveStatic(req, res, url, root, pages) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);
  const file = path.join(root, path.normalize(pages[url.pathname] || url.pathname));
  if (!file.startsWith(root + path.sep)) return send(res, 403);
  const f = await staticFile(file);
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    ETag: f.etag,
    'Cache-Control': 'no-cache',
  };
  if (req.headers['if-none-match'] === f.etag) return res.writeHead(304, headers).end();
  // Static files never change between deploys: compress each one once (at the best level),
  // not on every request.
  if (
    f.body.length > 1024 &&
    /\bgzip\b/.test(req.headers['accept-encoding'] || '') &&
    COMPRESSIBLE.test(headers['Content-Type'])
  ) {
    f.gz ||= await gzip(f.body, { level: 9 });
    res.writeHead(200, {
      ...headers,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Content-Length': f.gz.length,
    });
    return res.end(f.gz); // Node drops the body itself for HEAD
  }
  return reply(res, 200, headers, f.body);
}

module.exports = { SECURITY_HEADERS, sameOrigin, readJson, send, serveStatic };
