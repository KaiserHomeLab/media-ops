// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media Review (github.com/KaiserHomeLab/media-review): the Titles friends have Downvoted that
// wait for the Owner's decision, the ones Leaving Soon, and open Problem Reports. Media Review holds every rule; this
// only shows them. What's wrong in Media Review itself goes to Errors & warnings, as an *arr's health checks do.
'use strict';
const { join, req, timed } = require('../http');
const { list } = require('./shared');

/** @param {import('../types').Service} cfg */
async function mediareview(cfg) {
  const headers = { 'X-Api-Key': cfg.apiKey || '' };
  /** @param {string} p */
  const api = p => req(join(cfg.url, `/api/v1${p}`), { headers });
  const [status, latency] = await timed(() => api('/status'));
  const [queue, leaving, problems, held, building, health] = await Promise.all([
    api('/review-queue'),
    api('/leaving-soon').catch(() => null), // Media Review before 0.2 has no Leaving Soon
    api('/problem-reports').catch(() => null), // nor Problem Reports
    api('/held-back').catch(() => null), // nor holding back deleted titles
    api('/building-up').catch(() => null), // nor Building up
    api('/health').catch(() => null), // nor saying what's wrong
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
  // Deleted and blocklisted in Seerr; friends have asked for these back. The rest stay in Media Review.
  const heldBack = list(held?.heldBack)
    .filter(h => list(h.asks).length)
    .map(h => ({
      ratingKey: String(h.title?.ratingKey ?? ''),
      title: h.title?.name || 'Unknown title',
      year: h.title?.year ?? null,
      kind: h.title?.kind === 'show' ? 'show' : 'movie',
      library: h.title?.library ? String(h.title.library) : null,
      deletedAt: h.deletedAt,
      asks: list(h.asks).map(a => ({ voter: String(a.voter), note: a.note ? String(a.note) : null })),
      // Why it went: who Downvoted it each time it was Removed, and how many times it was Kept before.
      downvotes: list(h.history?.votes)
        .flatMap(r => list(r.downvotes))
        .map(d => ({ voter: String(d.voter), voteWeight: d.voteWeight })),
      kept: list(h.history?.decisions).filter(d => d.decision === 'keep').length,
    }));
  // Downvoted but below the bar: the few closest to it (Media Review has the full list).
  const buildingUp = list(building?.buildingUp)
    .slice(0, 5)
    .map(b => ({
      ratingKey: String(b.title?.ratingKey ?? ''),
      title: b.title?.name || 'Unknown title',
      year: b.title?.year ?? null,
      kind: b.title?.kind === 'show' ? 'show' : 'movie',
      library: b.title?.library ? String(b.title.library) : null,
      progress: Math.max(0, Math.min(1, Number(b.progress ?? 0))),
      downvoteWeight: Number(b.downvoteWeight ?? 0),
      neededWeight: Number(b.neededWeight ?? 0),
      audience: Number(b.audience ?? 0),
      minimumAudience: Number(b.minimumAudience ?? 0),
      downvotes: list(b.downvotes).map(d => ({ voter: String(d.voter), voteWeight: d.voteWeight, counts: !!d.counts })),
    }));
  const buildingTotal = list(building?.buildingUp).length;
  return {
    version: status.version,
    latency,
    data: {
      reviewQueue,
      leavingSoon,
      problemReports,
      heldBack,
      buildingUp,
      buildingTotal,
      // A job that failed its last run, a Title that couldn't be deleted, no sync for an hour, Discord down.
      health: list(health).map(h => ({
        type: h.type === 'error' ? 'error' : 'warning',
        message: String(h.message ?? ''),
        // Seen from Media Review, so a 401 here is Media Review's key for that app, not Media Ops'.
        hint: 'Media Review saw this, not Media Ops. Media Review → Settings → Status has what each job last did, and Run diagnostics checks every app it uses.',
      })),
    },
  };
}

module.exports = { mediareview };
