// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The ratchet for turning on noImplicitAny gradually (npm run typecheck runs this after tsc).
// TypeScript can't make one file strict on its own: checking a file also reports the files it
// imports. So this runs the strict check on everything and fails only on errors in the files
// listed below, the ones already typed. Each typing PR adds files; once every file is listed,
// noImplicitAny goes on in tsconfig.json and this script is deleted.
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DONE = [
  'bin/reset-password.js',
  'lib/actions.js',
  'lib/appearance.js',
  'lib/auth.js',
  'lib/autofix.js',
  'lib/collectors/index.js',
  'lib/config.js',
  'lib/dashboard-api.js',
  'lib/demo.js',
  'lib/diagnostics.js',
  'lib/digest.js',
  'lib/discover.js',
  'lib/events.js',
  'lib/geo.js',
  'lib/gpu.js',
  'lib/hints.js',
  'lib/history.js',
  'lib/host.js',
  'lib/http.js',
  'lib/jsonrpc-ws.js',
  'lib/kinds.js',
  'lib/layout.js',
  'lib/media.js',
  'lib/notify.js',
  'lib/pins.js',
  'lib/platform.js',
  'lib/poll.js',
  'lib/recovery.js',
  'lib/selfupdate.js',
  'lib/settings-api.js',
  'lib/smtp.js',
  'lib/space.js',
  'lib/status.js',
  'lib/web.js',
  'server.js',
];

const root = path.join(__dirname, '..');
let out = '';
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      '.',
      '--noImplicitAny',
      'true',
      '--pretty',
      'false',
    ],
    { cwd: root, encoding: 'utf8' },
  );
} catch (e) {
  // tsc exits non-zero when it finds errors (status 1 or 2) and prints them to stdout. Anything
  // else means it didn't run, which must fail rather than look like "no errors".
  if (!e.stdout || ![1, 2].includes(e.status)) throw e;
  out = String(e.stdout);
}
const errors = out.split('\n').filter(l => DONE.some(f => l.startsWith(`${f}(`)));
if (errors.length) {
  console.error(`noImplicitAny errors in files that are already typed:\n${errors.join('\n')}`);
  process.exit(1);
}
const left = new Set(
  out
    .split('\n')
    .map(l => /^([^(]+)\(/.exec(l)?.[1])
    .filter(Boolean),
);
console.log(`noImplicitAny: ${DONE.length} files typed, ${left.size} to go.`);
