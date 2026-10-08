// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Seerr, Overseerr and Jellyseerr (same API): pending requests, counts and the log.
'use strict';
const { join, req, timed, cached } = require('../http');
const { DAY, normLevel, list } = require('./shared');

/** @param {import('../types').Service} cfg */
async function overseerr(cfg) {
  const headers = { 'X-Api-Key': cfg.apiKey || '' };
  /** @param {string} p */
  const api = p => req(join(cfg.url, `/api/v1${p}`), { headers });
  const [status, latency] = await timed(() => api('/status'));
  const update = status.updateAvailable ? { version: null, behind: status.commitsBehind || null } : null;
  const [counts, logs, pending] = await Promise.all([
    api('/request/count'),
    // Needs an admin API key (the one under Settings → General is).
    cached(`logs:${cfg.url}`, 60e3, () => api('/settings/logs?take=50&filter=warn').catch(() => [])),
    api('/request?take=10&skip=0&filter=pending&sort=added').catch(() => null),
  ]);
  // Request lists only carry TMDB ids; look titles up once a day each.
  const requests = await Promise.all(
    list(pending?.results).map(async r => {
      const tv = r.type === 'tv';
      const m = await cached(`seerr-title:${cfg.url}:${r.type}:${r.media?.tmdbId}`, DAY, () =>
        api(`/${tv ? 'tv' : 'movie'}/${r.media?.tmdbId}`).catch(() => null),
      );
      const date = tv ? m?.firstAirDate : m?.releaseDate;
      return {
        id: r.id,
        type: r.type,
        is4k: !!r.is4k,
        createdAt: r.createdAt,
        title: (tv ? m?.name : m?.title) || `TMDB ${r.media?.tmdbId}`,
        year: date ? date.slice(0, 4) : null,
        seasons: tv ? list(r.seasons).map(x => x.seasonNumber) : null,
        requestedBy: r.requestedBy?.displayName || r.requestedBy?.username || 'someone',
      };
    }),
  );
  const events = list(Array.isArray(logs) ? logs : logs?.results)
    .filter(l => normLevel(l.level))
    .map(l => ({
      time: l.timestamp,
      level: normLevel(l.level),
      source: l.label,
      message: l.message,
      detail: l.data ? JSON.stringify(l.data, null, 2) : null,
    }));
  return { version: status.version, latency, data: { update, stats: counts, events, requests } };
}

module.exports = { overseerr };
