// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media Review (github.com/KaiserHomeLab/media-review): the Titles friends have Downvoted that
// wait for the Owner's decision, the ones Leaving Soon, and open Problem Reports. Media Review holds every rule; this
// only shows them.
'use strict';
const { join, req, timed } = require('../http');
const { list } = require('./shared');

/** @param {import('../types').Service} cfg */
async function mediareview(cfg) {
  const headers = { 'X-Api-Key': cfg.apiKey || '' };
  /** @param {string} p */
  const api = p => req(join(cfg.url, `/api/v1${p}`), { headers });
  const [status, latency] = await timed(() => api('/status'));
  const [queue, leaving, problems] = await Promise.all([
    api('/review-queue'),
    api('/leaving-soon').catch(() => null), // Media Review before 0.2 has no Leaving Soon
    api('/problem-reports').catch(() => null), // nor Problem Reports
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
    // Back from Leaving Soon because friends objected, and who did.
    sentBack: !!e.sentBack,
    objections: list(e.objections).map(o => ({ voter: String(o.voter), voteWeight: o.voteWeight })),
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
    // Media Review deletes it overnight; when that failed, this says why. It tries again the next night.
    deleteError: l.deleteError ? String(l.deleteError) : null,
    // Friends' Objections so far, against the Objection bar that sends it back; closed on a second round.
    objectionsOpen: l.objectionsOpen !== false,
    objections: list(l.objections).map(o => ({ voter: String(o.voter), voteWeight: o.voteWeight })),
    objectionWeight: Number(l.objectionWeight ?? 0),
    objectionBar: l.objectionBar == null ? null : Number(l.objectionBar),
  }));
  // A friend says a copy is broken or poor: the whole Title, or one season or episode, and who else has it.
  const problemReports = list(problems?.problemReports).map(r => ({
    id: Number(r.id),
    ratingKey: String(r.title?.ratingKey ?? ''),
    title: r.title?.name || 'Unknown title',
    year: r.title?.year ?? null,
    kind: r.title?.kind === 'show' ? 'show' : 'movie',
    library: r.title?.library ? String(r.title.library) : null,
    part: r.part ? String(r.part) : null, // "S2 E3 · Title", "Season 2", or null for the whole Title
    reason: String(r.reasonLabel ?? r.reason ?? ''),
    reportedAt: r.reportedAt,
    reporters: list(r.reporters).map(p => ({ voter: String(p.voter), note: p.note ? String(p.note) : null })),
  }));
  return { version: status.version, latency, data: { reviewQueue, leavingSoon, problemReports } };
}

module.exports = { mediareview };
