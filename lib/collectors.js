// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// One collector per app. Each takes a saved service ({ url, apiKey | token, … }) and
// returns { version, latency, data }; throwing means the app is down. public/app.js renders
// `data`, and an optional `data.events` array feeds the errors panel.
//
// To add an app: write a collector here, export it, and describe its settings form in kinds.js.
'use strict';
const { join, req, timed, cached } = require('./http');

const DAY = 864e5;
const isoDate = d => new Date(d).toISOString().slice(0, 10);
const pad = n => String(n ?? 0).padStart(2, '0');
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

// *arr REST client: Sonarr/Radarr use API v3, Lidarr/Readarr/Prowlarr use v1.
function arrApi(cfg, ver) {
  return p => req(join(cfg.url, `/api/${ver}${p}`), { headers: { 'X-Api-Key': cfg.apiKey } });
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
    messages: [...(r.statusMessages || []).flatMap(m => m.messages?.length ? m.messages : [m.title]), r.errorMessage].filter(Boolean),
  }));

// Recent warnings/errors from an *arr's own log (System → Logs in the UI).
// v4+ honours `level=warn` (warn and above); older builds ignore it, so filter here too.
const LEVELS = { warn: 'warn', warning: 'warn', error: 'error', fatal: 'error', critical: 'error' };
const normLevel = l => LEVELS[String(l || '').toLowerCase()];

// Recent imports (history event 3 = "download folder imported" in both Sonarr and Radarr).
function arrImports(cfg, api, include, label) {
  return cached(`imports:${cfg.url}`, 2 * 60e3, async () => {
    const r = await api(`/history?page=1&pageSize=25&sortKey=date&sortDirection=descending&eventType=3&${include}`).catch(() => null);
    return (r?.records || []).map(x => ({ time: x.date, title: label(x), quality: x.quality?.quality?.name || null }));
  });
}

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
  queue.filter(q => q.warning).map(q => ({
    time: new Date().toISOString(),
    level: 'warn',
    source: 'Queue',
    message: `${q.title}: ${q.messages[0] || q.status}`,
    detail: q.messages.slice(1).join('\n') || null,
    live: true,
    queueId: q.id,
  }));

const mapHealth = h => h.map(x => ({ type: x.type, message: x.message }));

// ---------------------------------------------------------------- Plex
// Plex doesn't say *why* it's transcoding, but the TranscodeSession tells us what changed
// (codec, resolution, subtitles, audio), which is what Tautulli and Plex Web infer from too.
const UP = s => String(s || '').toUpperCase();
function transcodeReason(ts, media) {
  const why = [];
  if (ts.subtitleDecision === 'burn') why.push('burning in subtitles');
  if (ts.videoDecision === 'transcode') {
    const src = ts.sourceVideoCodec || media.videoCodec;
    if (src && ts.videoCodec && UP(src) !== UP(ts.videoCodec)) why.push(`client can't play ${UP(src)} → ${UP(ts.videoCodec)}`);
    const srcRes = /^4k$/i.test(String(media.videoResolution)) ? 2160 : Number(media.videoResolution) || null;
    if (srcRes && ts.height && Number(ts.height) < srcRes * 0.9) why.push(`quality limit ${srcRes === 2160 ? '4K' : `${srcRes}p`} → ${ts.height}p`);
    if (!why.length) why.push('video transcode (bitrate or quality setting)');
  }
  if (ts.audioDecision === 'transcode') {
    const src = ts.sourceAudioCodec || media.audioCodec;
    why.push(src && ts.audioCodec && UP(src) !== UP(ts.audioCodec) ? `audio ${UP(src)} → ${UP(ts.audioCodec)}` : 'audio transcode');
  }
  if (!why.length && ts.videoDecision === 'copy') why.push(`remux ${UP(media.container)} → ${UP(ts.container)} (direct stream)`);
  return why.join(' · ') || null;
}

async function plex(cfg) {
  const headers = { 'X-Plex-Token': cfg.token };
  const api = p => req(join(cfg.url, p), { headers });
  const [identity, latency] = await timed(() => api('/identity'));

  const [sessions, libraries, resources, recent] = await Promise.all([
    api('/status/sessions'),
    cached(`plex-libs:${cfg.url}`, 5 * 60e3, async () => {
      const sections = await api('/library/sections');
      const count = async (key, type) => {
        const q = `${type ? `type=${type}&` : ''}X-Plex-Container-Start=0&X-Plex-Container-Size=0`;
        const r = await api(`/library/sections/${key}/all?${q}`);
        return r.MediaContainer.totalSize ?? r.MediaContainer.size ?? 0;
      };
      return Promise.all(
        (sections.MediaContainer.Directory || []).map(async d => {
          const lib = { title: d.title, type: d.type, count: await count(d.key) };
          if (d.type === 'show') lib.episodes = await count(d.key, 4);
          if (d.type === 'artist') [lib.albums, lib.tracks] = await Promise.all([count(d.key, 9), count(d.key, 10)]);
          return lib;
        })
      );
    }),
    // Host + Plex CPU/RAM, as on Plex's own dashboard (may need Plex Pass; skipped if refused).
    api('/statistics/resources?timespan=6').catch(() => null),
    cached(`plex-recent:${cfg.url}`, 2 * 60e3, () =>
      api('/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=16').catch(() => null)),
  ]);
  const res = resources?.MediaContainer?.StatisticsResources?.at(-1);

  const streams = (sessions.MediaContainer.Metadata || []).map(m => {
    const media = m.Media?.find(x => x.selected) || m.Media?.[0] || {};
    const ts = m.TranscodeSession;
    let decision = 'Direct Play';
    if (ts) {
      const v = ts.videoDecision, a = ts.audioDecision;
      decision = v === 'transcode' ? 'Transcode' : a === 'transcode' ? 'Transcode (audio)' : 'Direct Stream';
    }
    const reason = ts ? transcodeReason(ts, media) : null;
    const ep = m.type === 'episode';
    const track = m.type === 'track';
    return {
      id: m.sessionKey,
      user: m.User?.title || 'Unknown',
      player: m.Player?.title,
      product: m.Player?.product,
      platform: m.Player?.platform,
      state: m.Player?.state,
      local: m.Player?.local ?? m.Session?.location === 'lan',
      ip: m.Player?.address, // used for the stream map, then removed by lib/geo.js
      publicIp: m.Player?.remotePublicAddress,
      type: m.type,
      title: ep || track ? m.grandparentTitle : m.title,
      subtitle: ep
        ? `S${pad(m.parentIndex)}E${pad(m.index)} · ${m.title}`
        : track ? `${m.title} — ${m.parentTitle}` : m.year ? String(m.year) : '',
      thumb: ep ? m.grandparentThumb : track ? m.parentThumb : m.thumb,
      offset: m.viewOffset || 0,
      duration: m.duration || 0,
      decision,
      sessionId: m.Session?.id, // needed to stop a stream
      reason,
      fourKTranscode: ts?.videoDecision === 'transcode' && /^4k$/i.test(String(media.videoResolution || '')),
      hwName: ts?.transcodeHwEncodingTitle || ts?.transcodeHwDecodingTitle || null,
      hw: !!(ts && (ts.transcodeHwRequested || ts.transcodeHwFullPipeline)),
      transcodeSpeed: ts?.speed,
      resolution: media.videoResolution,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
      container: media.container,
      bitrate: media.bitrate, // kbps
      bandwidth: m.Session?.bandwidth, // kbps
    };
  });

  const recentlyAdded = (recent?.MediaContainer?.Metadata || []).map(m => ({
    id: m.ratingKey,
    type: m.type,
    title: m.type === 'episode' ? m.grandparentTitle : m.type === 'season' ? m.parentTitle : m.title,
    sub: m.type === 'episode' ? `S${pad(m.parentIndex)}E${pad(m.index)} · ${m.title}` : m.type === 'season' ? m.title : m.type === 'album' ? m.parentTitle : m.year ? String(m.year) : '',
    thumb: m.type === 'episode' ? m.grandparentThumb : m.type === 'season' ? m.parentThumb || m.thumb : m.thumb,
    addedAt: (m.addedAt || 0) * 1000,
    library: m.librarySectionTitle,
  }));
  return {
    version: identity.MediaContainer?.version, latency,
    data: {
      streams, libraries, recentlyAdded,
      resources: res ? { hostCpu: res.hostCpuUtilization, plexCpu: res.processCpuUtilization, hostMem: res.hostMemoryUtilization, plexMem: res.processMemoryUtilization } : null,
    },
  };
}

// ---------------------------------------------------------------- Tautulli
async function tautulli(cfg) {
  const api = (cmd, extra = '') =>
    req(join(cfg.url, `/api/v2?apikey=${encodeURIComponent(cfg.apiKey)}&cmd=${cmd}${extra}`)).then(r => {
      if (r.response?.result !== 'success') throw new Error(r.response?.message || 'Tautulli error');
      return r.response.data;
    });
  const [info, latency] = await timed(() => api('get_tautulli_info'));
  const [home, byDate, logs] = await Promise.all([
    cached(`taut-home:${cfg.url}`, 5 * 60e3, () => api('get_home_stats', '&time_range=30&stats_count=5')),
    cached(`taut-plays:${cfg.url}`, 5 * 60e3, () => api('get_plays_by_date', '&time_range=30')),
    cached(`logs:${cfg.url}`, 60e3, () => api('get_logs', '&regex=WARNING|ERROR&end=500').catch(() => [])),
  ]);
  const events = (Array.isArray(logs) ? logs : logs.data || [])
    .filter(l => normLevel(l.loglevel))
    .slice(-50)
    .map(l => ({ time: String(l.time).replace(' ', 'T'), level: normLevel(l.loglevel), source: l.thread, message: l.msg }));
  const stat = id => home.find(s => s.stat_id === id)?.rows || [];
  return {
    version: info.tautulli_version,
    latency,
    data: {
      topUsers: stat('top_users').map(r => ({ name: r.friendly_name, plays: r.total_plays, duration: r.total_duration })),
      topShows: stat('top_tv').map(r => ({ name: r.grandparent_title || r.title, plays: r.total_plays })),
      topMovies: stat('top_movies').map(r => ({ name: r.title, plays: r.total_plays })),
      topPlatforms: stat('top_platforms').map(r => ({ name: r.platform, plays: r.total_plays })),
      mostConcurrent: stat('most_concurrent')[0]?.count ?? null,
      events,
      playsByDate: {
        dates: byDate.categories,
        series: byDate.series.map(s => ({ name: s.name, data: s.data })),
      },
    },
  };
}

// ---------------------------------------------------------------- Sonarr
async function sonarr(cfg) {
  const api = arrApi(cfg, 'v3');
  const [status, latency] = await timed(() => api('/system/status'));
  const now = Date.now();
  const [series, queue, missing, health, disks, cal, logs, imports] = await Promise.all([
    api('/series'),
    api('/queue?pageSize=100&includeSeries=true&includeEpisode=true'),
    api('/wanted/missing?pageSize=1&monitored=true'),
    api('/health'),
    api('/diskspace'),
    api(`/calendar?start=${isoDate(now - DAY)}&end=${isoDate(now + 8 * DAY)}&includeSeries=true`),
    arrLogs(cfg, api),
    arrImports(cfg, api, 'includeSeries=true&includeEpisode=true', x =>
      x.series ? `${x.series.title} S${pad(x.episode?.seasonNumber)}E${pad(x.episode?.episodeNumber)}` : x.sourceTitle),
  ]);
  const st = s => s.statistics || {};
  const q = mapQueue(queue, r =>
    r.series ? `${r.series.title} S${pad(r.episode?.seasonNumber)}E${pad(r.episode?.episodeNumber)}` : null
  );
  return {
    version: status.version,
    latency,
    data: {
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
    api('/movie'),
    api('/queue?pageSize=100&includeMovie=true'),
    api('/health'),
    api('/diskspace'),
    api(`/calendar?start=${isoDate(now - DAY)}&end=${isoDate(now + 30 * DAY)}`),
    arrLogs(cfg, api),
    arrImports(cfg, api, 'includeMovie=true', x => (x.movie ? `${x.movie.title} (${x.movie.year})` : x.sourceTitle)),
  ]);
  const releaseDate = m => m.digitalRelease || m.physicalRelease || m.inCinemas;
  const q = mapQueue(queue, r => (r.movie ? `${r.movie.title} (${r.movie.year})` : null));
  return {
    version: status.version,
    latency,
    data: {
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
    api('/artist'),
    api('/queue?pageSize=100&includeArtist=true&includeAlbum=true'),
    api('/wanted/missing?pageSize=1'),
    api('/health'),
    api('/diskspace'),
    api(`/calendar?start=${isoDate(now - DAY)}&end=${isoDate(now + 30 * DAY)}&includeArtist=true`),
    arrLogs(cfg, api),
  ]);
  const st = a => a.statistics || {};
  const q = mapQueue(queue, r => (r.artist && r.album ? `${r.artist.artistName} — ${r.album.title}` : null));
  return {
    version: status.version,
    latency,
    data: {
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
    api('/author'),
    api('/queue?pageSize=100&includeAuthor=true&includeBook=true'),
    api('/wanted/missing?pageSize=1'),
    api('/health'),
    api('/diskspace'),
    arrLogs(cfg, api),
  ]);
  const st = a => a.statistics || {};
  const q = mapQueue(queue, r => (r.author && r.book ? `${r.author.authorName} — ${r.book.title}` : null));
  return {
    version: status.version,
    latency,
    data: {
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
    api('/indexer'),
    api('/indexerstatus'),
    api('/health'),
    cached(`prowlarr-stats:${cfg.url}`, 5 * 60e3, () => api('/indexerstats').catch(() => null)),
    arrLogs(cfg, api),
  ]);
  const idx = stats?.indexers || [];
  return {
    version: status.version,
    latency,
    data: {
      stats: {
        indexers: indexers.length,
        enabled: indexers.filter(i => i.enable).length,
        failing: statuses.filter(s => s.disabledTill && new Date(s.disabledTill) > new Date()).length,
        queries: sum(idx, i => i.numberOfQueries),
        grabs: sum(idx, i => i.numberOfGrabs),
        avgResponseMs: idx.length ? Math.round(sum(idx, i => i.averageResponseTime) / idx.length) : null,
      },
      health: mapHealth(health),
      events: logs,
    },
  };
}

// ---------------------------------------------------------------- Bazarr
async function bazarr(cfg) {
  const headers = { 'X-API-KEY': cfg.apiKey };
  const api = p => req(join(cfg.url, p), { headers });
  const [status, latency] = await timed(() => api('/api/system/status'));
  const badges = await api('/api/badges');
  return {
    version: status.data?.bazarr_version,
    latency,
    data: {
      stats: {
        missingEpisodeSubs: badges.episodes ?? 0,
        missingMovieSubs: badges.movies ?? 0,
        providerIssues: badges.providers ?? 0,
      },
    },
  };
}

// ---------------------------------------------------------------- Seerr / Overseerr / Jellyseerr (same API)
async function overseerr(cfg) {
  const headers = { 'X-Api-Key': cfg.apiKey };
  const api = p => req(join(cfg.url, `/api/v1${p}`), { headers });
  const [status, latency] = await timed(() => api('/status'));
  const [counts, logs, pending] = await Promise.all([
    api('/request/count'),
    // Needs an admin API key (the one under Settings → General is).
    cached(`logs:${cfg.url}`, 60e3, () => api('/settings/logs?take=50&filter=warn').catch(() => [])),
    api('/request?take=10&skip=0&filter=pending&sort=added').catch(() => null),
  ]);
  // Request lists only carry TMDB ids; look titles up once a day each.
  const requests = await Promise.all((pending?.results || []).map(async r => {
    const tv = r.type === 'tv';
    const m = await cached(`seerr-title:${cfg.url}:${r.type}:${r.media?.tmdbId}`, DAY, () =>
      api(`/${tv ? 'tv' : 'movie'}/${r.media?.tmdbId}`).catch(() => null));
    const date = tv ? m?.firstAirDate : m?.releaseDate;
    return {
      id: r.id, type: r.type, is4k: !!r.is4k, createdAt: r.createdAt,
      title: (tv ? m?.name : m?.title) || `TMDB ${r.media?.tmdbId}`,
      year: date ? date.slice(0, 4) : null,
      seasons: tv ? (r.seasons || []).map(x => x.seasonNumber) : null,
      requestedBy: r.requestedBy?.displayName || r.requestedBy?.username || 'someone',
    };
  }));
  const events = (Array.isArray(logs) ? logs : logs.results || [])
    .filter(l => normLevel(l.level))
    .map(l => ({ time: l.timestamp, level: normLevel(l.level), source: l.label, message: l.message, detail: l.data ? JSON.stringify(l.data, null, 2) : null }));
  return { version: status.version, latency, data: { stats: counts, events, requests } };
}

// ---------------------------------------------------------------- SABnzbd
async function sabnzbd(cfg) {
  const api = mode => req(join(cfg.url, `/api?mode=${mode}&output=json&apikey=${encodeURIComponent(cfg.apiKey)}`));
  const [q, latency] = await timed(() => api('queue'));
  const [totals, warnings, failed] = await Promise.all([
    cached(`sab-stats:${cfg.url}`, 60e3, () => api('server_stats').catch(() => null)),
    cached(`sab-warn:${cfg.url}`, 60e3, () => api('warnings').catch(() => null)),
    cached(`sab-failed:${cfg.url}`, 60e3, () => api('history&failed_only=1&limit=15').catch(() => null)),
  ]);
  const queue = q.queue;
  const events = [
    // SAB 4.x returns {text,type,time}; 3.x returned "timestamp\nLEVEL\nmessage" strings.
    ...(warnings?.warnings || []).map(w => {
      if (typeof w === 'string') {
        const [time, type, ...msg] = w.split('\n');
        return { time: time.replace(',', '.').replace(' ', 'T'), level: normLevel(type) || 'warn', source: 'Warnings', message: msg.join(' ') };
      }
      return { time: w.time * 1000, level: normLevel(w.type) || 'warn', source: 'Warnings', message: w.text };
    }),
    ...(failed?.history?.slots || []).map(h => ({
      time: h.completed * 1000,
      level: 'error',
      source: 'Failed download',
      message: `${h.name}: ${h.fail_message || 'failed'}`,
      detail: [h.category && `Category: ${h.category}`, h.storage && `Path: ${h.storage}`].filter(Boolean).join('\n') || null,
    })),
  ];
  return {
    version: queue.version,
    latency,
    data: {
      client: 'usenet',
      paused: queue.paused,
      status: queue.status,
      downBps: Number(queue.kbpersec || 0) * 1024,
      upBps: 0,
      items: (queue.slots || []).map(s => ({
        title: s.filename,
        progress: Number(s.percentage || 0) / 100,
        size: Number(s.mb || 0) * 1048576,
        eta: s.timeleft,
        status: s.status,
      })),
      totals: totals && { day: totals.day, week: totals.week, month: totals.month, all: totals.total },
      events,
    },
  };
}

// ---------------------------------------------------------------- qBittorrent
// qBittorrent Web API v2 uses a cookie session. Login is skipped when no username is set
// (its "bypass auth for LAN" option); the SID is cached per server and renewed on 401/403.
const qbitSid = new Map();
async function qbittorrent(cfg) {
  const login = async () => {
    if (!cfg.username) return null;
    const res = await req(join(cfg.url, '/api/v2/auth/login'), {
      method: 'POST',
      as: 'response',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: cfg.url },
      body: new URLSearchParams({ username: cfg.username, password: cfg.password || '' }),
    });
    const sid = /SID=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
    if (!sid) throw new Error('qBittorrent login failed');
    qbitSid.set(cfg.url, sid);
    return sid;
  };
  const call = async (p, as = 'json') => {
    const doCall = sid =>
      req(join(cfg.url, p), { as, headers: { Referer: cfg.url, ...(sid ? { Cookie: `SID=${sid}` } : {}) } });
    try {
      return await doCall(qbitSid.get(cfg.url) ?? (await login()));
    } catch (e) {
      if (!/HTTP 40[13]/.test(e.message) || !cfg.username) throw e;
      return doCall(await login());
    }
  };
  const [version, latency] = await timed(() => call('/api/v2/app/version', 'text'));
  const main = await call('/api/v2/sync/maindata?rid=0');
  const s = main.server_state || {};
  const torrents = Object.values(main.torrents || {});
  const states = {};
  for (const t of torrents) states[t.state] = (states[t.state] || 0) + 1;
  return {
    version,
    latency,
    data: {
      client: 'torrent',
      downBps: s.dl_info_speed || 0,
      upBps: s.up_info_speed || 0,
      ratio: Number(s.global_ratio) || null,
      allTimeDown: s.alltime_dl,
      allTimeUp: s.alltime_ul,
      freeSpace: s.free_space_on_disk,
      torrents: torrents.length,
      states,
      items: torrents
        .filter(t => t.progress < 1)
        .sort((a, b) => b.dlspeed - a.dlspeed)
        .slice(0, 25)
        .map(t => ({ title: t.name, progress: t.progress, size: t.size, eta: t.eta, status: t.state, speed: t.dlspeed })),
    },
  };
}

// ---------------------------------------------------------------- Clonarr (TRaSH-Guides sync)
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
  for (const r of rules.filter(r => r.orphaned))
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

// ---------------------------------------------------------------- Unraid (official GraphQL API)
// Unraid 7.2+ (or the Unraid Connect plugin): POST /graphql with an API key from
// Settings → Management Access → API Keys. A read-only "viewer" key is enough.
const UNRAID_QUERY = `query MediaOps {
  vars { version name }
  array {
    state
    capacity { kilobytes { free used total } }
    parityCheckStatus { status progress errors running paused speed date duration correcting }
    parities { name status temp numErrors warning critical isSpinning size rotational }
    disks { name status temp numErrors warning critical isSpinning size fsSize fsFree fsUsed rotational }
    caches { name status temp numErrors warning critical isSpinning size fsSize fsFree fsUsed rotational }
  }
}`;
const DISK_PROBLEM = {
  DISK_DSBL: 'is disabled', DISK_NP_DSBL: 'is disabled and missing', DISK_NP_MISSING: 'is missing',
  DISK_INVALID: 'is invalid', DISK_WRONG: 'is the wrong disk', DISK_DSBL_NEW: 'is disabled (new disk)',
};
async function unraid(cfg) {
  const [r, latency] = await timed(() => req(join(cfg.url, '/graphql'), {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: UNRAID_QUERY }),
  }));
  if (!r.data?.array) throw new Error(r.errors?.[0]?.message || 'Unraid API returned no array data');
  const a = r.data.array;
  const kb = v => Number(v || 0) * 1024;
  // Sizes are in KiB. `warning`/`critical` are Unraid's disk-*utilization* thresholds (% full);
  // the API has no temperature thresholds, so use Unraid's defaults: 45/55 °C for hard
  // drives, 60/70 °C for SSDs (which run hotter).
  const disk = role => d => {
    const ssd = d.rotational === false;
    return {
      name: d.name, role, status: d.status, temp: Number.isFinite(d.temp) ? d.temp : null,
      tempWarn: ssd ? 60 : 45, tempCrit: ssd ? 70 : 55,
      fullWarn: d.warning || null, fullCrit: d.critical || null,
      errors: Number(d.numErrors || 0), spinning: d.isSpinning, ssd,
      size: d.fsSize != null ? kb(d.fsSize) : kb(d.size), used: d.fsUsed != null ? kb(d.fsUsed) : null,
    };
  };
  const disks = [...(a.parities || []).map(disk('parity')), ...(a.disks || []).map(disk('data')), ...(a.caches || []).map(disk('cache'))];

  // Problems become errors-feed events (and notifications). Messages stay stable so a
  // fluctuating temperature doesn't look like a new problem every poll.
  const events = [];
  const ev = (level, message, detail) => events.push({ time: new Date().toISOString(), level, source: 'Array', message, detail: detail || null, live: true });
  if (a.state !== 'STARTED') ev('error', `Array is not started (${a.state.toLowerCase().replace(/_/g, ' ')})`);
  for (const d of disks) {
    if (DISK_PROBLEM[d.status]) ev('error', `Disk ${d.name} ${DISK_PROBLEM[d.status]}`);
    if (d.temp != null && d.temp >= d.tempCrit) ev('error', `Disk ${d.name} is critically hot`, `${d.temp} °C (critical at ${d.tempCrit} °C)`);
    else if (d.temp != null && d.temp >= d.tempWarn) ev('warn', `Disk ${d.name} is running hot`, `${d.temp} °C (warning at ${d.tempWarn} °C)`);
    const pctFull = d.used != null && d.size ? (d.used / d.size) * 100 : null;
    // Only Unraid's *critical* fill level raises an alert: its default warning level (70%) is
    // normal for data disks under high-water allocation and would just be noise.
    if (pctFull != null && d.fullCrit && pctFull >= d.fullCrit) ev('error', `Disk ${d.name} is nearly full`, `${pctFull.toFixed(0)}% used (Unraid's critical level is ${d.fullCrit}%)`);
    if (d.errors > 0) ev('warn', `Disk ${d.name} has read/write errors`, `${d.errors} errors since the counters were last reset`);
  }
  const p = a.parityCheckStatus || {};
  if (!p.running && p.status === 'COMPLETED' && p.errors > 0) ev('warn', `Last parity check found ${p.errors} errors`);
  if (p.status === 'FAILED') ev('error', 'Last parity check failed');

  return {
    version: r.data.vars?.version || null,
    latency,
    data: {
      server: r.data.vars?.name || null,
      state: a.state,
      capacity: { total: kb(a.capacity?.kilobytes?.total), used: kb(a.capacity?.kilobytes?.used), free: kb(a.capacity?.kilobytes?.free) },
      parity: { status: p.status, running: !!p.running, paused: !!p.paused, progress: p.progress ?? null, errors: p.errors ?? 0, speed: p.speed || null, date: p.date || null, duration: p.duration ?? null, correcting: !!p.correcting },
      disks,
      events,
    },
  };
}

// ---------------------------------------------------------------- Generic HTTP ping
async function ping(cfg) {
  const [res, latency] = await timed(() => req(cfg.url, { as: 'response', timeout: 5000 }));
  // Any non-5xx answer (incl. 401 / redirect to login) means the service is alive.
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  return { version: null, latency, data: { status: res.status } };
}

module.exports = {
  plex, tautulli, sonarr, radarr, lidarr, readarr, prowlarr, bazarr,
  overseerr, jellyseerr: overseerr, seerr: overseerr, sabnzbd, qbittorrent, clonarr, unraid, ping,
};
