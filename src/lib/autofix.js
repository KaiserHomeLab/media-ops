// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Stuck downloads, fixed automatically (Settings → Stuck downloads; off unless turned on).
// A download counts as stuck while Sonarr, Radarr, Lidarr or Readarr flags it in its queue
// with a warning or error (failed import, no files found, stalled with no connections…). It
// gets the same two steps as the buttons on the dashboard, just on a timer:
//   half the wait   the app re-checks its downloads (harmless: often clears a stale warning)
//   full wait       the download is removed, blocklisted, and the app searches for another
// At most 3 removals per app per hour, so a misbehaving indexer can't make it churn. Each fix
// is sent as a "Failed or stuck downloads" notification and listed in Settings.
'use strict';
const actions = require('./actions');

const ARR = new Set(['sonarr', 'radarr', 'lidarr', 'readarr']);
const MAX_PER_HOUR = 3;
const HOUR = 60 * 60e3;

const state = {
  stuck: /** @type {Map<string, { since: number, retried: boolean }>} */ (new Map()), // "<app id>:<queue id>"
  removals: /** @type {Map<string, number[]>} */ (new Map()), // app id -> times of recent removals
  log: /** @type {{ at: number, app: string, title: string, reason: string, ok: boolean, error?: string }[]} */ ([]),
};

/** @param {any} cfg */
const settingsOf = cfg => ({
  enabled: !!cfg.autoFix?.enabled,
  minutes: Math.min(1440, Math.max(15, Math.round(Number(cfg.autoFix?.minutes)) || 60)),
});
/** @param {any} input */
const clean = input => settingsOf({ autoFix: input });

/** @param {number} ms */
const ago = ms => (ms >= 2 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / 60e3)} min`);

/**
 * One monitor tick. Tracks stuck items even while off (so the clock is right when it's turned
 * on) and acts only when on. Returns notification lines for lib/notify.js.
 * @param {{ services: import('./types').Polled[] }} raw the poll result @param {import('./types').Config} cfg
 * @param {number} [now] @param {Pick<typeof actions, 'queueRetry' | 'queueRemove'>} [act]
 */
async function tick(raw, cfg, now = Date.now(), act = actions) {
  const st = settingsOf(cfg);
  const seen = new Set();
  const out = [];
  for (const s of raw.services) {
    if (!s.up || !ARR.has(s.kind)) continue;
    const svc = cfg.services.find(x => x.id === s.id);
    if (!svc) continue;
    let recheck = false;
    for (const q of s.data?.queue || []) {
      if (!q.warning || q.status === 'importing') continue;
      const key = `${s.id}:${q.id}`;
      seen.add(key);
      const item = state.stuck.get(key) || { since: now, retried: false };
      state.stuck.set(key, item);
      if (!st.enabled) continue;
      const age = now - item.since;
      if (age >= st.minutes * 60e3) {
        const recent = (state.removals.get(s.id) || []).filter(t => now - t < HOUR);
        state.removals.set(s.id, recent);
        if (recent.length >= MAX_PER_HOUR) continue; // try again once the hour has room
        const reason = q.messages?.[0] || q.status || 'stuck';
        try {
          await act.queueRemove(svc, q.id);
          recent.push(now);
          state.stuck.delete(key);
          seen.delete(key);
          note({ at: now, app: s.name, title: q.title, reason, ok: true });
          out.push({
            kind: 'downloads',
            level: 'warn',
            line: `🔁 ${s.name}: replaced ${q.title} after ${ago(age)} stuck (${reason})`,
          });
        } catch (e) {
          item.since = now; // wait a full period before trying again
          note({ at: now, app: s.name, title: q.title, reason, ok: false, error: e.message });
        }
      } else if (!item.retried && age >= st.minutes * 30e3) {
        item.retried = true;
        recheck = true;
      }
    }
    if (recheck) await act.queueRetry(svc).catch(() => {}); // a failed re-check just waits for the removal step
  }
  for (const k of state.stuck.keys()) if (!seen.has(k)) state.stuck.delete(k); // cleared on its own
  return out;
}

/** @param {(typeof state.log)[number]} entry */
function note(entry) {
  state.log.unshift(entry);
  state.log.length = Math.min(state.log.length, 20);
}
const recent = () => state.log.slice();

module.exports = { settingsOf, clean, tick, recent };
