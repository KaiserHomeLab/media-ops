// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Clonarr (TRaSH Guides sync): sync status per *arr.
'use strict';
const { join, req, timed } = require('../http');

// /api/widget/summary is Clonarr's stable integration endpoint. Builds that predate it
// (or no API key) fall back to /api/health, which only tells us it's alive.
async function clonarr(cfg) {
  const headers = cfg.apiKey ? { 'X-Api-Key': cfg.apiKey } : {};
  const [sum, latency] = await timed(() =>
    req(join(cfg.url, '/api/widget/summary'), { headers }).catch(async e => {
      if (!/HTTP (401|403|404)/.test(e.message)) throw e;
      await req(join(cfg.url, '/api/health'));
      return { limited: /404/.test(e.message) ? 'old' : 'auth' };
    })
  );
  if (sum.limited) {
    const msg = sum.limited === 'auth'
      ? 'Up, but the API key was rejected — add it in Settings to see sync stats.'
      : 'Up. This Clonarr build has no stats endpoint yet (needs a release with /api/widget/summary).';
    return { version: null, latency, data: { limited: true, note: msg } };
  }
  const rules = sum.rules?.list || [];
  const events = rules
    .filter(r => r.lastSyncError)
    .map(r => ({
      time: r.lastSyncTime || sum.serverNow,
      level: 'error',
      source: `${r.instanceName} · ${r.arrProfileName || r.profileName}`,
      message: `Profile sync failed: ${r.lastSyncError}`,
    }));
  if (sum.autoSync?.lastError && !events.length)
    events.push({ time: sum.autoSync.lastSync || sum.serverNow, level: 'error', source: 'Auto-sync', message: sum.autoSync.lastError });
  for (const r of rules.filter(x => x.orphaned))
    events.push({ time: sum.serverNow, level: 'warn', source: r.instanceName, message: `Sync rule "${r.profileName}" points at a profile that no longer exists in ${r.instanceType}` });

  return {
    version: sum.version,
    latency,
    data: {
      stats: {
        instances: sum.instances?.total ?? 0,
        profiles: sum.rules?.total ?? 0,
        active: sum.rules?.active ?? 0,
        withErrors: sum.rules?.withErrors ?? 0,
        paused: !!sum.autoSync?.paused,
        lastPull: sum.trash?.lastPull || null,
        nextPull: sum.trash?.nextPull || null,
        lastSync: sum.autoSync?.lastSync || null,
        trashCommit: sum.trash?.commit ? String(sum.trash.commit).slice(0, 7) : null,
      },
      events,
    },
  };
}

module.exports = { clonarr };
