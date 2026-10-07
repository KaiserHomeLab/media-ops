// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// "What's using space": built once per poll from the arrs' per-title sizes and Tautulli's watch
// history (the underscore fields the collectors return, which never reach the browser).
//   biggest     the largest series, movies and artists
//   downloaded  what was imported in the last 30 days, per title (includes upgrades)
//   cleanup     movies and shows nobody has watched for `cleanupDays` (default a year), that
//               were added before that too. Only titles Tautulli can match are listed, so a
//               title missing from Plex is never called "unwatched".
// It only lists things. Nothing is ever deleted.
'use strict';

const DAY = 864e5;
const PATHS = { series: 'series', movie: 'movie', artist: 'artist' };
const norm = t =>
  String(t || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');

function build(results, cfg, now = Date.now()) {
  const days = Number(cfg.cleanupDays) || 365;
  const byId = new Map(cfg.services.map(s => [s.id, s]));
  const items = [];
  const downloaded = [];
  let loading = false; // import history is fetched in the background; null until the first fetch
  for (const r of results) {
    if (!r.up || !r.data?._library) continue;
    const svc = byId.get(r.id);
    const base = String(svc?.link || svc?.url || '').replace(/\/+$/, '');
    const own = new Map();
    for (const it of r.data._library) {
      const item = {
        app: r.name,
        kind: it.kind,
        title: it.title,
        year: it.year,
        size: it.size || 0,
        added: it.added ? new Date(it.added).getTime() : null,
        link: base && it.slug ? `${base}/${PATHS[it.kind]}/${encodeURIComponent(it.slug)}` : null,
      };
      own.set(it.id, item);
      items.push(item);
    }
    if (r.data._downloaded30 === null) loading = true;
    for (const d of r.data._downloaded30 || []) {
      const it = own.get(d.id);
      if (it && d.bytes > 0) downloaded.push({ ...strip(it), bytes: d.bytes, count: d.count });
    }
  }

  const biggest = items
    .filter(i => i.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, 12)
    .map(strip);
  downloaded.sort((a, b) => b.bytes - a.bytes);

  // Cleanup needs Tautulli.
  const taut = results.find(r => r.kind === 'tautulli' && r.up && r.data?._watch);
  let cleanup = null;
  if (taut) {
    const { items: watched, since } = taut.data._watch;
    const exact = new Map(),
      loose = new Map();
    for (const w of watched) {
      const type = w.type === 'show' ? 'series' : 'movie';
      exact.set(`${type}:${norm(w.title)}:${w.year}`, w);
      const k = `${type}:${norm(w.title)}`;
      loose.set(k, loose.has(k) ? null : w); // null = ambiguous (remakes etc.), don't guess
    }
    const cutoff = now - days * DAY;
    const list = [];
    for (const it of items) {
      if (it.kind === 'artist' || it.size <= 0 || !it.added || it.added > cutoff) continue;
      const w = exact.get(`${it.kind}:${norm(it.title)}:${it.year}`) ?? loose.get(`${it.kind}:${norm(it.title)}`);
      if (!w) continue;
      if (w.lastPlayed && w.lastPlayed > cutoff) continue;
      list.push({ ...strip(it), lastPlayed: w.lastPlayed, plays: w.plays });
    }
    list.sort((a, b) => b.size - a.size);
    cleanup = {
      days,
      historyDays: since ? Math.floor((now - since) / DAY) : null,
      total: list.reduce((n, x) => n + x.size, 0),
      count: list.length,
      items: list.slice(0, 15),
    };
  }

  return {
    biggest,
    downloaded: { total: downloaded.reduce((n, x) => n + x.bytes, 0), items: downloaded.slice(0, 10), loading },
    cleanup,
    tautulli: results.some(r => r.kind === 'tautulli' && r.up), // connected, even if history is still loading
  };
}

const strip = ({ app, kind, title, year, size, added, link }) => ({ app, kind, title, year, size, added, link });

// The per-title lists are only for build(); drop them so they aren't sent to the browser.
function stripPrivate(results) {
  for (const r of results) if (r.data) for (const k of Object.keys(r.data)) if (k.startsWith('_')) delete r.data[k];
}

module.exports = { build, stripPrivate };
