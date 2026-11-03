// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub: the one event format every source is turned into (docs/notification-hub.md),
// with the helpers the parsers share: dedupe keys, severities, and turning what the background
// poll already noticed (lib/notify.js detect()) into hub events.
'use strict';
const crypto = require('node:crypto');

/**
 * @typedef {'info' | 'warning' | 'error' | 'critical'} Severity
 * @typedef {{
 *   kind: 'movie' | 'episode' | 'show' | null, title: string, year: number | null, library: string | null,
 *   ids: { tmdb: number | null, imdb: string | null, tvdb: number | null },
 *   show: string | null, season: number | null, episode: number | null, episodeTitle: string | null,
 *   quality: string | null, posterUrl: string | null, overview: string | null,
 * }} Media
 * @typedef {{
 *   id: string, receivedAt: number, source: string, sourceInstance: string, type: string,
 *   severity: Severity, summary: string, media: Media | null, isUpgrade: boolean,
 *   dedupeKey: string, raw: unknown,
 * }} HubEvent
 * @typedef {Omit<HubEvent, 'id' | 'receivedAt' | 'source' | 'sourceInstance' | 'raw'>} Parsed
 */

const SEVERITIES = /** @type {const} */ (['info', 'warning', 'error', 'critical']);
/** @param {unknown} s @returns {Severity} */
const severity = s => {
  const v = String(s || '').toLowerCase();
  if (v === 'warn') return 'warning';
  return /** @type {Severity} */ (SEVERITIES.find(x => x === v) || 'info');
};

/** @param {unknown} n */
const int = n => (Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : null);
/** @param {unknown} s @param {number} [max] */
const str = (s, max = 500) => (s == null || s === '' ? null : String(s).slice(0, max));
/** @param {number | null} n */
const pad = n => String(n ?? 0).padStart(2, '0');

// Anything title-like from a parser -> a clean Media: lengths capped, ids as numbers, https posters only.
/** @param {Record<string, any>} m @returns {Media} */
function media(m) {
  return {
    kind: m.kind ?? null,
    title: String(m.title || 'Unknown title').slice(0, 300),
    year: int(m.year),
    library: str(m.library, 100),
    ids: { tmdb: int(m.ids?.tmdb), imdb: str(m.ids?.imdb, 20), tvdb: int(m.ids?.tvdb) },
    show: str(m.show, 300),
    season: Number.isInteger(m.season) ? /** @type {number} */ (m.season) : null,
    episode: Number.isInteger(m.episode) ? /** @type {number} */ (m.episode) : null,
    episodeTitle: str(m.episodeTitle, 300),
    quality: str(m.quality, 100),
    posterUrl: m.posterUrl && /^https:\/\/[^\s]+$/i.test(m.posterUrl) ? m.posterUrl.slice(0, 1000) : null,
    overview: str(m.overview, 1000),
  };
}

// The same title from any source gets the same key: movies by TMDB id, episodes by the show's
// TVDB id plus season and episode. Without ids, the title (and year) has to do.
/** @param {Media} m */
function dedupeKey(m) {
  const slug = `${m.title}${m.year ? `:${m.year}` : ''}`.toLowerCase().replace(/\s+/g, ' ');
  if (m.kind === 'episode')
    return `episode:${m.ids.tvdb ? `tvdb:${m.ids.tvdb}` : `title:${(m.show || m.title).toLowerCase()}`}:S${pad(m.season)}E${pad(m.episode)}`;
  if (m.kind === 'show') return m.ids.tvdb ? `show:tvdb:${m.ids.tvdb}` : `show:title:${slug}`;
  if (m.ids.tmdb) return `movie:tmdb:${m.ids.tmdb}`;
  if (m.ids.imdb) return `movie:imdb:${m.ids.imdb}`;
  return `movie:title:${slug}`;
}

/** @param {string} s */
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** @param {Media} m */
function label(m) {
  if (m.kind === 'episode')
    return `${m.show || m.title} S${pad(m.season)}E${pad(m.episode)}${m.episodeTitle ? ` "${m.episodeTitle}"` : ''}`;
  return `${m.title}${m.year ? ` (${m.year})` : ''}`;
}

/** @param {{ source: string, sourceInstance: string, raw: unknown }} from @param {Parsed} p @returns {HubEvent} */
const finish = (from, p) => ({ id: crypto.randomUUID(), receivedAt: Date.now(), ...from, ...p });

// ------------------------------------------------------------------ what the background poll noticed
// lib/notify.js detect() kinds -> hub types. "unraid" covers every server problem (array, pools,
// TrueNAS alerts, hot disks), so it becomes system.server rather than a guess at disk or temp.
/** @type {Record<string, string>} */
const POLLED_TYPE = {
  down: 'app.down',
  recovered: 'app.up',
  errors: 'app.error',
  warnings: 'app.warning',
  downloads: 'download.failed',
  disk: 'system.disk',
  unraid: 'system.server',
  bandwidth: 'system.bandwidth',
  streams: 'playback.started',
  problems: 'media.problem_report',
};
/** @type {Record<string, Severity>} */
const LEVEL = { error: 'error', warn: 'warning', good: 'info', info: 'info' };

// One detect() item -> a hub event. `ref` (an app id, disk path, errors-feed key…) keeps the
// dedupe key stable while the line itself carries changing numbers ("down for 12 min").
/** @param {{ kind: string, level: string, line: string, ref?: string }} f @returns {HubEvent} */
function fromPolled(f) {
  const type = POLLED_TYPE[f.kind] || 'custom';
  return finish(
    { source: 'media-ops', sourceInstance: 'media-ops', raw: null },
    {
      type,
      severity: LEVEL[f.level] || 'info',
      summary: f.line.slice(0, 500),
      media: null,
      isUpgrade: false,
      dedupeKey: `${type}:${f.ref ?? hash(f.line)}`,
    },
  );
}

// Media Review's Leaving Soon list -> media.leaving_soon for each title that wasn't on it at the
// last poll. The list from an app's first poll is only learned, not announced.
/** @type {Map<string, Set<string>>} */
const leavingSeen = new Map();
/** @param {{ id: string, kind: string, up: boolean, data?: any }[]} services @returns {HubEvent[]} */
function fromMediaReview(services) {
  /** @type {HubEvent[]} */
  const out = [];
  for (const s of services) {
    if (s.kind !== 'mediareview' || !s.up || !Array.isArray(s.data?.leavingSoon)) continue;
    const known = leavingSeen.get(s.id);
    const now = new Set();
    for (const l of s.data.leavingSoon) {
      const key = String(l.ratingKey);
      now.add(key);
      if (!known || known.has(key)) continue;
      const m = media({ kind: l.kind === 'show' ? 'show' : 'movie', title: l.title, year: l.year, library: l.library });
      out.push(
        finish(
          { source: 'mediareview', sourceInstance: s.id, raw: null },
          {
            type: 'media.leaving_soon',
            severity: 'info',
            summary: `${label(m)} is leaving soon${l.daysLeft ? ` (${l.daysLeft} days left)` : ''}`,
            media: m,
            isUpgrade: false,
            dedupeKey: `${dedupeKey(m)}:plex:${key}`,
          },
        ),
      );
    }
    leavingSeen.set(s.id, now);
  }
  return out;
}

module.exports = { SEVERITIES, severity, media, dedupeKey, label, finish, fromPolled, fromMediaReview, int, str };
