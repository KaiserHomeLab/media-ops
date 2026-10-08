// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The ratchet for type checking the browser code (public/), run by npm run typecheck. Its files
// import each other in a circle (util.js -> main.js -> every card), so one can't be checked
// alone: this checks them all and fails only on errors in the files listed below, the ones
// already typed. Each typing PR adds files; once all are listed, `tsc -p public` runs directly
// and this script goes.
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DONE = [
  'public/js/layout.js',
  'public/js/main.js',
  'public/js/space.js',
  'public/js/status.js',
  'public/js/streams.js',
  'public/js/strip.js',
  'public/js/tv.js',
  'public/js/util.js',
];

const root = path.join(__dirname, '..');
let out = '';
try {
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'public', '--pretty', 'false'],
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
  console.error(`Type errors in browser files that are already typed:\n${errors.join('\n')}`);
  process.exit(1);
}
const left = new Set(
  out
    .split('\n')
    .map(l => /^(public\/[^(]+)\(/.exec(l)?.[1])
    .filter(Boolean),
);
console.log(`Browser code: ${DONE.length} files typed, ${left.size} to go.`);
