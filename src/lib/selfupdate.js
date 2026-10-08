// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Is a newer Media Ops out? Reads the latest release from GitHub's API (api.github.com) at most
// every 6 hours. Only a plain GET: nothing about this server is sent. Off with Settings →
// General → "Check for Media Ops updates".
'use strict';
const { req } = require('./http');
const pkg = require('../package.json');

const URL_ = 'https://api.github.com/repos/KaiserHomeLab/media-ops/releases/latest';
const EVERY = 6 * 60 * 60e3;
/** @type {{ at: number, latest: string | null, pending: Promise<void> | null }} */
let last = { at: 0, latest: null, pending: null };

/** @param {string} a @param {string} b */
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number),
    pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// "v1.15.1" -> "1.15.1"; anything that isn't a plain version (or is a pre-release) -> null.
/** @param {any} release GitHub's latest-release reply */
function versionOf(release) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(release?.tag_name ?? ''));
  return m && !release.prerelease && !release.draft ? m[1] : null;
}

// Returns the newer version, or null. Never waits on the network: the first call starts a
// check in the background and later calls see its result.
/** @param {import('./types').Config} cfg @returns {string | null} */
function latest(cfg) {
  if (cfg.checkUpdates === false) return null;
  if (Date.now() - last.at > EVERY && !last.pending) {
    last.pending = req(URL_, { timeout: 10000, headers: { Accept: 'application/vnd.github+json' } })
      .then(r => {
        last = { at: Date.now(), latest: versionOf(r), pending: null };
      })
      .catch(() => {
        last = { ...last, at: Date.now() - EVERY + 30 * 60e3, pending: null };
      }); // retry in 30 min
  }
  return last.latest && newer(last.latest, pkg.version) ? last.latest : null;
}

module.exports = { latest, newer, versionOf };
