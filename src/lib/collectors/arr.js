// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Sonarr, Radarr, Lidarr, Readarr and Prowlarr. They share one REST API design, so they share
// the helpers at the top: queue, logs, health, library lists, imports and update checks.
'use strict';
const { join, req, timed, cached, background } = require('../http');
const { DAY, MINUTE, isoDate, pad, sum, normLevel, UPDATE_TTL } = require('./shared');

// *arr REST client: Sonarr/Radarr use API v3, Lidarr/Readarr/Prowlarr use v1.
function arrApi(cfg, ver) {
  return (p, opts = {}) => req(join(cfg.url, `/api/${ver}${p}`), { headers: { 'X-Api-Key': cfg.apiKey }, ...opts });
}

// Normalise a page of an *arr queue. `label` builds a readable title from the series/movie/
// album the queue call was asked to include; otherwise we fall back to the release name.
const mapQueue = (q, label) =>
  (q.records || []).map(r => ({
    id: r.id,
    title: label(r) || r.title,
    size: r.size,
    left: r.sizeleft,
    progress: r.size ? 1 - r.sizeleft / r.size : 0,
    status: r.trackedDownloadState || r.status,
    warning: r.trackedDownloadStatus === 'warning' || r.trackedDownloadStatus === 'error',
    eta: r.timeleft,
    protocol: r.protocol,
    client: r.downloadClient,
    messages: [
      ...(r.statusMessages || []).flatMap(m => (m.messages?.length ? m.messages : [m.title])),
      r.errorMessage,
    ].filter(Boolean),
  }));

// Recent imports (history event 3 = "download folder imported" in both Sonarr and Radarr).
function arrImports(cfg, api, include, label) {
  return cached(`imports:${cfg.url}`, 2 * 60e3, async () => {
    const r = await api(
      `/history?page=1&pageSize=25&sortKey=date&sortDirection=descending&eventType=3&${include}`,
    ).catch(() => null);
    return (r?.records || []).map(x => ({ time: x.date, title: label(x), quality: x.quality?.quality?.name || null }));
  });
}

// Recent warnings/errors from an *arr's own log (System → Logs in the UI).
// v4+ honours `level=warn` (warn and above); older builds ignore it, so filter here too.
async function arrLogs(cfg, api) {
  return cached(`logs:${cfg.url}`, 60e3, async () => {
    const r = await api('/log?page=1&pageSize=50&sortKey=time&sortDirection=descending&level=warn').catch(() => null);
    return (r?.records || [])
      .filter(x => normLevel(x.level))
      .map(x => ({
        time: x.time,
        level: normLevel(x.level),
        source: x.logger,
        message: x.message,
        detail: x.exception || null,
      }));
  });
}

// Queue items stuck with warnings (failed import, sample, no match…) are as important as log errors.
const queueEvents = queue =>
  queue
    .filter(q => q.warning)
    .map(q => ({
      time: new Date().toISOString(),
      level: 'warn',
      source: 'Queue',
      message: `${q.title}: ${q.messages[0] || q.status}`,
      detail: q.messages.slice(1).join('\n') || null,
      live: true,
      queueId: q.id,
    }));

const mapHealth = h => h.map(x => ({ type: x.type, message: x.message }));

// Whole-library lists (every series / movie / artist) are big: 1.4 MB and 2.5 s for a large
// Sonarr. They only feed the totals, which barely move, so keep a slim copy for a few minutes
// instead of refetching them on every refresh. The calendar is cached the same way.
const LIBRARY_TTL = 5 * 60e3;
const pick = (o, ...keys) => Object.fromEntries(keys.map(k => [k, o?.[k]]));
const libraryList = (cfg, fetch, slim) =>
  cached(`library:${cfg.url}`, LIBRARY_TTL, async () => (await fetch()).map(slim));

// Per-title sizes for "What's using space" (server-side only: lib/space.js reads these
// underscore fields and server.js strips them before anything goes to the browser).
const spaceItems = (list, kind, title = x => x.title) =>
  list.map(x => ({
    kind,
    id: x.id,
    title: title(x),
    year: x.year || null,
    slug: x.slug || null,
    added: x.added || null,
    size: x.statistics?.sizeOnDisk ?? x.sizeOnDisk ?? 0,
  }));
// Everything imported in the last 30 days, summed per series / movie. Refreshed hourly in the
// background: on a big Sonarr this is a 1-2 MB reply that takes 10+ seconds.
const IMPORTED = new Set([3, 'downloadFolderImported']);
const downloaded30 = (cfg, api, idKey) =>
  background(`dl30:${cfg.url}`, 60 * 60e3, async () => {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const rows = await api(`/history/since?date=${encodeURIComponent(since)}&eventType=3`, { timeout: 60000 });
    const by = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r.eventType != null && !IMPORTED.has(r.eventType)) continue; // in case the filter is ignored
      const id = r[idKey];
      if (id == null) continue;
      const e = by.get(id) || { id, bytes: 0, count: 0 };
      e.bytes += Number(r.data?.size) || 0;
      e.count++;
      by.set(id, e);
    }
    return [...by.values()];
  });

// Newest release the app knows about, if it isn't the one installed (checked every 6 hours).
const arrUpdate = (cfg, api, current) =>
  background(`update:${cfg.url}`, UPDATE_TTL, async () => {
    const list = await api('/update');
    const latest = Array.isArray(list) ? list.find(u => u.latest) || list[0] : null;
    return latest?.version && !latest.installed && latest.version !== current ? { version: latest.version } : null;
  });

async function sonarr(cfg) {
  const api = arrApi(cfg, 'v3');
  const [status, latency] = await timed(() => api('/system/status'));
  const now = Date.now();
  const [series, queue, missing, health, disks, cal, logs, imports] = await Promise.all([
    libraryList(
      cfg,
      () => api('/series'),
      s => ({
        id: s.id,
        title: s.title,
        year: s.year,
        slug: s.titleSlug,
        added: s.added,
        monitored: s.monitored,
        status: s.status,
        statistics: pick(s.statistics, 'episodeFileCount', 'sizeOnDisk'),
      }),
    ),
    api('/queue?pageSize=100&includeSeries=true&includeEpisode=true'),
    cached(`missing:${cfg.url}`, MINUTE, () => api('/wanted/missing?pageSize=1&monitored=true')),
    api('/health'),
    cached(`diskspace:${cfg.url}`, MINUTE, () => api('/diskspace')),
    cached(`calendar:${cfg.url}`, LIBRARY_TTL, () =>
      api(`/calendar?start=${isoDate(now - DAY)}&end=${isoDate(now + 8 * DAY)}&includeSeries=true`),
    ),
    arrLogs(cfg, api),
    arrImports(cfg, api, 'includeSeries=true&includeEpisode=true', x =>
      x.series ? `${x.series.title} S${pad(x.episode?.seasonNumber)}E${pad(x.episode?.episodeNumber)}` : x.sourceTitle,
    ),
  ]);
  const st = s => s.statistics || {};
  const q = mapQueue(queue, r =>
    r.series ? `${r.series.title} S${pad(r.episode?.seasonNumber)}E${pad(r.episode?.episodeNumber)}` : null,
  );
  return {
    version: status.version,
    latency,
    data: {
      update: await arrUpdate(cfg, api, status.version),
      _library: spaceItems(series, 'series'),
      _downloaded30: await downloaded30(cfg, api, 'seriesId'),
      stats: {
        series: series.length,
        monitored: series.filter(s => s.monitored).length,
        continuing: series.filter(s => s.status === 'continuing').length,
        episodes: sum(series, s => st(s).episodeFileCount),
        missing: missing.totalRecords,
        size: sum(series, s => st(s).sizeOnDisk),
      },
      queue: q,
      health: mapHealth(health),
      events: [...queueEvents(q), ...logs],
      imports,
      disks,
      upcoming: cal.map(e => ({
        kind: 'tv',
        title: e.series?.title || 'Unknown series',
        sub: `S${pad(e.seasonNumber)}E${pad(e.episodeNumber)} · ${e.title}`,
        date: e.airDateUtc,
        hasFile: e.hasFile,
      })),
    },
  };
}

// ---------------------------------------------------------------- Radarr
async function radarr(cfg) {
  const api = arrApi(cfg, 'v3');
  const [status, latency] = await timed(() => api('/system/status'));
  const now = Date.now();
  const [movies, queue, health, disks, cal, logs, imports] = await Promise.all([
    libraryList(
      cfg,
      () => api('/movie'),
      m => ({
        id: m.id,
        title: m.title,
        year: m.year,
        slug: m.titleSlug,
        added: m.added,
        ...pick(m, 'monitored', 'hasFile', 'isAvailable', 'sizeOnDisk'),
      }),
    ),
    api('/queue?pageSize=100&includeMovie=true'),
    api('/health'),
    cached(`diskspace:${cfg.url}`, MINUTE, () => api('/diskspace')),
    cached(`calendar:${cfg.url}`, LIBRARY_TTL, () =>
      api(`/calendar?start=${isoDate(now - DAY)}&end=${isoDate(now + 30 * DAY)}`),
    ),
    arrLogs(cfg, api),
    arrImports(cfg, api, 'includeMovie=true', x => (x.movie ? `${x.movie.title} (${x.movie.year})` : x.sourceTitle)),
  ]);
  const releaseDate = m => m.digitalRelease || m.physicalRelease || m.inCinemas;
  const q = mapQueue(queue, r => (r.movie ? `${r.movie.title} (${r.movie.year})` : null));
  return {
    version: status.version,
    latency,
    data: {
      update: await arrUpdate(cfg, api, status.version),
      _library: spaceItems(movies, 'movie'),
      _downloaded30: await downloaded30(cfg, api, 'movieId'),
      stats: {
        movies: movies.length,
        monitored: movies.filter(m => m.monitored).length,
        onDisk: movies.filter(m => m.hasFile).length,
        missing: movies.filter(m => m.monitored && !m.hasFile && m.isAvailable).length,
        size: sum(movies, m => m.sizeOnDisk),
      },
      queue: q,
      health: mapHealth(health),
      events: [...queueEvents(q), ...logs],
      imports,
      disks,
      upcoming: cal
        .filter(m => releaseDate(m))
        .map(m => ({
          kind: 'movie',
          title: m.title,
          sub: m.digitalRelease ? 'Digital release' : m.physicalRelease ? 'Physical release' : 'In cinemas',
          date: releaseDate(m),
          hasFile: m.hasFile,
        })),
    },
  };
}

// ---------------------------------------------------------------- Lidarr
async function lidarr(cfg) {
  const api = arrApi(cfg, 'v1');
  const [status, latency] = await timed(() => api('/system/status'));
  const now = Date.now();
  const [artists, queue, missing, health, disks, cal, logs] = await Promise.all([
    libraryList(
      cfg,
      () => api('/artist'),
      a => ({
        id: a.id,
        title: a.artistName,
        slug: a.foreignArtistId,
        added: a.added,
        statistics: pick(a.statistics, 'albumCount', 'trackFileCount', 'sizeOnDisk'),
      }),
    ),
    api('/queue?pageSize=100&includeArtist=true&includeAlbum=true'),
    cached(`missing:${cfg.url}`, MINUTE, () => api('/wanted/missing?pageSize=1')),
    api('/health'),
    cached(`diskspace:${cfg.url}`, MINUTE, () => api('/diskspace')),
    cached(`calendar:${cfg.url}`, LIBRARY_TTL, () =>
      api(`/calendar?start=${isoDate(now - DAY)}&end=${isoDate(now + 30 * DAY)}&includeArtist=true`),
    ),
    arrLogs(cfg, api),
  ]);
  const st = a => a.statistics || {};
  const q = mapQueue(queue, r => (r.artist && r.album ? `${r.artist.artistName} — ${r.album.title}` : null));
  return {
    version: status.version,
    latency,
    data: {
      update: await arrUpdate(cfg, api, status.version),
      _library: spaceItems(artists, 'artist'),
      stats: {
        artists: artists.length,
        albums: sum(artists, a => st(a).albumCount),
        tracks: sum(artists, a => st(a).trackFileCount),
        missing: missing.totalRecords,
        size: sum(artists, a => st(a).sizeOnDisk),
      },
      queue: q,
      health: mapHealth(health),
      events: [...queueEvents(q), ...logs],
      disks,
      upcoming: cal.map(a => ({
        kind: 'music',
        title: a.artist?.artistName || 'Unknown artist',
        sub: a.title,
        date: a.releaseDate,
        hasFile: (a.statistics?.trackFileCount || 0) > 0,
      })),
    },
  };
}

// ---------------------------------------------------------------- Readarr
async function readarr(cfg) {
  const api = arrApi(cfg, 'v1');
  const [status, latency] = await timed(() => api('/system/status'));
  const [authors, queue, missing, health, disks, logs] = await Promise.all([
    libraryList(
      cfg,
      () => api('/author'),
      a => ({ statistics: pick(a.statistics, 'bookFileCount', 'sizeOnDisk') }),
    ),
    api('/queue?pageSize=100&includeAuthor=true&includeBook=true'),
    cached(`missing:${cfg.url}`, MINUTE, () => api('/wanted/missing?pageSize=1')),
    api('/health'),
    cached(`diskspace:${cfg.url}`, MINUTE, () => api('/diskspace')),
    arrLogs(cfg, api),
  ]);
  const st = a => a.statistics || {};
  const q = mapQueue(queue, r => (r.author && r.book ? `${r.author.authorName} — ${r.book.title}` : null));
  return {
    version: status.version,
    latency,
    data: {
      update: await arrUpdate(cfg, api, status.version),
      stats: {
        authors: authors.length,
        books: sum(authors, a => st(a).bookFileCount),
        missing: missing.totalRecords,
        size: sum(authors, a => st(a).sizeOnDisk),
      },
      queue: q,
      health: mapHealth(health),
      events: [...queueEvents(q), ...logs],
      disks,
      upcoming: [],
    },
  };
}

// ---------------------------------------------------------------- Prowlarr
async function prowlarr(cfg) {
  const api = arrApi(cfg, 'v1');
  const [status, latency] = await timed(() => api('/system/status'));
  const [indexers, statuses, health, stats, logs] = await Promise.all([
    cached(`indexers:${cfg.url}`, MINUTE, () => api('/indexer')),
    api('/indexerstatus'),
    api('/health'),
    cached(`prowlarr-stats:${cfg.url}`, 5 * 60e3, () => api('/indexerstats').catch(() => null)),
    arrLogs(cfg, api),
  ]);
  const idx = stats?.indexers || [];

  // API limits, counted the way Prowlarr enforces them: queries (searches + RSS) and grabs over
  // a rolling day, or a rolling hour when the indexer's limit unit is "Hour".
  const field = (i, name) => i.fields?.find(f => f.name === name)?.value;
  const hourly = i => field(i, 'baseSettings.limitsUnit') === 1;
  const enabled = indexers.filter(i => i.enable);
  const usage = hours =>
    cached(`prowlarr-${hours}h:${cfg.url}`, 2 * 60e3, () =>
      api(`/indexerstats?startDate=${encodeURIComponent(new Date(Date.now() - hours * 3600e3).toISOString())}`)
        .then(r => r.indexers || [])
        .catch(() => []),
    );
  const [day, hour] = await Promise.all([usage(24), enabled.some(hourly) ? usage(1) : []]);
  const now = new Date();
  const limits = enabled
    .map(i => {
      const u = (hourly(i) ? hour : day).find(x => x.indexerId === i.id) || {};
      const st = statuses.find(x => x.indexerId === i.id);
      return {
        name: i.name,
        unit: hourly(i) ? 'hour' : 'day',
        queries: (u.numberOfQueries || 0) + (u.numberOfRssQueries || 0),
        queryLimit: Number(field(i, 'baseSettings.queryLimit')) || null,
        grabs: u.numberOfGrabs || 0,
        grabLimit: Number(field(i, 'baseSettings.grabLimit')) || null,
        pausedUntil: st?.disabledTill && new Date(st.disabledTill) > now ? st.disabledTill : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  // Live warnings at 90% and 100% of a limit. Messages name the threshold, not the count, so
  // they stay the same while usage creeps up.
  const limitEvents = [];
  for (const l of limits)
    for (const [what, used, max] of [
      ['API', l.queries, l.queryLimit],
      ['grab', l.grabs, l.grabLimit],
    ]) {
      if (!max || used < max * 0.9) continue;
      const period = l.unit === 'hour' ? 'hourly' : 'daily';
      limitEvents.push({
        time: now.toISOString(),
        level: used >= max ? 'error' : 'warn',
        source: 'Indexer limits',
        live: true,
        message:
          used >= max
            ? `${l.name} has hit its ${period} ${what} limit`
            : `${l.name} has used 90% of its ${period} ${what} limit`,
        detail: `${used} of ${max} ${what === 'API' ? 'queries' : 'grabs'} in the last ${l.unit === 'hour' ? 'hour' : '24 hours'}`,
      });
    }
  return {
    version: status.version,
    latency,
    data: {
      update: await arrUpdate(cfg, api, status.version),
      stats: {
        indexers: indexers.length,
        enabled: indexers.filter(i => i.enable).length,
        failing: statuses.filter(s => s.disabledTill && new Date(s.disabledTill) > new Date()).length,
        queries: sum(idx, i => i.numberOfQueries),
        grabs: sum(idx, i => i.numberOfGrabs),
        avgResponseMs: idx.length ? Math.round(sum(idx, i => i.averageResponseTime) / idx.length) : null,
      },
      limits,
      health: mapHealth(health),
      events: [...limitEvents, ...logs],
    },
  };
}

module.exports = { sonarr, radarr, lidarr, readarr, prowlarr };
