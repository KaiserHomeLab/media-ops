// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub: one parser per kind of source, turning a webhook body into hub events
// (lib/hub/normalize.js). A body can become several events (a Sonarr import of a file holding
// two episodes) or a single "hub.unhandled" one, so Activity still shows that it arrived.
'use strict';
const { media, dedupeKey, label, severity, int, str } = require('./normalize');
const { list } = require('../collectors/shared');

/** @typedef {import('./normalize').Parsed} Parsed */
/** @typedef {{ library?: string }} SourceOptions */

/** @param {string} type @param {string} summary @param {import('./normalize').Severity} [sev] @returns {Parsed} */
const plain = (type, summary, sev = 'info') => ({
  type,
  severity: sev,
  summary: summary.slice(0, 500),
  media: null,
  isUpgrade: false,
  dedupeKey: `${type}:${summary.slice(0, 200)}`,
});
/** @param {string} type @param {import('./normalize').Media} m @param {string} summary @param {boolean} [isUpgrade] @returns {Parsed} */
const about = (type, m, summary, isUpgrade = false) => ({
  type,
  severity: 'info',
  summary: summary.slice(0, 500),
  media: m,
  isUpgrade,
  dedupeKey: dedupeKey(m),
});

/** @param {any} images */
const poster = images => (Array.isArray(images) ? images : []).find(i => i?.coverType === 'poster')?.remoteUrl || null;
/** @param {any} q a quality: "Bluray-1080p", or { quality: { name } } in some payloads */
const quality = q => str(typeof q === 'string' ? q : q?.quality?.name);

// ------------------------------------------------------------------ Sonarr and Radarr
// Settings → Connect → Webhook. The fix this whole hub exists for: an upgrade is told apart from
// a new title by the *arr's own isUpgrade flag, never by what Plex thinks is new.
/** @param {any} b @param {'sonarr' | 'radarr'} app @param {SourceOptions} opts @returns {Parsed[]} */
function arr(b, app, opts) {
  const ev = String(b?.eventType || '');
  const instance = str(b?.instanceName, 100) || (app === 'sonarr' ? 'Sonarr' : 'Radarr');
  if (ev === 'Test') return [plain('hub.test', `Test from ${instance}`)];
  if (ev === 'Health' || ev === 'HealthRestored') {
    const msg = str(b.message) || 'Health check';
    return [
      {
        ...plain(
          ev === 'Health' ? 'app.health_issue' : 'app.health_restored',
          `${instance}: ${msg}`,
          ev === 'Health' ? (b.level === 'error' ? 'error' : 'warning') : 'info',
        ),
        // The check's type stays the same while its message names changing indexers or counts.
        dedupeKey: `health:${app}:${str(b.type, 100) || msg}`,
      },
    ];
  }
  const items = app === 'sonarr' ? episodes(b, opts) : movie(b, opts);
  if (!items.length) return [plain('hub.unhandled', `${instance}: ${ev || 'unknown event'} (no title in it)`)];
  const upgrade = b.isUpgrade === true;
  switch (ev) {
    case 'Download':
      return items.map(m =>
        about(upgrade ? 'media.upgraded' : 'media.added', m, `${upgrade ? 'Upgraded' : 'Added'}: ${label(m)}`, upgrade),
      );
    case 'ManualInteractionRequired':
      return items.map(m => ({
        ...about('download.stuck', m, `${instance} needs you to import ${label(m)} by hand`),
        severity: 'warning',
      }));
    case 'MovieFileDelete':
    case 'EpisodeFileDelete':
      // A file replaced by a better one is an upgrade, not a removal.
      if (/upgrade/i.test(String(b.deleteReason || '')))
        return items.map(m => about('hub.unhandled', m, `${instance}: old file of ${label(m)} replaced by an upgrade`));
      return items.map(m => about('media.removed', m, `Removed: ${label(m)}`));
    case 'MovieDelete':
    case 'SeriesDelete':
      return items.map(m => about('media.removed', m, `Removed: ${label(m)}`));
    default:
      return [plain('hub.unhandled', `${instance}: ${ev || 'unknown event'} for ${label(items[0])}`)];
  }
}

/** @param {any} b @param {SourceOptions} opts @returns {import('./normalize').Media[]} */
function episodes(b, opts) {
  const s = b?.series;
  if (!s) return [];
  // Anime is a series type in Sonarr; a source can also name its library outright (an anime instance).
  const library = opts.library || (s.type === 'anime' ? 'Anime' : 'TV Shows');
  const base = {
    title: s.title,
    show: s.title,
    year: s.year,
    library,
    ids: { tvdb: s.tvdbId, tmdb: s.tmdbId, imdb: s.imdbId },
    posterUrl: poster(s.images),
    quality: quality(b.episodeFile?.quality ?? b.downloadInfo?.quality),
  };
  const eps = list(b.episodes);
  if (!eps.length) return [media({ ...base, kind: 'show', overview: s.overview })];
  return eps.map(e =>
    media({
      ...base,
      kind: 'episode',
      season: int(e.seasonNumber) ?? (e.seasonNumber === 0 ? 0 : null),
      episode: int(e.episodeNumber),
      episodeTitle: e.title,
      overview: e.overview,
    }),
  );
}

/** @param {any} b @param {SourceOptions} opts @returns {import('./normalize').Media[]} */
function movie(b, opts) {
  const m = b?.movie || b?.remoteMovie;
  if (!m) return [];
  return [
    media({
      kind: 'movie',
      title: m.title,
      year: m.year,
      library: opts.library || 'Movies',
      ids: { tmdb: m.tmdbId, imdb: m.imdbId },
      posterUrl: poster(m.images),
      quality: quality(b.movieFile?.quality ?? b.downloadInfo?.quality),
      overview: m.overview,
    }),
  ];
}

// ------------------------------------------------------------------ Seerr (Overseerr, Jellyseerr)
// Settings → Notifications → Webhook with the default JSON payload.
/** @type {Record<string, string>} */
const SEERR_TYPE = {
  MEDIA_PENDING: 'media.request.created',
  MEDIA_AUTO_REQUESTED: 'media.request.created',
  MEDIA_APPROVED: 'media.request.approved',
  MEDIA_AUTO_APPROVED: 'media.request.approved',
  MEDIA_AVAILABLE: 'media.request.available',
  MEDIA_FAILED: 'media.request.failed',
  MEDIA_DECLINED: 'media.request.declined',
  ISSUE_CREATED: 'media.issue.created',
  ISSUE_COMMENT: 'media.issue.comment',
  ISSUE_RESOLVED: 'media.issue.resolved',
  ISSUE_REOPENED: 'media.issue.reopened',
  TEST_NOTIFICATION: 'hub.test',
};
const SEERR_VERB = {
  'media.request.created': 'Requested',
  'media.request.approved': 'Approved',
  'media.request.available': 'Now available',
  'media.request.failed': 'Request failed',
  'media.request.declined': 'Request declined',
  'media.issue.created': 'Issue reported',
  'media.issue.comment': 'Issue comment',
  'media.issue.resolved': 'Issue resolved',
  'media.issue.reopened': 'Issue reopened',
};

/** @param {any} b @returns {Parsed[]} */
function seerr(b) {
  const nt = String(b?.notification_type || '');
  const type = SEERR_TYPE[nt];
  if (type === 'hub.test') return [plain('hub.test', 'Test from Seerr')];
  // "Dune (2021)" is how Seerr's default payload names the title.
  const subject = String(b?.subject || '');
  const [, name, year] = subject.match(/^(.*?)\s*\((\d{4})\)\s*$/) || [null, subject, null];
  const tv = b?.media?.media_type === 'tv';
  const m = media({
    kind: tv ? 'show' : 'movie',
    title: name || 'Unknown title',
    year,
    ids: { tmdb: b?.media?.tmdbId, tvdb: b?.media?.tvdbId },
    posterUrl: b?.image,
    overview: b?.message,
  });
  if (!type) return [about('hub.unhandled', m, `Seerr: ${nt || 'unknown event'} for ${label(m)}`)];
  const verb = /** @type {Record<string, string>} */ (SEERR_VERB)[type];
  const by = str(b?.request?.requestedBy_username, 100);
  return [
    {
      ...about(type, m, `${verb}: ${label(m)}${by && type === 'media.request.created' ? ` (by ${by})` : ''}`),
      severity: type === 'media.request.failed' ? 'warning' : 'info',
      // One request moves through several states; each state is its own event.
      dedupeKey: `${dedupeKey(m)}:${type}`,
    },
  ];
}

// ------------------------------------------------------------------ generic (scripts, anything else)
// Takes the hub's own format, a little at a time: only a type is required.
const TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
/** @param {any} b @returns {Parsed[]} */
function generic(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw httpError(400, 'Send a JSON object');
  const type = String(b.type || 'custom');
  if (!TYPE.test(type) || type.length > 64 || type.startsWith('hub.'))
    throw httpError(400, 'type must look like "custom" or "dcs.server_up" (lowercase, dots between words)');
  const summary = str(b.summary ?? b.message ?? b.title, 500);
  if (!summary && !b.media) throw httpError(400, 'Send a summary (or message) saying what happened');
  const m = b.media && typeof b.media === 'object' ? media(snake(b.media)) : null;
  return [
    {
      type,
      severity: severity(b.severity),
      summary: summary || (m ? label(m) : type),
      media: m,
      isUpgrade: b.is_upgrade === true,
      dedupeKey: str(b.dedupe_key, 200) || (m ? dedupeKey(m) : `${type}:${summary}`),
    },
  ];
}
// The spec's JSON is snake_case; the hub's own objects are camelCase.
/** @param {any} m @returns {Record<string, any>} */
const snake = m => ({
  ...m,
  posterUrl: m.poster_url ?? m.posterUrl,
  episodeTitle: m.episode_title ?? m.episodeTitle,
});

/** @param {number} status @param {string} message */
const httpError = (status, message) => Object.assign(new Error(message), { status });

module.exports = { arr, seerr, generic, httpError };
