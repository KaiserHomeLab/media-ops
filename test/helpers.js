// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Test helpers: a throwaway config folder and a fake app server that answers from fixtures.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Must run before anything requires lib/config.js.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-test-'));
process.env.CONFIG = path.join(dir, 'config.json');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

// routes: { 'GET /api/v3/series': body | (req, url, body) => body }. A body of
// { status, body?, headers? } sets the response exactly. Records every request.
function fakeServer(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const route = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname];
      if (route === undefined) { res.statusCode = 404; return res.end('{}'); }
      const out = typeof route === 'function' ? route(req, url, body) : route;
      if (out && out.status) {
        for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
        res.statusCode = out.status;
        return res.end(out.body ?? '');
      }
      res.setHeader('Content-Type', typeof out === 'string' ? 'text/plain' : 'application/json');
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() });
  }));
}

module.exports = { dir, fixture, fakeServer };
