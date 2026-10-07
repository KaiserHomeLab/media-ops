// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Tautulli: watch statistics, plays per day, its log, and when each title was last watched
// (for "What's using space").
'use strict';
const { join, req, timed, cached, background } = require('../http');
const { normLevel, UPDATE_TTL } = require('./shared');

async function tautulli(cfg) {
  const api = (cmd, extra = '', timeout) =>
    req(join(cfg.url, `/api/v2?apikey=${encodeURIComponent(cfg.apiKey)}&cmd=${cmd}${extra}`), { timeout }).then(r => {
      if (r.response?.result !== 'success') throw new Error(r.response?.message || 'Tautulli error');
      return r.response.data;
    });
  const [info, latency] = await timed(() => api('get_tautulli_info'));
  const [home, byDate, logs] = await Promise.all([
    cached(`taut-home:${cfg.url}`, 5 * 60e3, () => api('get_home_stats', '&time_range=30&stats_count=5')),
    cached(`taut-plays:${cfg.url}`, 5 * 60e3, () => api('get_plays_by_date', '&time_range=30')),
    cached(`logs:${cfg.url}`, 60e3, () => api('get_logs', '&regex=WARNING|ERROR&end=500').catch(() => [])),
  ]);
  const [update, watch] = await Promise.all([
    background(`update:${cfg.url}`, UPDATE_TTL, () =>
      api('update_check').then(d => (d?.update ? { version: d.latest_version || d.latest_release || null } : null)),
    ),
    tautulliWatch(cfg, api),
  ]);
  const events = (Array.isArray(logs) ? logs : logs.data || [])
    .filter(l => normLevel(l.loglevel))
    .slice(-50)
    .map(l => ({
      time: String(l.time).replace(' ', 'T'),
      level: normLevel(l.loglevel),
      source: l.thread,
      message: l.msg,
    }));
  const stat = id => home.find(s => s.stat_id === id)?.rows || [];
  return {
    version: info.tautulli_version,
    latency,
    data: {
      update,
      _watch: watch,
      topUsers: stat('top_users').map(r => ({
        name: r.friendly_name,
        plays: r.total_plays,
        duration: r.total_duration,
      })),
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

// When each movie and show was last watched, for "What's using space" (hourly; server-side
// only). Tautulli groups shows by series, so a show counts as watched if any episode was.
// `since` is the oldest play Tautulli knows about: nothing before it can be judged.
function tautulliWatch(cfg, api) {
  return background(`taut-watch:${cfg.url}`, 60 * 60e3, async () => {
    const libs = await api('get_libraries').catch(() => []);
    const sections = (Array.isArray(libs) ? libs : []).filter(l => ['movie', 'show'].includes(l.section_type));
    const lists = await Promise.all(
      sections.map(l =>
        api('get_library_media_info', `&section_id=${l.section_id}&length=100000`, 30000)
          .then(r =>
            (r?.data || []).map(m => ({
              type: l.section_type,
              title: m.title,
              year: Number(m.year) || null,
              lastPlayed: m.last_played ? Number(m.last_played) * 1000 : null,
              plays: Number(m.play_count) || 0,
            })),
          )
          .catch(() => []),
      ),
    );
    const first = await api('get_history', '&length=1&order_column=date&order_dir=asc').catch(() => null);
    const since = Number(first?.data?.[0]?.date) * 1000 || null;
    return { items: lists.flat(), since };
  });
}

module.exports = { tautulli };
