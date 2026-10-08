// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The top numbers row (KPIs), the services grid and the library card.
import { $, ago, answered, bytes, esc, list, mbps, n0, num, rate, safeHref, setHTML, store, sum } from './util.js';

/** @param {string} label @param {string} value @param {string} [foot] */
function kpi(label, value, foot = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
}

/** @param {Overview} d @param {{ streams: any[], arrs: Answered[], clients: Answered[] }} parts */
export function renderKpis(d, { streams, arrs, clients }) {
  const tc = streams.filter(s => s.decision.startsWith('Transcode')).length;
  const paused = streams.filter(s => s.state === 'paused').length;
  const wan = sum(
    streams.filter(s => !s.local),
    s => s.bandwidth,
  );
  const lan = sum(
    streams.filter(s => s.local),
    s => s.bandwidth,
  );
  const upCount = d.services.filter(s => s.up).length;
  const down = d.services.filter(s => !s.up).map(s => s.name);
  // Totals across every instance of a kind (e.g. Sonarr + Sonarr Anime).
  /** @param {string} kind @param {string} key */
  const tot = (kind, key) => {
    const ofKind = arrs.filter(a => a.kind === kind);
    return ofKind.length ? sum(ofKind, a => a.data.stats[key]) : null;
  };
  const size = sum(arrs, a => a.data.stats.size);
  const missing = sum(arrs, a => a.data.stats.missing);
  const queueLen = sum(arrs, a => a.data.queue.length);

  const parts = [
    tot('radarr', 'onDisk') != null && `${num(tot('radarr', 'onDisk'))} movies`,
    tot('sonarr', 'episodes') != null && `${num(tot('sonarr', 'episodes'))} eps`,
    tot('lidarr', 'tracks') != null && `${num(tot('lidarr', 'tracks'))} tracks`,
  ].filter(Boolean);
  const missParts = [
    tot('sonarr', 'missing') != null && `${num(tot('sonarr', 'missing'))} eps`,
    tot('radarr', 'missing') != null && `${num(tot('radarr', 'missing'))} movies`,
    tot('lidarr', 'missing') != null && `${num(tot('lidarr', 'missing'))} albums`,
  ].filter(Boolean);

  setHTML(
    $('kpis'),
    [
      kpi(
        'Streaming now',
        `${streams.length}`,
        streams.length ? `${tc} transcoding · ${paused} paused` : 'nobody watching',
      ),
      kpi(
        'Stream bandwidth',
        mbps(wan + lan).replace(' Mbps', '<small>Mbps</small>'),
        d.uploadMbps
          ? (() => {
              const pct = Math.round((wan / 1000 / d.uploadMbps) * 100);
              return `<span class="${pct >= 85 ? 'hot' : ''}">${pct >= 85 ? '⚠ ' : ''}WAN ${(wan / 1000).toFixed(1)} of ${d.uploadMbps} Mbps upload (${pct}%)</span>`;
            })()
          : `WAN ${mbps(wan)} · LAN ${mbps(lan)}`,
      ),
      kpi(
        'Services up',
        `${upCount}<small>/ ${d.services.length}</small>`,
        down.length ? `down: ${esc(down.join(', '))}` : 'all green',
      ),
      kpi('Library on disk', size ? bytes(size, 1).replace(/ (\w+)$/, '<small>$1</small>') : '—', parts.join(' · ')),
      kpi(
        'Downloading',
        clients.length ? rate(sum(clients, c => c.data.downBps)).replace(/ (.+)$/, '<small>$1</small>') : '—',
        `↑ ${rate(sum(clients, c => c.data.upBps))} · ${queueLen} queued`,
      ),
      kpi('Wanted / missing', num(missing), missParts.join(' · ')),
      (() => {
        const recent = d.events.filter(e => !e.dismissed && Date.now() - e.t < 864e5);
        const errs = recent.filter(e => e.level === 'error').length;
        return kpi('Errors · 24h', `${errs}`, `${recent.length - errs} warnings`);
      })(),
    ].join(''),
  );
}

/** @param {ServiceState[]} services */
export function renderServices(services) {
  const up = services.filter(s => s.up).length;
  const updates = services.filter(s => s.up && s.data?.update).length;
  $('svc-count').textContent =
    `${up}/${services.length} up${updates ? ` · ${updates} update${updates === 1 ? '' : 's'}` : ''}`;
  setHTML(
    $('services'),
    services
      .map(s => {
        const meta = s.up
          ? [s.version && esc(`v${String(s.version).replace(/^v/, '')}`), s.latency != null && `${n0(s.latency)}ms`]
              .filter(Boolean)
              .join(' · ')
          : esc(s.error);
        const slow = s.up && (s.latency ?? 0) > 1500;
        /** @type {{ cells: (number | null)[], day: number | null, week: number | null } | undefined} */
        const u = store.hist?.uptime?.[s.id];
        /** @param {number | null} v */
        const pct = v => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.9995 ? 0 : 1)}%`);
        // 24 h in half-hour cells; the % next to it carries the meaning, color only reinforces it.
        const bar =
          u && u.cells.some(c => c != null)
            ? `<span class="uprow"><span class="upbar" aria-hidden="true">${u.cells
                .map(c => `<i class="${c == null ? 'none' : c >= 0.999 ? 'ok' : c > 0 ? 'part' : 'bad'}"></i>`)
                .join(
                  '',
                )}</span><span class="uppct" aria-label="Uptime ${pct(u.day)} over 24 hours">${pct(u.day)}</span></span>`
            : '';
        const title = `${s.up ? `${s.name} is up` : s.error}${u ? ` · uptime ${pct(u.day)} (24 h), ${pct(u.week)} (7 days)` : ''}`;
        return `<a class="svc ${s.up ? '' : 'down'}" href="${safeHref(s.link)}" target="_blank" rel="noopener" title="${esc(title)}">
      <span class="dot ${!s.up ? 'down' : slow ? 'warn' : 'up'}" aria-label="${s.up ? 'up' : 'down'}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="meta">${s.up ? '' : '✕ '}${meta}</span>
      ${s.up && s.data?.update ? `<span class="upd-badge" title="${esc(s.data.update.version ? `Version ${s.data.update.version} is available` : 'A newer version is available')}">⬆ update</span>` : ''}
      ${bar}
    </a>`;
      })
      .join(''),
  );
}

/** @param {Answered[]} media @param {ServiceState[]} services */
export function renderLibrary(media, services) {
  // With more than one media server, each library says which one it's on.
  const libs = media.flatMap(m =>
    list(m.data.libraries).map(l => ({ ...l, title: media.length > 1 ? `${l.title} · ${m.name}` : l.title })),
  );
  /** @type {Record<string, string>} */
  const icon = { movie: '🎬', show: '📺', artist: '🎵', photo: '📷' };
  /** @type {Record<string, string>} */
  const UNIT = { movie: 'movies', show: 'shows', artist: 'artists', photo: 'items' };
  setHTML(
    $('libraries'),
    libs
      .map(l => {
        const unit = UNIT[l.type] || 'items';
        const extra =
          l.type === 'show'
            ? `${num(l.episodes)} episodes`
            : l.type === 'artist'
              ? `${num(l.albums)} albums · ${num(l.tracks)} tracks`
              : '';
        return `<div class="lib"><div class="k">${icon[l.type] || '📁'} ${esc(l.title)}</div><div class="n">${num(l.count)}</div><div class="x">${unit}${extra ? ' · ' + extra : ''}</div></div>`;
      })
      .join('') || (media.length ? '' : '<div class="empty">No media server (Plex, Jellyfin or Emby) connected.</div>'),
  );

  /** @type {Record<string, (s: any) => [string, string, boolean?][]>} */
  const rows = {
    sonarr: s => [
      ['Series', num(s.series)],
      ['Continuing', num(s.continuing)],
      ['Episodes on disk', num(s.episodes)],
      ['Missing (monitored)', num(s.missing), s.missing > 0],
      ['Size', bytes(s.size)],
    ],
    radarr: s => [
      ['Movies', num(s.movies)],
      ['On disk', num(s.onDisk)],
      ['Monitored', num(s.monitored)],
      ['Missing (available)', num(s.missing), s.missing > 0],
      ['Size', bytes(s.size)],
    ],
    lidarr: s => [
      ['Artists', num(s.artists)],
      ['Albums', num(s.albums)],
      ['Tracks on disk', num(s.tracks)],
      ['Missing albums', num(s.missing), s.missing > 0],
      ['Size', bytes(s.size)],
    ],
    readarr: s => [
      ['Authors', num(s.authors)],
      ['Books on disk', num(s.books)],
      ['Missing', num(s.missing), s.missing > 0],
      ['Size', bytes(s.size)],
    ],
    prowlarr: s => [
      ['Indexers', `${num(s.enabled)} / ${num(s.indexers)}`],
      ['Failing', num(s.failing), s.failing > 0],
      ['Queries', num(s.queries)],
      ['Grabs', num(s.grabs)],
      ['Avg response', s.avgResponseMs != null ? `${s.avgResponseMs} ms` : '—'],
    ],
    bazarr: s => [
      ['Episodes missing subs', num(s.missingEpisodeSubs), s.missingEpisodeSubs > 0],
      ['Movies missing subs', num(s.missingMovieSubs), s.missingMovieSubs > 0],
      ['Provider issues', num(s.providerIssues), s.providerIssues > 0],
    ],
    overseerr: s => [
      ['Pending approval', num(s.pending), s.pending > 0],
      ['Processing', num(s.processing)],
      ['Available', num(s.available)],
      ['Total requests', num(s.total)],
      ['Movies / TV', `${num(s.movie)} / ${num(s.tv)}`],
    ],
  };
  rows.jellyseerr = rows.seerr = rows.overseerr;
  rows.clonarr = s => [
    ['Arr instances', num(s.instances)],
    ['Sync profiles', `${num(s.active)} / ${num(s.profiles)} active`],
    ['Profiles with errors', num(s.withErrors), s.withErrors > 0],
    ['Auto-sync', s.paused ? 'paused' : 'on', s.paused],
    ['Last TRaSH pull', s.lastPull ? ago(new Date(s.lastPull).getTime()) : '—'],
    ['Last sync', s.lastSync ? ago(new Date(s.lastSync).getTime()) : '—'],
  ];

  setHTML(
    $('arr-stats'),
    services
      .filter(answered)
      .filter(s => rows[s.kind] && s.data.stats)
      .map(s => {
        const kv = rows[s.kind](s.data.stats)
          .map(([k, v, bad]) => `<dt>${k}</dt><dd class="${bad ? 'bad' : ''}">${esc(v)}</dd>`)
          .join('');
        return `<div class="arr"><h3>${esc(s.name)}<span>${s.data.queue ? `${s.data.queue.length} in queue` : ''}</span></h3><dl class="kv">${kv}</dl></div>`;
      })
      .join(''),
  );
}
