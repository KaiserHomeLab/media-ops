#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Removes the settings password. The running dashboard notices the change within a refresh.
//   Docker/Unraid:  reset-password   (from the container console)
//   Locally:        npm run reset-password
const config = require('../lib/config');

if (!config.load().auth) {
  console.log('No settings password is set, so there is nothing to reset.');
  process.exit(0);
}
config.update(c => ({ ...c, auth: null }));
console.log(`Settings password removed (${config.FILE}).`);
console.log('Open Settings → Security in the dashboard to set a new one.');
