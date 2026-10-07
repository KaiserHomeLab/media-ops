// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Bazarr: missing subtitles.
'use strict';
const { join, req, timed } = require('../http');

async function bazarr(cfg) {
  const headers = { 'X-API-KEY': cfg.apiKey };
  const api = p => req(join(cfg.url, p), { headers });
  const [status, latency] = await timed(() => api('/api/system/status'));
  const badges = await api('/api/badges');
  return {
    version: status.data?.bazarr_version,
    latency,
    data: {
      stats: {
        missingEpisodeSubs: badges.episodes ?? 0,
        missingMovieSubs: badges.movies ?? 0,
        providerIssues: badges.providers ?? 0,
      },
    },
  };
}

module.exports = { bazarr };
