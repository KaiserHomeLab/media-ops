// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media Review (friends vote on what to delete): its health, and counts of what's waiting for
// you, through the API it offers Media Ops (X-Api-Key, /api/v1). The Leaving Soon and held-back
// lists are kept too: titles only, never who voted, objected or asked.
'use strict';
const { cached, join, req, timed } = require('../http');
const { MINUTE, list } = require('./shared');

// "Nothing has synced for 3 hours" grows every hour. Event keys are hashes of the message, so
// the number would make it a new event (and a new notification) each hour: drop it.
/** @param {unknown} m */
const stable = m => String(m ?? '').replace(/\bfor \d+ hours?\b/, 'for over an hour');

/** @param {any} t one title from Media Review */
const title = t => ({
  ratingKey: String(t?.ratingKey ?? ''),
  kind: t?.kind ?? null,
  name: String(t?.name ?? ''),
  year: Number(t?.year) || null,
  library: t?.library ?? null,
});

/** @param {import('../types').Service} cfg */
async function mediareview(cfg) {
  const headers = { 'X-Api-Key': cfg.apiKey || '' };
  /** @param {string} p */
  const api = p => req(join(cfg.url, `/api/v1${p}`), { headers });
  // The lists change when someone votes or you decide: once a minute is plenty.
  /** @param {string} p */
  const slow = p => cached(`mediareview:${cfg.url}${p}`, MINUTE, () => api(p));
  const [status, latency] = await timed(() => api('/status'));
  const [health, queue, leaving, problems, held] = await Promise.all([
    api('/health'),
    slow('/review-queue'),
    slow('/leaving-soon'),
    slow('/problem-reports'),
    slow('/held-back'),
  ]);
  const heldBack = list(held?.heldBack);
  return {
    version: status?.version,
    latency,
    data: {
      stats: {
        reviewQueue: list(queue?.reviewQueue).length,
        leavingSoon: list(leaving?.leavingSoon).length,
        problemReports: list(problems?.problemReports).length,
        asks: heldBack.filter(h => list(h.asks).length).length,
      },
      health: list(health).map(h => ({
        type: h.type === 'error' ? 'error' : 'warning',
        message: stable(h.message),
      })),
      leavingSoon: list(leaving?.leavingSoon).map(l => ({
        ...title(l),
        endsAt: l.endsAt ?? null,
        daysLeft: Number(l.daysLeft) || 0,
      })),
      heldBack: heldBack.map(h => ({ ...title(h.title), deletedAt: h.deletedAt ?? null, blocked: !!h.blocked })),
    },
  };
}

module.exports = { mediareview, stable };
