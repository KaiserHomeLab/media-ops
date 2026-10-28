// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media Review (github.com/KaiserHomeLab/media-review): the Titles friends have Downvoted that
// wait for the Owner's decision, and the ones Leaving Soon. Media Review holds every rule; this only shows its Review Queue.
'use strict';
const { join, req, timed } = require('../http');
const { list } = require('./shared');

/** @param {import('../types').Service} cfg */
async function mediareview(cfg) {
  const headers = { 'X-Api-Key': cfg.apiKey || '' };
  /** @param {string} p */
  const api = p => req(join(cfg.url, `/api/v1${p}`), { headers });
  const [status, latency] = await timed(() => api('/status'));
  const [queue, leaving] = await Promise.all([
    api('/review-queue'),
    api('/leaving-soon').catch(() => null), // Media Review before 0.2 has no Leaving Soon
  ]);
  const reviewQueue = list(queue?.reviewQueue).map(e => ({
    ratingKey: String(e.title?.ratingKey ?? ''),
    title: e.title?.name || 'Unknown title',
    year: e.title?.year ?? null,
    kind: e.title?.kind === 'show' ? 'show' : 'movie',
    library: e.title?.library ? String(e.title.library) : null, // the Plex library: Movies, TV Shows, Anime…
    queuedAt: e.queuedAt,
    audience: e.audience,
    audienceWeight: e.audienceWeight,
    downvoteWeight: e.downvoteWeight,
    downvotes: list(e.downvotes).map(d => ({ voter: String(d.voter), voteWeight: d.voteWeight })),
    // Downvotes are frozen once queued; these downvoters have watched it since.
    watchedSince: list(e.watchedSinceQueued).map(w => String(w.voter)),
    kept: list(e.history).filter(h => h.decision === 'keep').length,
  }));
  // Removed, and in Plex's Leaving Soon collection until it's deleted. The Owner can still Keep it after all.
  const leavingSoon = list(leaving?.leavingSoon).map(l => ({
    ratingKey: String(l.ratingKey ?? ''),
    title: l.name || 'Unknown title',
    year: l.year ?? null,
    kind: l.kind === 'show' ? 'show' : 'movie',
    library: l.library ? String(l.library) : null,
    endsAt: l.endsAt,
    daysLeft: Number(l.daysLeft ?? 0),
  }));
  return { version: status.version, latency, data: { reviewQueue, leavingSoon } };
}

module.exports = { mediareview };
