// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings → Diagnostics: run every app's collector live, recording each API call it makes,
// and build a copy-pasteable debug report. Everything is redacted on the way in (see
// lib/http.js), so a report is safe to paste into a GitHub issue or a chat.
'use strict';
const os = require('node:os');
const { trace } = require('./http');
const pkg = require('../package.json');

// The last 50 warnings/errors the server logged, for the report.
/** @type {{ at: string, level: string, text: string }[]} */
const recentLog = [];
for (const level of /** @type {const} */ (['error', 'warn'])) {
  const original = console[level].bind(console);
  console[level] = (/** @type {unknown[]} */ ...args) => {
    recentLog.push({ at: new Date().toISOString(), level, text: args.map(String).join(' ').slice(0, 500) });
    if (recentLog.length > 50) recentLog.shift();
    original(...args);
  };
}

/** @param {import('./types').Service} svc @param {(s: import('./types').Service) => Promise<import('./types').Polled>} runService */
async function runOne(svc, runService) {
  const store = { calls: [] };
  const t0 = performance.now();
  const r = await trace.run(store, () => runService(svc));
  return {
    id: svc.id,
    name: svc.name,
    kind: svc.kind,
    url: svc.url,
    ok: r.up,
    error: r.error || null,
    version: r.version || null,
    note: r.data?.note || null,
    ms: Math.round(performance.now() - t0),
    calls: store.calls,
  };
}

/** @param {import('./types').Service[]} services @param {(s: import('./types').Service) => Promise<import('./types').Polled>} runService */
async function run(services, runService) {
  const results = await Promise.all(services.filter(s => s.enabled !== false).map(s => runOne(s, runService)));
  return {
    generatedAt: new Date().toISOString(),
    mediaOps: pkg.version,
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    container: !!process.env.LSIO_FIRST_PARTY || require('node:fs').existsSync('/.dockerenv'),
    uptimeSeconds: Math.round(process.uptime()),
    apps: results,
    recentLog: recentLog.slice(-50),
  };
}

module.exports = { run };
