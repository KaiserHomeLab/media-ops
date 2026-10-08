// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Is a newer Media Ops out? Reads the version in package.json on GitHub's main branch (the
// image is rebuilt from main on every push) at most every 6 hours. Only a plain GET to
// raw.githubusercontent.com: nothing about this server is sent. Off with Settings → General →
// "Check for Media Ops updates".
'use strict';
const { req } = require('./http');
const pkg = require('../package.json');

const URL_ = 'https://raw.githubusercontent.com/KaiserHomeLab/media-ops/main/package.json';
const EVERY = 6 * 60 * 60e3;
/** @type {{ at: number, latest: string | null, pending: Promise<void> | null }} */
let last = { at: 0, latest: null, pending: null };

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number),
    pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// Returns the newer version, or null. Never waits on the network: the first call starts a
// check in the background and later calls see its result.
function latest(cfg) {
  if (cfg.checkUpdates === false) return null;
  if (Date.now() - last.at > EVERY && !last.pending) {
    last.pending = req(URL_, { timeout: 10000 })
      .then(p => {
        last = { at: Date.now(), latest: p?.version || null, pending: null };
      })
      .catch(() => {
        last = { ...last, at: Date.now() - EVERY + 30 * 60e3, pending: null };
      }); // retry in 30 min
  }
  return last.latest && newer(last.latest, pkg.version) ? last.latest : null;
}

module.exports = { latest, newer };
