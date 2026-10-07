// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Dashboard page. Polls /api/overview every few seconds and redraws each panel.
// Plain browser JavaScript with no build step or framework; markup is built as strings and
// every value from an app is escaped with esc() before it reaches innerHTML.
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = n => (n == null ? '—' : Number(n).toLocaleString());
// Only http(s) links get an href: an address from settings or an app can never be javascript:.
const safeHref = u => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');
const n0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0); // numbers from apps, before they go into HTML
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

function bytes(b, digits = 1) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i < 2 ? 0 : digits)} ${u[i]}`;
}
const rate = bps => `${bytes(bps)}/s`;
const mbps = kbps => (kbps ? `${(kbps / 1000).toFixed(1)} Mbps` : '—');
function clock(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const initials = s => esc((s || '?').replace(/^(the|a)\s+/i, '').slice(0, 2).toUpperCase());

// Only touch the DOM when a section actually changed (prevents image flicker / hover loss).
const lastHTML = new Map();
function setHTML(el, html) {
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}

// --------------------------------------------------------------------- state
let state = null;
let lastOk = 0;
let timer = null;

// Poll loop. The next request is scheduled only after this one finishes, so a slow server never
// piles up requests; switching back to the tab refreshes immediately.
async function refresh() {
  clearTimeout(timer);
  try {
    const r = await fetch('/api/overview', { cache: 'no-store' });
    if (r.status === 401) { location.href = `/settings?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    if (!r.ok) throw new Error(r.status);
    state = await r.json();
    lastOk = Date.now();
    render(state);
  } catch (e) {
    console.warn('refresh failed', e);
  }
  // A hidden tab doesn't poll; coming back to it refreshes at once (visibilitychange below).
  if (!document.hidden) timer = setTimeout(refresh, (state?.refreshSeconds || 10) * 1000);
}

// "Settings aren't password-protected" can be hidden for 30 days (per browser).
const NUDGE_KEY = 'mo-lock-nudge-hidden';
const nudgeHidden = () => { try { return Date.now() - Number(localStorage.getItem(NUDGE_KEY) || 0) < 30 * 864e5; } catch { return false; } };
$('lock-nudge-close').addEventListener('click', () => {
  try { localStorage.setItem(NUDGE_KEY, String(Date.now())); } catch { /* private mode: hide for now only */ }
  $('lock-nudge').hidden = true;
});

// History (uptime, trends, forecasts) changes slowly, so it's fetched once a minute.
let hist = null;
async function loadHistory() {
  try {
    hist = await (await fetch('/api/history', { cache: 'no-store' })).json();
    if (state) render(state);
  } catch { /* keep the last copy */ }
  setTimeout(loadHistory, 60e3);
}

setInterval(() => {
  if (!lastOk) return;
  const ago = Math.round((Date.now() - lastOk) / 1000);
  $('updated').textContent = ago < 2 ? 'live' : `updated ${ago}s ago`;
  $('live').classList.toggle('stale', ago > (state?.refreshSeconds || 10) * 3);
}, 1000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// --------------------------------------------------------------------- render
function render(d) {
  const up = kind => d.services.filter(s => s.kind === kind && s.up);
  const all = kinds => d.services.filter(s => kinds.includes(s.kind) && s.up);
  const arrs = all(['sonarr', 'radarr', 'lidarr', 'readarr']);
  const plex = up('plex')[0];
  const streams = plex?.data.streams || [];
  const clients = all(['sabnzbd', 'qbittorrent']);

  $('demo-badge').hidden = !d.demo;
  $('lock-nudge').hidden = d.demo || d.settingsLocked !== false || nudgeHidden();
  $('self-update').hidden = !d.latestVersion;
  if (d.latestVersion) {
    $('self-update').textContent = `⬆ Media Ops ${d.latestVersion}`;
    $('self-update').title = `You have ${d.version}. Update the container: Unraid Docker tab → Check for Updates, or TrueNAS Apps → Update.`;
  }
  const firstRun = !d.demo && !d.configured;
  $('welcome').hidden = !firstRun;
  $('dash').hidden = firstRun;
  const sys = !d.host.system || d.host.system === 'Linux' ? d.host.platform : d.host.system;
  $('hostline').textContent = `${d.host.hostname} · ${sys} · up ${uptime(d.host.uptime)}`;
  $('hostline').title = d.host.platform || '';

  renderAlerts(d);
  renderKpis(d, { streams, arrs, clients });
  renderStreams(streams, d.demo, plex?.id);
  renderServices(d.services);
  renderMap(plex);
  renderEvents(d);
  renderLibrary(plex, d.services);
  renderDownloads(clients, arrs);
  renderIndexers(up('prowlarr'));
  renderSpace(d.space);
  renderUpcoming(arrs);
  renderWatch(up('tautulli')[0]);
  renderTrends();
  renderUnraid(up('unraid')[0]);
  renderTrueNAS(up('truenas')[0]);
  renderRecent(plex, arrs);
  renderRequests(all(['seerr', 'overseerr', 'jellyseerr']));
  renderDisks(d, arrs);
  renderHost(d.host, d.docker, d.gpus, plex?.data.resources);
}

function renderAlerts(d) {
  const items = d.events.filter(e => e.live && !e.dismissed && e.source !== 'Queue').map(e => ({
    cls: e.level === 'error' ? 'error' : '',
    html: `<b>${esc(e.svc)}</b> ${esc(e.source === 'Connection' ? `is unreachable — ${e.message.replace(/^Unreachable — /, '')}` : e.message)}`,
    key: e.key, svcId: e.svcId,
  }));
  if (Array.isArray(d.docker))
    for (const c of d.docker.filter(c => c.health === 'unhealthy'))
      items.push({ cls: 'error', html: `<b>${esc(c.name)}</b> container is unhealthy` });

  const el = $('alerts');
  el.hidden = !items.length;
  setHTML(el, items.map(a =>
    `<div class="alert ${a.cls}"><span aria-hidden="true">${a.cls === 'error' ? '✕' : '⚠'}</span><div>${a.html}</div>${a.key ? `
      <span class="alert-acts"><button class="icon-btn" type="button" data-recheck="${esc(a.svcId)}" title="Re-check" aria-label="Re-check">↻</button><button class="icon-btn" type="button" data-dismiss="${esc(a.key)}" title="Dismiss" aria-label="Dismiss">✕</button></span>` : ''}</div>`
  ).join(''));
}

function kpi(label, value, foot = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
}

function renderKpis(d, { streams, arrs, clients }) {
  const tc = streams.filter(s => s.decision.startsWith('Transcode')).length;
  const paused = streams.filter(s => s.state === 'paused').length;
  const wan = sum(streams.filter(s => !s.local), s => s.bandwidth);
  const lan = sum(streams.filter(s => s.local), s => s.bandwidth);
  const upCount = d.services.filter(s => s.up).length;
  const down = d.services.filter(s => !s.up).map(s => s.name);
  // Totals across every instance of a kind (e.g. Sonarr + Sonarr Anime).
  const tot = (kind, key) => {
    const list = arrs.filter(a => a.kind === kind);
    return list.length ? sum(list, a => a.data.stats[key]) : null;
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

  setHTML($('kpis'), [
    kpi('Streaming now', `${streams.length}`, streams.length ? `${tc} transcoding · ${paused} paused` : 'nobody watching'),
    kpi('Stream bandwidth', mbps(wan + lan).replace(' Mbps', '<small>Mbps</small>'), d.uploadMbps
      ? (() => {
          const pct = Math.round((wan / 1000 / d.uploadMbps) * 100);
          return `<span class="${pct >= 85 ? 'hot' : ''}">${pct >= 85 ? '⚠ ' : ''}WAN ${(wan / 1000).toFixed(1)} of ${d.uploadMbps} Mbps upload (${pct}%)</span>`;
        })()
      : `WAN ${mbps(wan)} · LAN ${mbps(lan)}`),
    kpi('Services up', `${upCount}<small>/ ${d.services.length}</small>`, down.length ? `down: ${esc(down.join(', '))}` : 'all green'),
    kpi('Library on disk', size ? bytes(size, 1).replace(/ (\w+)$/, '<small>$1</small>') : '—', parts.join(' · ')),
    kpi('Downloading', clients.length ? rate(sum(clients, c => c.data.downBps)).replace(/ (.+)$/, '<small>$1</small>') : '—',
      `↑ ${rate(sum(clients, c => c.data.upBps))} · ${queueLen} queued`),
    kpi('Wanted / missing', num(missing), missParts.join(' · ')),
    (() => {
      const recent = d.events.filter(e => !e.dismissed && Date.now() - e.t < 864e5);
      const errs = recent.filter(e => e.level === 'error').length;
      return kpi('Errors · 24h', `${errs}`, `${recent.length - errs} warnings`);
    })(),
  ].join(''));
}

function renderStreams(streams, demo, plexId) {
  $('np-count').textContent = streams.length ? `${streams.length} active` : '';
  if (!streams.length) return setHTML($('streams'), '<div class="empty">Nothing playing. The server is resting.</div>');

  const html = streams.map(s => {
    const poster = s.thumb && !demo
      ? `<img class="poster" loading="lazy" alt="" src="/api/plex/thumb?p=${encodeURIComponent(s.thumb)}" data-fallback="${initials(s.title)}">`
      : `<div class="poster" aria-hidden="true">${initials(s.title)}</div>`;
    const dc = s.decision.startsWith('Transcode') ? 'tc' : s.decision === 'Direct Play' ? 'dp' : 'ds';
    const chips = [
      `<span class="chip ${dc}"${s.hwName ? ` title="Hardware: ${esc(s.hwName)}"` : ''}>${esc(s.decision)}${s.hw && dc === 'tc' ? ' (HW)' : ''}${s.transcodeSpeed ? ` ${esc(s.transcodeSpeed)}×` : ''}</span>`,
      s.fourKTranscode && '<span class="chip k4" title="4K transcodes are the heaviest load on the server">4K transcode</span>',
      s.resolution && `<span class="chip">${esc(/^\d+$/.test(s.resolution) ? s.resolution + 'p' : s.resolution.toUpperCase())}</span>`,
      s.videoCodec && `<span class="chip">${esc(s.videoCodec.toUpperCase())}</span>`,
      s.audioCodec && `<span class="chip">${esc(s.audioCodec.toUpperCase())}</span>`,
      s.bandwidth && `<span class="chip">${mbps(s.bandwidth)}</span>`,
      `<span class="chip">${s.local ? 'LAN' : 'WAN'}</span>`,
    ].filter(Boolean).join('');
    const pct = s.duration ? Math.min(100, (s.offset / s.duration) * 100) : 0;
    return `<article class="stream ${esc(s.type)}">
      ${poster}
      <div style="min-width:0">
        <div class="row1"><div class="title">${esc(s.title)}</div><span class="state">${s.state === 'paused' ? '❚❚ paused' : s.state === 'buffering' ? '◌ buffering' : '▶ playing'}${s.sessionId && plexId ? `<button class="mini-btn" type="button" data-stop="${esc(s.sessionId)}" data-svc="${esc(plexId)}" data-user="${esc(s.user)}" title="Stop this stream">■ Stop</button>` : ''}</span></div>
        <div class="subtitle">${esc(s.subtitle)}</div>
        <div class="who"><b>${esc(s.user)}</b> on ${esc(s.player || s.product)} · ${esc(s.product)}${s.platform ? ` (${esc(s.platform)})` : ''}</div>
        <div class="chips">${chips}</div>
        ${s.reason ? `<div class="why"><span>Likely reason:</span> ${esc(s.reason)}</div>` : ''}
        <div class="progress"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="t">${clock(s.offset)} / ${clock(s.duration)}</span></div>
      </div>
    </article>`;
  }).join('');
  setHTML($('streams'), html);
  $('streams').querySelectorAll('img[data-fallback]').forEach(img =>
    img.addEventListener('error', () => {
      const div = document.createElement('div');
      div.className = 'poster';
      div.textContent = img.dataset.fallback;
      img.replaceWith(div);
    }, { once: true }));
}

function renderServices(services) {
  const up = services.filter(s => s.up).length;
  const updates = services.filter(s => s.up && s.data?.update).length;
  $('svc-count').textContent = `${up}/${services.length} up${updates ? ` · ${updates} update${updates === 1 ? '' : 's'}` : ''}`;
  setHTML($('services'), services.map(s => {
    const meta = s.up
      ? [s.version && esc(`v${String(s.version).replace(/^v/, '')}`), s.latency != null && `${n0(s.latency)}ms`].filter(Boolean).join(' · ')
      : esc(s.error);
    const slow = s.up && s.latency > 1500;
    const u = hist?.uptime?.[s.id];
    const pct = v => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.9995 ? 0 : 1)}%`);
    // 24 h in half-hour cells; the % next to it carries the meaning, color only reinforces it.
    const bar = u && u.cells.some(c => c != null)
      ? `<span class="uprow"><span class="upbar" aria-hidden="true">${u.cells.map(c =>
          `<i class="${c == null ? 'none' : c >= 0.999 ? 'ok' : c > 0 ? 'part' : 'bad'}"></i>`).join('')}</span><span class="uppct" aria-label="Uptime ${pct(u.day)} over 24 hours">${pct(u.day)}</span></span>`
      : '';
    const title = `${s.up ? `${s.name} is up` : s.error}${u ? ` · uptime ${pct(u.day)} (24 h), ${pct(u.week)} (7 days)` : ''}`;
    return `<a class="svc ${s.up ? '' : 'down'}" href="${safeHref(s.link)}" target="_blank" rel="noopener" title="${esc(title)}">
      <span class="dot ${!s.up ? 'down' : slow ? 'warn' : 'up'}" aria-label="${s.up ? 'up' : 'down'}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="meta">${s.up ? '' : '✕ '}${meta}</span>
      ${s.up && s.data?.update ? `<span class="upd-badge" title="${esc(s.data.update.version ? `Version ${s.data.update.version} is available` : 'A newer version is available')}">⬆ update</span>` : ''}
      ${bar}
    </a>`;
  }).join(''));
}

function renderLibrary(plex, services) {
  const libs = plex?.data.libraries || [];
  const icon = { movie: '🎬', show: '📺', artist: '🎵', photo: '📷' };
  setHTML($('libraries'), libs.map(l => {
    const unit = { movie: 'movies', show: 'shows', artist: 'artists', photo: 'items' }[l.type] || 'items';
    const extra = l.type === 'show' ? `${num(l.episodes)} episodes`
      : l.type === 'artist' ? `${num(l.albums)} albums · ${num(l.tracks)} tracks` : '';
    return `<div class="lib"><div class="k">${icon[l.type] || '📁'} ${esc(l.title)}</div><div class="n">${num(l.count)}</div><div class="x">${unit}${extra ? ' · ' + extra : ''}</div></div>`;
  }).join('') || (plex ? '' : '<div class="empty">Plex not configured or unreachable.</div>'));

  const rows = {
    sonarr: s => [['Series', num(s.series)], ['Continuing', num(s.continuing)], ['Episodes on disk', num(s.episodes)], ['Missing (monitored)', num(s.missing), s.missing > 0], ['Size', bytes(s.size)]],
    radarr: s => [['Movies', num(s.movies)], ['On disk', num(s.onDisk)], ['Monitored', num(s.monitored)], ['Missing (available)', num(s.missing), s.missing > 0], ['Size', bytes(s.size)]],
    lidarr: s => [['Artists', num(s.artists)], ['Albums', num(s.albums)], ['Tracks on disk', num(s.tracks)], ['Missing albums', num(s.missing), s.missing > 0], ['Size', bytes(s.size)]],
    readarr: s => [['Authors', num(s.authors)], ['Books on disk', num(s.books)], ['Missing', num(s.missing), s.missing > 0], ['Size', bytes(s.size)]],
    prowlarr: s => [['Indexers', `${num(s.enabled)} / ${num(s.indexers)}`], ['Failing', num(s.failing), s.failing > 0], ['Queries', num(s.queries)], ['Grabs', num(s.grabs)], ['Avg response', s.avgResponseMs != null ? `${s.avgResponseMs} ms` : '—']],
    bazarr: s => [['Episodes missing subs', num(s.missingEpisodeSubs), s.missingEpisodeSubs > 0], ['Movies missing subs', num(s.missingMovieSubs), s.missingMovieSubs > 0], ['Provider issues', num(s.providerIssues), s.providerIssues > 0]],
    overseerr: s => [['Pending approval', num(s.pending), s.pending > 0], ['Processing', num(s.processing)], ['Available', num(s.available)], ['Total requests', num(s.total)], ['Movies / TV', `${num(s.movie)} / ${num(s.tv)}`]],
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

  setHTML($('arr-stats'), services.filter(s => s.up && rows[s.kind] && s.data?.stats).map(s => {
    const kv = rows[s.kind](s.data.stats).map(([k, v, bad]) => `<dt>${k}</dt><dd class="${bad ? 'bad' : ''}">${esc(v)}</dd>`).join('');
    return `<div class="arr"><h3>${esc(s.name)}<span>${s.data.queue ? `${s.data.queue.length} in queue` : ''}</span></h3><dl class="kv">${kv}</dl></div>`;
  }).join(''));
}

// --------------------------------------------------------------------- stream map
// Remote viewers are placed by city (Plex GeoIP, looked up server-side); LAN viewers sit at
// the home pin. Coastlines are pre-projected in world-map.js with the same projection.
const MAP_GRATICULE = (() => {
  if (!window.MapProjection) return '';
  const { project, LAT_TOP, LAT_BOTTOM } = MapProjection;
  const line = pts => 'M' + pts.map(([lon, lat]) => project(lon, lat).map(v => v.toFixed(1)).join(' ')).join('L');
  let d = '';
  for (let lon = -180; lon <= 180; lon += 30) {
    const pts = [];
    for (let lat = LAT_BOTTOM; lat <= LAT_TOP; lat += 4) pts.push([lon, lat]);
    d += line(pts);
  }
  for (let lat = -30; lat <= 60; lat += 30) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 5) pts.push([lon, lat]);
    d += line(pts);
  }
  return d;
})();

let mapModel = { clusters: [], atHome: [], home: null };
const place = g => [g.city, g.region && g.region !== g.city ? g.region : null, g.code || g.country].filter(Boolean).join(', ');
const streamLine = s => `<b>${esc(s.user)}</b> · ${esc(s.title)}${s.subtitle && s.type !== 'movie' ? ` <span class="muted">${esc(s.subtitle.split(' · ')[0])}</span>` : ''}`;

function renderMap(plex) {
  const show = !!plex && plex.data.mapEnabled !== false && !!window.WORLD_MAP;
  $('map-card').hidden = !show;
  if (!show) return;

  if (rollUp('map-card', !plex.data.streams.length)) {
    $('map-count').textContent = 'nobody watching';
    return;
  }

  const { project } = MapProjection;
  const { width: W, height: H, land } = WORLD_MAP;
  const streams = plex.data.streams;
  const home = plex.data.home;
  const remote = streams.filter(s => !s.local && s.geo);
  const atHome = streams.filter(s => s.local);
  const unknown = streams.filter(s => !s.local && !s.geo);

  // Viewers within a few px of each other (same city) share one numbered dot.
  const clusters = [];
  for (const s of remote) {
    const [x, y] = project(s.geo.lon, s.geo.lat);
    const near = clusters.find(c => Math.hypot(c.x - x, c.y - y) < 12);
    if (near) near.streams.push(s);
    else clusters.push({ x, y, geo: s.geo, streams: [s] });
  }
  const hp = home ? project(home.lon, home.lat) : null;
  mapModel = { clusters, atHome, home };

  // Zoom to fit home + viewers (never tighter than ~a third of the world); whole world when
  // nobody remote is watching. k converts "screen-sized" marks into map units at this zoom.
  const pts = [...clusters.map(c => [c.x, c.y]), ...(hp ? [hp] : [])];
  let vx = 0, vy = 0, vw = W, vh = H;
  if (clusters.length) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), pad = 70;
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    vw = Math.min(W, Math.max(300, bw + 2 * pad, (bh + 2 * pad) * W / H));
    vh = vw * H / W;
    vx = Math.min(W - vw, Math.max(0, (Math.min(...xs) + Math.max(...xs)) / 2 - vw / 2));
    vy = Math.min(H - vh, Math.max(0, (Math.min(...ys) + Math.max(...ys)) / 2 - vh / 2));
  }
  // k = map units per screen pixel, so dots and labels keep the same on-screen size at any
  // zoom level and any card width (the map re-renders on resize). In TV mode the map is fitted
  // into a fixed-height box, so the height can be what limits it.
  const mapEl = $('map');
  const tvFit = document.body.classList.contains('tv') && mapEl.clientHeight > 60 ? vh / mapEl.clientHeight : 0;
  const k = Math.max(vw / Math.max(240, mapEl.clientWidth || 800), tvFit) * 1.3;
  const f = v => v.toFixed(1);
  let svg = `<svg viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}" role="img" aria-label="World map: ${remote.length} remote and ${atHome.length} local streams">`;
  svg += `<path class="grat" d="${MAP_GRATICULE}"/><path class="land" d="${land}"/>`;

  // Arcs from the server to each viewer, bowed toward the pole so they read as flight paths.
  if (hp) for (const c of clusters) {
    const [x1, y1] = hp, dist = Math.hypot(c.x - x1, c.y - y1);
    if (dist < 4 * k) continue;
    const paused = c.streams.every(s => s.state === 'paused');
    svg += `<path class="arc${paused ? ' paused' : ''}" d="M${f(x1)} ${f(y1)}Q${f((x1 + c.x) / 2)} ${f((y1 + c.y) / 2 - dist * 0.28)} ${f(c.x)} ${f(c.y)}"/>`;
  }

  // Labels: try right, left, above, below each mark and skip any that would collide.
  // (The list beside the map always names everyone, so a skipped label loses nothing.)
  const marks = clusters.map(c => ({ ...c, r: (5 + Math.min(c.streams.length - 1, 3) * 1.5) * k }));
  const taken = [...marks.map(m => [m.x - m.r, m.y - m.r, m.x + m.r, m.y + m.r]), ...(hp ? [[hp[0] - 7 * k, hp[1] - 7 * k, hp[0] + 7 * k, hp[1] + 7 * k]] : [])];
  const overlaps = b => taken.some(t => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
  const fits = b => b[0] >= vx && b[2] <= vx + vw && b[1] >= vy && b[3] <= vy + vh;
  const label = (x, y, r, text, cls = '') => {
    const w = text.length * 6.4 * k, h = 13 * k, gap = 5 * k;
    const spots = [
      [x + r + gap, y - h / 2, 'start', x + r + gap, y + 4 * k],
      [x - r - gap - w, y - h / 2, 'end', x - r - gap, y + 4 * k],
      [x - w / 2, y - r - gap - h, 'middle', x, y - r - gap - 3 * k],
      [x - w / 2, y + r + gap, 'middle', x, y + r + gap + 10 * k],
    ];
    for (const [bx, by, anchor, tx, ty] of spots) {
      const box = [bx, by, bx + w, by + h];
      if (overlaps(box) || !fits(box)) continue;
      taken.push(box);
      return `<text class="lbl ${cls}" x="${f(tx)}" y="${f(ty)}" text-anchor="${anchor}" style="font-size:${f(11 * k)}px">${esc(text)}</text>`;
    }
    return '';
  };

  let labels = '';
  if (hp) {
    svg += `<circle class="home-ring" cx="${f(hp[0])}" cy="${f(hp[1])}" r="${f(7 * k)}"/><circle class="home-core" cx="${f(hp[0])}" cy="${f(hp[1])}" r="${f(2.5 * k)}"/>`;
    labels += label(hp[0], hp[1], 7 * k, `Home${atHome.length ? ` · ${atHome.length} local` : ''}`, 'home');
  }
  for (const m of marks) {
    const n = m.streams.length;
    const playing = m.streams.some(s => s.state === 'playing');
    if (playing) svg += `<circle class="pulse" cx="${f(m.x)}" cy="${f(m.y)}" r="${f(m.r)}"/>`;
    svg += `<circle class="dot${playing ? '' : ' paused'}" cx="${f(m.x)}" cy="${f(m.y)}" r="${f(m.r)}"/>`;
    if (n > 1) svg += `<text class="n" x="${f(m.x)}" y="${f(m.y)}" style="font-size:${f(9 * k)}px">${n}</text>`;
    if (m.geo.city) labels += label(m.x, m.y, m.r, m.geo.city);
  }
  svg += labels;
  // Hit targets bigger than the marks, drawn last so they sit on top.
  if (hp) svg += `<circle class="hit" data-home cx="${f(hp[0])}" cy="${f(hp[1])}" r="${f(14 * k)}"/>`;
  marks.forEach((m, i) => (svg += `<circle class="hit" data-i="${i}" cx="${f(m.x)}" cy="${f(m.y)}" r="${f(14 * k)}"/>`));
  svg += '</svg>';
  setHTML($('map'), svg);

  $('map-count').textContent = streams.length ? `${remote.length + unknown.length} remote · ${atHome.length} local` : 'nobody watching';

  // Side list doubles as the text alternative to the map.
  const li = (cls, s, where) => `<li><span class="sw ${cls}" aria-hidden="true"></span><span>${streamLine(s)}</span><span class="where">${where}</span></li>`;
  const rows = [
    ...remote.map(s => li(s.state === 'paused' ? 'paused' : '', s, `${esc(place(s.geo))}${s.bandwidth ? ` · ${mbps(s.bandwidth)}` : ''}`)),
    ...atHome.map(s => li('home', s, `Home network${s.bandwidth ? ` · ${mbps(s.bandwidth)}` : ''}`)),
    ...unknown.map(s => li('unknown', s, 'Remote · location unknown')),
  ];
  setHTML($('viewers'), rows.join('') || '<li class="muted">Nobody is watching right now.</li>');
  setHTML($('map-legend'), [
    'Dots are remote viewers and pulse while playing. Lines run from your server; the ring is home.',
    'Locations are city-level, from Plex’s own GeoIP lookup.',
    home ? '' : '<br><b>Home location unknown.</b> Set it under <a href="/settings">Settings → General</a>.',
  ].join(' '));
}

$('map').addEventListener('mousemove', e => {
  const hit = e.target.closest('.hit');
  if (!hit) { tip.hidden = true; return; }
  if ('home' in hit.dataset) {
    const h = mapModel.home;
    tip.innerHTML = `<div style="margin-bottom:4px"><b>Your server</b>${h?.city ? ` · ${esc(place(h))}` : ''}</div>` +
      (mapModel.atHome.length ? mapModel.atHome.map(s => `<div>${streamLine(s)}</div>`).join('') : '<div class="muted">No local streams</div>');
  } else {
    const c = mapModel.clusters[Number(hit.dataset.i)];
    tip.innerHTML = `<div style="margin-bottom:4px;color:var(--text-secondary)">${esc(place(c.geo))}</div>` +
      c.streams.map(s => `<div>${streamLine(s)}</div><div class="muted" style="margin-bottom:4px">${esc(s.decision)}${s.bandwidth ? ` · ${mbps(s.bandwidth)}` : ''} · ${esc(s.product || '')}</div>`).join('');
  }
  placeTip(e);
});
$('map').addEventListener('mouseleave', () => (tip.hidden = true));

// --------------------------------------------------------------------- roll-up cards
// Cards with nothing to show (map with no viewers, no errors, empty download queue, no
// requests) shrink to a slim title bar and open again by themselves when something arrives.
// "Show" opens one anyway until it has content again.
const rollPeek = new Set();
function rollUp(cardId, idle) {
  const card = $(cardId);
  if (!idle) rollPeek.delete(cardId);
  const collapsed = idle && !rollPeek.has(cardId);
  card.classList.toggle('collapsed', collapsed);
  card.querySelector('.roll-body').hidden = collapsed;
  const toggle = card.querySelector('.roll-toggle');
  toggle.hidden = !idle;
  toggle.textContent = collapsed ? 'Show' : 'Hide';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  return collapsed;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-roll]');
  if (!b) return;
  const id = b.dataset.roll;
  rollPeek.has(id) ? rollPeek.delete(id) : rollPeek.add(id);
  lastHTML.delete($('map')); // the map was drawn (or not) while hidden; redraw at the real width
  if (state) render(state);
});

// --------------------------------------------------------------------- errors & warnings feed
const evFilter = { svc: 'all', level: 'all', showDismissed: false };

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderEvents(d) {
  const active = d.events.filter(e => !e.dismissed);
  const dismissedN = d.events.length - active.length;
  const errs = active.filter(e => e.level === 'error').length;
  $('ev-count').textContent = active.length ? `${errs} errors · ${active.length - errs} warnings`
    : `all clear${dismissedN ? ` · ${dismissedN} dismissed` : ''}`;
  if (rollUp('events-card', !active.length)) return;

  const names = new Map(d.services.map(s => [s.id, s.name]));
  const bySvc = new Map();
  for (const e of active) bySvc.set(e.svcId, (bySvc.get(e.svcId) || 0) + 1);
  if (evFilter.svc !== 'all' && !names.has(evFilter.svc)) evFilter.svc = 'all';
  const btn = (kind, val, label, n) =>
    `<button type="button" data-${kind}="${esc(val)}" aria-pressed="${evFilter[kind] === val}">${esc(label)}${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
  setHTML($('ev-filters'), [
    btn('level', 'all', 'All levels'), btn('level', 'error', 'Errors only', errs),
    '<span class="sep"></span>',
    btn('svc', 'all', 'All apps', active.length),
    ...[...bySvc].map(([id, n]) => btn('svc', id, names.get(id) || id, n)),
    // keep the selected app's chip even once its errors are all dismissed
    ...(evFilter.svc !== 'all' && !bySvc.has(evFilter.svc) ? [btn('svc', evFilter.svc, names.get(evFilter.svc), 0)] : []),
  ].join(''));

  const inFilter = e => (evFilter.level === 'all' || e.level === evFilter.level) && (evFilter.svc === 'all' || e.svcId === evFilter.svc);
  const shownActive = active.filter(inFilter);
  const shown = (evFilter.showDismissed ? d.events : active).filter(inFilter).slice(0, 150);

  // Action bar: app actions on the left (when one app is selected), feed actions on the right.
  const sel = evFilter.svc !== 'all' && d.services.find(s => s.id === evFilter.svc);
  const left = sel ? [
    `<button class="btn small" type="button" data-recheck="${esc(sel.id)}" title="${sel.actions.recheck === 'health' ? `Run ${esc(sel.name)}'s health checks now` : `Poll ${esc(sel.name)} again now`}">↻ Re-check ${esc(sel.name)}</button>`,
    sel.actions.clear ? `<button class="btn small danger ghost" type="button" data-clear="${esc(sel.id)}">Clear ${esc(sel.name)}'s log…</button>` : '',
  ] : [];
  const right = [
    shownActive.length ? `<button class="btn small" type="button" data-dismiss-all>Dismiss ${evFilter.svc === 'all' ? 'all' : `all from ${esc(sel?.name || '')}`}</button>` : '',
    dismissedN ? `<button class="btn small ghost" type="button" data-toggle-dismissed>${evFilter.showDismissed ? 'Hide' : 'Show'} dismissed <span class="num">${dismissedN}</span></button>` : '',
    dismissedN && evFilter.showDismissed ? `<button class="btn small ghost" type="button" data-restore>Restore all</button>` : '',
  ];
  setHTML($('ev-actions'), `<div class="ev-left">${left.join('')}</div><div class="ev-right">${right.join('')}</div>`);

  const el = $('events');
  if (!shown.length) {
    const msg = d.events.length && !active.length ? `✓ All caught up. ${dismissedN} dismissed.`
      : active.length ? 'Nothing matches this filter.' : '✓ No errors or warnings. Everything is behaving.';
    return setHTML(el, `<div class="empty">${msg}</div>`);
  }

  // Keep expanded rows expanded across refreshes.
  const open = new Set([...el.querySelectorAll('details[open]')].map(x => x.dataset.key));
  setHTML(el, shown.map(e => {
    const svc = d.services.find(s => s.id === e.svcId);
    const queueActs = !e.dismissed && e.source === 'Queue' && e.queueId != null
      ? `<button class="mini-btn" type="button" data-qretry="${esc(e.svcId)}" title="Ask ${esc(svc?.name || '')} to re-check its downloads and try the import again">Retry</button>
         <button class="mini-btn" type="button" data-qremove="${esc(e.svcId)}" data-qid="${esc(e.queueId)}" title="Remove from the downloader, blocklist this release and search for another">Replace…</button>`
      : '';
    const acts = e.dismissed
      ? '<span class="tag">dismissed</span>'
      : `${queueActs}${e.live && (e.healthCheck || e.source === 'Connection') ? `<button class="icon-btn" type="button" data-recheck="${esc(e.svcId)}" title="Re-check ${esc(svc?.name || '')}" aria-label="Re-check ${esc(svc?.name || '')}">↻</button>` : ''}
         <button class="icon-btn" type="button" data-dismiss="${esc(e.key)}" title="Dismiss" aria-label="Dismiss">✕</button>`;
    const lvl = e.level === 'error' ? 'error' : 'warn';
    const cells = `<span class="lvl ${lvl}">${lvl}</span>
      <span class="svc-n">${esc(e.svc)}</span>
      <span class="msg"><span class="src" data-svc="${esc(e.svc)}">${esc(e.source)}</span>${esc(e.message)}${e.hint ? '<span class="hint-mark" title="Has a how-to-fix tip: click to open"> 💡</span>' : ''}</span>
      <span class="ago" title="${new Date(e.t).toLocaleString()}">${e.live ? 'active' : ago(e.t)}</span>
      <span class="ev-acts">${acts}</span>`;
    const cls = `ev${e.dismissed ? ' is-dismissed' : ''}`;
    const body = `${e.hint ? `<p class="ev-hint"><b>How to fix:</b> ${esc(e.hint)}</p>` : ''}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}`;
    return body
      ? `<details class="${cls}" data-key="${esc(e.key)}"${open.has(e.key) ? ' open' : ''}><summary>${cells}</summary>${body}</details>`
      : `<div class="${cls}"><div class="row">${cells}</div></div>`;
  }).join(''));
}

$('ev-filters').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.level) evFilter.level = b.dataset.level;
  if (b.dataset.svc) evFilter.svc = b.dataset.svc;
  if (state) renderEvents(state);
});

// --------------------------------------------------------------------- dismiss / clear / re-check
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.innerHTML = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), kind === 'bad' ? 7000 : 3500);
}

async function post(path, body = {}) {
  const r = await fetch(`/api/events${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { needLogin: data.needLogin });
  return data;
}

async function runAction(btn, fn) {
  btn.disabled = true;
  const label = btn.innerHTML;
  if (!btn.classList.contains('icon-btn')) btn.textContent = 'Working…';
  try {
    const r = await fn();
    if (r?.message) toast(`✓ ${esc(r.message)}`);
  } catch (err) {
    toast(err.needLogin ? `${esc(err.message)} — <a href="/settings">open Settings</a>` : `✕ ${esc(err.message)}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
    lastHTML.clear(); // force a full redraw with fresh data
    refresh();
  }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-dismiss],[data-dismiss-all],[data-restore],[data-recheck],[data-clear],[data-toggle-dismissed],[data-stop],[data-qretry],[data-qremove],[data-rq]');
  if (!b) return;
  e.preventDefault(); // buttons inside <summary> must not toggle the row
  e.stopPropagation();
  const name = id => state?.services.find(s => s.id === id)?.name || 'app';
  if ('dismiss' in b.dataset) return runAction(b, () => post('/dismiss', { keys: [b.dataset.dismiss] }));
  if ('dismissAll' in b.dataset) return runAction(b, () => post('/dismiss', evFilter.svc === 'all' ? { all: true } : { svcId: evFilter.svc }));
  if ('restore' in b.dataset) return runAction(b, () => post('/restore'));
  if ('recheck' in b.dataset) return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.recheck)}/recheck`));
  if ('toggleDismissed' in b.dataset) { evFilter.showDismissed = !evFilter.showDismissed; return renderEvents(state); }
  if ('rq' in b.dataset) {
    if (b.dataset.rq === 'decline' && !confirm(`Decline the request for ${b.dataset.title}?`)) return;
    return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.svc)}/request-${b.dataset.rq}`, { requestId: Number(b.dataset.id) }));
  }
  if ('stop' in b.dataset) {
    const reason = prompt(`Stop ${b.dataset.user}'s stream?\n\nMessage shown on their screen:`, 'The server is going down for maintenance. Sorry!');
    if (reason === null) return;
    return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.svc)}/stop`, { sessionId: b.dataset.stop, reason }));
  }
  if ('qretry' in b.dataset) return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.qretry)}/queue-retry`));
  if ('qremove' in b.dataset) {
    if (!confirm(`Remove this download, blocklist the release, and have ${name(b.dataset.qremove)} search for another?`)) return;
    return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.qremove)}/queue-remove`, { queueId: Number(b.dataset.qid) }));
  }
  if ('clear' in b.dataset) {
    const svc = state.services.find(s => s.id === b.dataset.clear);
    if (!confirm(`Clear ${name(svc.id)}'s log?\n\n${svc.actions.clear}`)) return;
    return runAction(b, () => post(`/services/${encodeURIComponent(svc.id)}/clear`));
  }
});

// *arr/SABnzbd send ETAs as "hh:mm:ss" strings; qBittorrent sends seconds (8640000 = unknown).
function etaText(eta) {
  if (eta == null || eta === '') return '';
  if (typeof eta === 'number') return eta >= 8640000 ? '∞' : clock(eta * 1000);
  return String(eta).replace(/^00:/, '');
}

function renderDownloads(clients, arrs) {
  // Prefer the *arr queues (clean titles); fall back to raw client items when no arr is grabbing anything.
  let items = arrs.flatMap(a => a.data.queue.map(q => ({ ...q, source: a.name })));
  if (!items.length) items = clients.flatMap(c => c.data.items.map(q => ({ ...q, source: c.name })));
  const today = clients.reduce((n, c) => n + (c.data.totals?.day || 0), 0);
  $('downloads-count').textContent = items.length ? `${items.length} in queue`
    : `queue empty${today ? ` · ${bytes(today)} today` : ''}`;
  if (rollUp('downloads-card', !items.length)) return;

  setHTML($('clients'), clients.map(c => {
    const d = c.data;
    const x = c.kind === 'qbittorrent'
      ? `${num(d.torrents)} torrents · ratio ${d.ratio?.toFixed(2) ?? '—'} · ${bytes(d.allTimeUp)} seeded`
      : `${d.paused ? 'PAUSED' : esc(d.status)}${d.totals ? ` · today ${bytes(d.totals.day)} · month ${bytes(d.totals.month)}` : ''}`;
    return `<div class="client"><h3>${esc(c.name)}</h3>
      <div class="speeds"><span class="down">${rate(d.downBps)}</span>${c.kind === 'qbittorrent' ? `<span class="up">${rate(d.upBps)}</span>` : ''}</div>
      <div class="x">${x}</div></div>`;
  }).join(''));

  if (!items.length) return setHTML($('queue'), '<div class="empty">Queue is empty.</div>');

  setHTML($('queue'), items.slice(0, 15).map(q => {
    const done = q.progress >= 1;
    const meta = [
      `${Math.floor(q.progress * 100)}%`,
      q.size && bytes(q.size),
      !done && etaText(q.eta),
      done && esc(q.status),
      esc(q.source),
    ].filter(Boolean).join(' · ');
    return `<div class="qitem ${done ? 'done' : ''} ${q.warning ? 'warn' : ''}">
      <div class="row1"><span class="name" title="${esc(q.title)}">${q.warning ? '⚠ ' : ''}${esc(q.title)}</span><span class="m">${meta}</span></div>
      <div class="bar"><i style="width:${(q.progress * 100).toFixed(1)}%"></i></div></div>`;
  }).join(''));
}

function dayLabel(date) {
  const d = new Date(date), today = new Date();
  const diff = Math.round((new Date(d.toDateString()) - new Date(today.toDateString())) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderUpcoming(arrs) {
  const cutoff = Date.now() - 864e5;
  const items = arrs.flatMap(a => a.data.upcoming)
    .filter(u => new Date(u.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 16);
  if (!items.length) return setHTML($('upcoming'), '<div class="empty">Nothing on the calendar.</div>');
  let html = '', last = '';
  for (const u of items) {
    const label = dayLabel(u.date);
    if (label !== last) { html += `<div class="day">${label}</div>`; last = label; }
    const time = u.kind === 'tv' ? new Date(u.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    html += `<div class="up-item"><span class="sw ${u.kind}" aria-label="${u.kind}"></span>
      <div class="t">${esc(u.title)}<span>${esc(u.sub)}</span></div>
      <span class="when ${u.hasFile ? 'got' : ''}">${u.hasFile ? '✓ grabbed' : time}</span></div>`;
  }
  setHTML($('upcoming'), html);
}

// --------------------------------------------------------------------- watch stats (stacked bar chart)
const SERIES_CLASS = ['s1', 's2', 's3'];
const SERIES_VAR = ['--series-1', '--series-2', '--series-3'];

// Axis top = 4 × a "nice" step (1, 2, 5 × 10^n), so every gridline is a whole number.
function niceMax(v) {
  const raw = Math.max(1, v) / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p * 4;
}
const shortDate = s => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function renderWatch(t) {
  $('watch-card').hidden = !t;
  if (!t) return;
  const { dates, series } = t.data.playsByDate;
  const shown = series.slice(0, 3); // fixed slots: TV, Movies, Music

  setHTML($('plays-legend'), shown.map((s, i) =>
    `<span><i style="background:var(${SERIES_VAR[i]})"></i>${esc(s.name)} <b class="num">${num(sum(s.data, x => x))}</b></span>`).join(''));

  const W = Math.max(320, $('plays-chart').clientWidth || 600), H = 220;
  const m = { l: 30, r: 4, t: 8, b: 22 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const totals = dates.map((_, i) => sum(shown, s => s.data[i]));
  const max = niceMax(Math.max(...totals));
  const step = pw / dates.length, bw = Math.max(3, Math.min(22, step - 3));
  const y = v => m.t + ph - (v / max) * ph;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Plays per day for the last 30 days, stacked by media type">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k, yy = y(v);
    svg += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="axis" x="${m.l - 6}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  dates.forEach((dt, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = 0;
    const segs = shown.map((s, si) => ({ v: s.data[i] || 0, si })).filter(s => s.v > 0);
    segs.forEach((s, idx) => {
      const y0 = y(base), y1 = y(base + s.v);
      const top = idx === segs.length - 1;
      const gap = idx > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const h = Math.max(0, y0 - y1 - gap);
      const yTop = y1, r = top ? Math.min(4, bw / 2, h) : 0;
      svg += r
        ? `<path class="${SERIES_CLASS[s.si]}" d="M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${yTop + h} Z"/>`
        : `<rect class="${SERIES_CLASS[s.si]}" x="${x}" y="${yTop}" width="${bw}" height="${h}"/>`;
      base += s.v;
    });
    if (i % 7 === (dates.length - 1) % 7)
      svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${shortDate(dt)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${m.l + i * step}" y="${m.t}" width="${step}" height="${ph}"/>`;
  });
  svg += '</svg>';
  setHTML($('plays-chart'), svg);

  setHTML($('plays-table'), `<table class="data"><thead><tr><th>Date</th>${shown.map(s => `<th>${esc(s.name)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${
    dates.map((d, i) => `<tr><td>${shortDate(d)}</td>${shown.map(s => `<td>${s.data[i] || 0}</td>`).join('')}<td>${totals[i]}</td></tr>`).reverse().join('')
  }</tbody></table>`);

  const list = (title, rows) => {
    if (!rows?.length) return '';
    const top = rows[0].plays || 1;
    return `<div class="toplist"><h3>${title}</h3><ol>${rows.map(r =>
      `<li><span class="nm">${esc(r.name)}</span><span class="pl">${num(r.plays)}</span><span class="mini"><i style="width:${(r.plays / top) * 100}%"></i></span></li>`).join('')}</ol></div>`;
  };
  setHTML($('toplists'), [
    list('Top users', t.data.topUsers),
    list('Top shows', t.data.topShows),
    list('Top movies', t.data.topMovies),
    list('Top platforms', t.data.topPlatforms),
  ].join('') + (t.data.mostConcurrent ? `<div class="toplist"><h3>Peak concurrent</h3><div class="num" style="font-size:22px;font-weight:600">${num(t.data.mostConcurrent)} streams</div></div>` : ''));
}

// Hover tooltips (chart + map). Delegated, so they survive re-renders.
const tip = $('tooltip');
function placeTip(e) {
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = e.clientX + 14;
  if (left + r.width > innerWidth - 8) left = e.clientX - r.width - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
}
$('plays-chart').addEventListener('mousemove', e => {
  const hit = e.target.closest('.hit');
  const t = state?.services.find(s => s.kind === 'tautulli' && s.up);
  if (!hit || !t) { tip.hidden = true; return; }
  const i = Number(hit.dataset.i);
  const { dates, series } = t.data.playsByDate;
  const shown = series.slice(0, 3);
  tip.innerHTML = `<div style="margin-bottom:4px;color:var(--text-secondary)">${new Date(dates[i] + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>` +
    shown.map((s, si) => `<div class="r"><span><i style="background:var(${SERIES_VAR[si]})"></i>${esc(s.name)}</span><b>${n0(s.data[i])}</b></div>`).join('') +
    `<div class="r" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><b>${n0(sum(shown, s => s.data[i]))}</b></div>`;
  placeTip(e);
});
$('plays-chart').addEventListener('mouseleave', () => (tip.hidden = true));
$('plays-table-toggle').addEventListener('click', e => {
  const table = $('plays-table'), showTable = table.hidden;
  table.hidden = !showTable;
  $('plays-chart').hidden = showTable;
  e.target.textContent = showTable ? 'Show as chart' : 'Show as table';
});
addEventListener('resize', () => { lastHTML.delete($('plays-chart')); lastHTML.delete($('map')); if (state) renderMap(state.services.find(s => s.kind === 'plex' && s.up)); if (state) renderWatch(state.services.find(s => s.kind === 'tautulli' && s.up)); });

// --------------------------------------------------------------------- storage / host
// Disks come from two places: what each *arr reports via its API, and the paths configured
// under Settings (statfs inside this container). Merged by path.
const duration = days => days < 14 ? `${Math.max(1, Math.round(days))} days` : days < 120 ? `${Math.round(days / 7)} weeks` : days < 730 ? `${Math.round(days / 30)} months` : `${(days / 365).toFixed(1)} years`;

function renderDisks(d, arrs) {
  const map = new Map();
  for (const a of arrs) for (const k of a.data.disks || [])
    if (k.totalSpace > 0) map.set(k.path, { path: k.path, label: k.label, total: k.totalSpace, free: k.freeSpace });
  for (const k of d.disks || []) if (k.total > 0) map.set(k.path, k);
  // Collapse mounts that are the same filesystem seen through different paths.
  const seen = new Set();
  const disks = [...map.values()].filter(k => {
    const sig = `${k.total}:${Math.round(k.free / 1e8)}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).sort((a, b) => b.total - a.total);

  if (!disks.length) return setHTML($('disks'), '<div class="empty">No disk info yet — it comes from the *arrs or the "paths" config.</div>');
  setHTML($('disks'), disks.map(k => {
    const used = k.total - k.free, pct = (used / k.total) * 100;
    const cls = pct > 95 ? 'crit' : pct > 85 ? 'warn' : '';
    const fc = hist?.forecasts?.[k.path];
    const soon = fc?.status === 'growing' && fc.daysToFull < 30;
    const fcText = !fc ? ''
      : fc.status === 'growing' ? `${soon ? '⚠ ' : ''}Full in ~${duration(fc.daysToFull)} at +${bytes(fc.perDay)}/day`
        : fc.status === 'flat' ? 'Not growing'
          : `Forecast after 3 days of data (day ${fc.days})`;
    return `<div class="disk ${cls}">
      <div class="row1"><span class="p">${cls ? '⚠ ' : ''}${esc(k.path)}${k.label && k.label !== k.path ? ` <span class="muted">${esc(k.label)}</span>` : ''}</span>
      <span class="m">${bytes(used)} / ${bytes(k.total)} · ${bytes(k.free)} free · ${pct.toFixed(0)}%</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      ${fcText ? `<div class="fc${soon ? ' soon' : ''}">${fcText}</div>` : ''}</div>`;
  }).join(''));
}

const vmNote = "On Windows and Mac, Docker runs containers inside a small Linux VM, so this is the VM's share, not the whole computer's. In Docker Desktop you can change it under Settings → Resources.";

function renderHost(h, docker, gpus = [], plexRes = null) {
  $('host-name').textContent = h.hostname;
  const memPct = (h.memUsed / h.memTotal) * 100;
  const cell = (k, v, pct, title = '') => `<div class="h"${title ? ` title="${esc(title)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div>${pct != null ? `<div class="bar"><i style="width:${Math.min(100, pct).toFixed(0)}%"></i></div>` : ''}</div>`;
  setHTML($('host'), [
    // On Windows and Mac containers run in a small VM; these numbers are the VM's.
    cell(h.vm ? 'CPU (Docker VM)' : 'CPU', h.cpu != null ? `${h.cpu}%` : '—', h.cpu, h.vm ? vmNote : ''),
    cell(h.vm ? 'Memory (Docker VM)' : 'Memory', `${bytes(h.memUsed)}`, memPct, h.vm ? vmNote : ''),
    cell(`Load (${h.cpus} cores)`, h.load.map(l => l.toFixed(2)).join(' ')),
    cell(h.vm ? 'VM uptime' : 'Uptime', uptime(h.uptime)),
    plexRes?.plexCpu != null && cell('Plex CPU', `${Math.round(plexRes.plexCpu)}%`, plexRes.plexCpu, `Plex Media Server's own CPU use (host total ${Math.round(plexRes.hostCpu)}%)`),
    ...gpus.map(g => cell(esc(g.name), g.busy != null ? `${g.busy}%` : g.freqMhz != null ? `${g.freqMhz} MHz` : '—', g.busy ?? (g.freqMhz && g.maxMhz ? (g.freqMhz / g.maxMhz) * 100 : null),
      [g.busy != null && `${g.busy}% busy`, g.freqMhz && `${g.freqMhz}${g.maxMhz ? ` of ${g.maxMhz}` : ''} MHz`, g.temp != null && `${g.temp} °C`, g.encoderSessions != null && `${g.encoderSessions} encode sessions`].filter(Boolean).join(' · '))),
  ].filter(Boolean).join(''));

  if (!docker) return setHTML($('docker'), '');
  if (docker.error) return setHTML($('docker'), `<div class="empty">Docker: ${esc(docker.error)}</div>`);
  setHTML($('docker'), docker.map(c => {
    const cls = c.state !== 'running' ? 'down' : c.health === 'unhealthy' ? 'warn' : 'up';
    return `<div class="ctr" title="${esc(c.image)}"><span class="dot ${cls}" aria-label="${esc(c.state)}"></span><span class="n">${esc(c.name)}</span><span class="s">${esc(c.status)}</span></div>`;
  }).join(''));
}

// --------------------------------------------------------------------- Unraid
function renderUnraid(u) {
  $('unraid-card').hidden = !u;
  if (!u) return;
  const d = u.data;
  $('unraid-sub').textContent = `${d.server ? `${d.server} · ` : ''}v${u.version || '?'} · array ${d.state.toLowerCase().replace(/_/g, ' ')} · ${bytes(d.capacity.used)} of ${bytes(d.capacity.total)} used`;
  const p = d.parity;
  const when = p.date ? new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  setHTML($('unraid-parity'), p.running || p.paused
    ? `<div class="row1"><span><b>Parity ${p.correcting ? 'check (correcting)' : 'check'}</b> ${p.paused ? '· paused' : ''}</span><span class="m">${n0(p.progress)}%${p.speed ? ` · ${esc(p.speed)}` : ''} · ${n0(p.errors)} errors</span></div><div class="bar"><i style="width:${n0(p.progress)}%"></i></div>`
    : `<div class="row1"><span><b>Parity</b> ${p.status === 'NEVER_RUN' ? '· never checked' : `· last check ${esc((p.status || '').toLowerCase())}${when ? ` ${when}` : ''}`}</span><span class="m ${p.errors ? 'hot' : ''}">${p.errors ? `⚠ ${n0(p.errors)} errors` : '0 errors'}</span></div>`);
  setHTML($('unraid-disks'), d.disks.map(k => {
    const pct = k.used != null && k.size ? (k.used / k.size) * 100 : null;
    const hot = k.temp != null && k.temp >= k.tempCrit ? 'crit' : k.temp != null && k.temp >= k.tempWarn ? 'warn' : '';
    const full = pct != null && k.fullCrit && pct >= k.fullCrit ? 'crit' : pct != null && k.fullWarn && pct >= k.fullWarn ? 'warn' : '';
    const bad = k.status !== 'DISK_OK';
    return `<div class="udisk ${bad ? 'bad' : ''}" title="${esc(`${k.name} · ${k.role}${k.ssd ? ' (SSD)' : ''} · ${bytes(k.size)}${k.temp != null ? ` · ${k.temp} °C (warn ${k.tempWarn}, critical ${k.tempCrit})` : ''}`)}">
      <div class="row1"><b>${esc(k.name)}</b><span class="role">${esc(k.role)}</span></div>
      <div class="temp ${hot}">${k.temp != null ? `${hot ? '⚠ ' : ''}${n0(k.temp)} °C` : k.spinning === false ? '◌ spun down' : '—'}</div>
      ${pct != null ? `<div class="bar ${full}"><i style="width:${pct.toFixed(0)}%"></i></div><div class="m">${pct.toFixed(0)}% of ${bytes(k.size)}</div>` : `<div class="m">${bytes(k.size)}</div>`}
      ${bad ? `<div class="m hot">✕ ${esc(k.status.replace('DISK_', '').toLowerCase())}</div>` : k.errors ? `<div class="m hot">⚠ ${k.errors} errors</div>` : ''}
    </div>`;
  }).join(''));
}

// --------------------------------------------------------------------- indexer limits (Prowlarr)
// One row per enabled indexer: queries and grabs in Prowlarr's own rolling window, against the
// limits set on the indexer. Bars only where a limit is set; the numbers are always shown.
function renderIndexers(prowlarrs) {
  const rows = prowlarrs.flatMap(p => p.data.limits || []);
  $('indexers-card').hidden = !rows.length;
  if (!rows.length) return;
  const limited = rows.filter(l => l.queryLimit || l.grabLimit).length;
  $('indexers-sub').textContent = `${rows.length} indexer${rows.length === 1 ? '' : 's'}${limited ? ` · ${limited} with limits` : ''}`;
  $('indexers-note').hidden = limited === rows.length;
  const meter = (label, used, max) => {
    if (!max) return `<div class="meter none"><div class="m-top"><span>${label}</span><span class="num">${num(used)}</span></div><div class="m-sub">no limit set</div></div>`;
    const pct = used / max;
    const cls = pct >= 1 ? 'crit' : pct >= 0.9 ? 'warn' : '';
    return `<div class="meter ${cls}"><div class="m-top"><span>${label}</span><span class="num">${cls ? '⚠ ' : ''}${num(used)} / ${num(max)}</span></div>
      <div class="bar" role="img" aria-label="${label}: ${used} of ${max}"><i style="width:${Math.min(100, pct * 100).toFixed(1)}%"></i></div></div>`;
  };
  setHTML($('indexers'), rows.map(l => `<div class="idx">
      <div class="idx-name"><b>${esc(l.name)}</b><span class="muted">last ${l.unit === 'hour' ? 'hour' : '24 h'}</span>
        ${l.pausedUntil ? `<span class="chip bad" title="Prowlarr paused it after failures">paused until ${esc(timeOf(l.pausedUntil))}</span>` : ''}</div>
      ${meter('API calls', l.queries, l.queryLimit)}${meter('Grabs', l.grabs, l.grabLimit)}
    </div>`).join(''));
}

// --------------------------------------------------------------------- what's using space
let spaceTab = 'biggest';
const daysText = d => {
  if (d >= 365) { const y = Math.round(d / 365 * 10) / 10; return `${d >= 730 ? Math.round(y) : y} year${y === 1 ? '' : 's'}`; }
  return d >= 60 ? `${Math.round(d / 30)} months` : `${d} day${d === 1 ? '' : 's'}`;
};
const span = t => daysText(Math.floor((Date.now() - t) / 864e5));
function renderSpace(sp) {
  const show = !!sp && (sp.biggest.length || sp.downloaded.items.length);
  $('space-card').hidden = !show;
  if (!show) return;
  $('space-tabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.space === spaceTab)));
  const c = sp.cleanup;
  $('space-sub').textContent = c?.count ? `${bytes(c.total)} in ${c.count} title${c.count === 1 ? '' : 's'} nobody watched in ${daysText(c.days)}` : '';

  let list = [], note = '', sizeOf = x => x.size, extra = () => '';
  if (spaceTab === 'biggest') {
    list = sp.biggest;
    note = 'The largest series, movies and artists, from Sonarr, Radarr and Lidarr.';
  } else if (spaceTab === 'downloaded') {
    list = sp.downloaded.items;
    sizeOf = x => x.bytes;
    extra = x => `${x.count} import${x.count === 1 ? '' : 's'}`;
    note = list.length ? `${bytes(sp.downloaded.total)} imported in the last 30 days (upgrades included, so it isn't all new space).${sp.downloaded.loading ? ' Still loading import history from some apps…' : ''}`
      : sp.downloaded.loading ? 'Loading import history… (this can take a minute on a big library)' : 'Nothing imported in the last 30 days.';
  } else if (!c) {
    note = sp.tautulli ? 'Collecting watch history from Tautulli…' : 'Add Tautulli (Settings → Add app) to see which movies and shows nobody watches.';
  } else {
    list = c.items;
    extra = x => (x.lastPlayed ? `last watched ${span(x.lastPlayed)} ago` : 'never watched') + (x.added ? ` · added ${span(x.added)} ago` : '');
    note = `${c.count ? `${bytes(c.total)} in ${c.count} titles` : 'Nothing'} not watched in ${daysText(c.days)}. Only a list: nothing is deleted.`
      + (c.historyDays != null && c.historyDays < c.days ? ` Tautulli's history only goes back ${c.historyDays} days, so earlier plays aren't counted.` : '');
  }
  $('space-note').textContent = note;
  const max = Math.max(1, ...list.map(sizeOf));
  setHTML($('space-list'), list.map(x => {
    const title = `${esc(x.title)}${x.year ? ` <span class="muted">(${esc(x.year)})</span>` : ''}`;
    return `<li class="sp-row">
      <span class="sp-t">${x.link ? `<a href="${safeHref(x.link)}" target="_blank" rel="noopener">${title}</a>` : title}
        <span class="sp-meta">${esc(x.app)}${extra(x) ? ` · ${esc(extra(x))}` : ''}</span></span>
      <span class="sp-bar" aria-hidden="true"><i style="width:${(sizeOf(x) / max * 100).toFixed(1)}%"></i></span>
      <span class="num">${bytes(sizeOf(x))}</span>
    </li>`;
  }).join(''));
}
$('space-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-space]');
  if (!b) return;
  spaceTab = b.dataset.space;
  if (state) renderSpace(state.space);
});

// --------------------------------------------------------------------- TrueNAS
const udiskTile = k => {
  const hot = k.temp != null && k.temp >= k.tempCrit ? 'crit' : k.temp != null && k.temp >= k.tempWarn ? 'warn' : '';
  return `<div class="udisk" title="${esc(`${k.name}${k.model ? ` · ${k.model}` : ''} · ${k.ssd ? 'SSD' : 'HDD'} · ${bytes(k.size)}${k.temp != null ? ` · ${k.temp} °C (warn ${k.tempWarn}, critical ${k.tempCrit})` : ''}`)}">
    <div class="row1"><b>${esc(k.name)}</b><span class="role">${esc(k.role)}</span></div>
    <div class="temp ${hot}">${k.temp != null ? `${hot ? '⚠ ' : ''}${n0(k.temp)} °C` : '—'}</div>
    <div class="m">${k.ssd ? 'SSD' : 'HDD'} · ${bytes(k.size)}</div>
  </div>`;
};

function renderTrueNAS(t) {
  $('truenas-card').hidden = !t;
  if (!t) return;
  const d = t.data;
  $('truenas-sub').textContent = [d.server, t.version && `v${t.version}`, `${d.pools.length} pool${d.pools.length === 1 ? '' : 's'}`,
    d.capacity.total ? `${bytes(d.capacity.used)} of ${bytes(d.capacity.total)} used` : null,
    d.alerts ? `${d.alerts} alert${d.alerts === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');

  setHTML($('truenas-pools'), d.pools.map(p => {
    const pct = p.size ? (p.used / p.size) * 100 : null;
    const fill = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''; // TrueNAS's own warning / critical levels
    const sc = p.scan;
    const scanning = sc?.state === 'SCANNING';
    const scanLine = !sc ? 'never scrubbed'
      : scanning ? `${sc.kind === 'RESILVER' ? 'resilvering' : 'scrubbing'} ${Math.floor(sc.progress ?? 0)}%`
      : `last ${sc.kind.toLowerCase()} ${sc.state === 'CANCELED' ? 'canceled' : sc.end ? new Date(sc.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'finished'} · ${sc.errors ? `⚠ ${sc.errors} errors` : '0 errors'}`;
    return `<div class="pool ${p.healthy && p.status === 'ONLINE' ? '' : 'bad'}">
      <div class="row1"><b>${esc(p.name)}</b><span class="pool-st ${p.healthy && p.status === 'ONLINE' ? 'ok' : 'bad'}">${p.healthy && p.status === 'ONLINE' ? '✓' : '✕'} ${esc(String(p.status || '').toLowerCase())}</span></div>
      ${pct != null ? `<div class="bar ${fill}"><i style="width:${pct.toFixed(0)}%"></i></div>
      <div class="m">${bytes(p.used)} of ${bytes(p.size)} · ${pct.toFixed(0)}%</div>` : ''}
      ${scanning ? `<div class="bar scan"><i style="width:${(sc.progress ?? 0).toFixed(1)}%"></i></div>` : ''}
      <div class="m ${sc?.errors ? 'hot' : ''}">${esc(scanLine)}</div>
    </div>`;
  }).join(''));

  setHTML($('truenas-disks'), d.disks.map(udiskTile).join(''));

  const apps = d.apps || [];
  const running = apps.filter(a => a.state === 'RUNNING').length;
  const notRunning = apps.filter(a => a.state !== 'RUNNING');
  const updates = apps.filter(a => a.upgrade).length;
  setHTML($('truenas-apps'), apps.length ? `<span class="muted">Apps</span> <b>${running}</b> running${notRunning.length ? ` · ${notRunning.map(a => `<span class="chip ${a.state === 'CRASHED' ? 'bad' : ''}">${esc(a.name)} ${esc(a.state.toLowerCase())}</span>`).join(' ')}` : ''}${updates ? ` · <span class="muted">${updates} update${updates === 1 ? '' : 's'} available</span>` : ''}` : '');
}

// --------------------------------------------------------------------- recently added + imports
function renderRecent(plex, arrs) {
  const items = plex?.data.recentlyAdded || [];
  const imports = arrs.flatMap(a => (a.data.imports || []).map(x => ({ ...x, source: a.name })))
    .filter(x => Date.now() - new Date(x.time) < 2 * 864e5)
    .sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8);
  $('recent-card').hidden = !items.length && !imports.length;
  const thumb = t => (t && !state?.demo ? `/api/plex/thumb?p=${encodeURIComponent(t)}` : null);
  setHTML($('recent-posters'), items.slice(0, 8).map(m => `<figure class="pcard" title="${esc(`${m.title} ${m.sub} · ${m.library || ''}`)}">
      ${thumb(m.thumb) ? `<img loading="lazy" alt="" src="${thumb(m.thumb)}" data-fallback="${initials(m.title)}">` : `<div class="ph" aria-hidden="true">${initials(m.title)}</div>`}
      <figcaption><b>${esc(m.title)}</b><span>${esc(m.sub)}</span><span class="muted">${ago(m.addedAt)}</span></figcaption></figure>`).join(''));
  $('recent-posters').querySelectorAll('img[data-fallback]').forEach(img => img.addEventListener('error', () => {
    const div = Object.assign(document.createElement('div'), { className: 'ph', textContent: img.dataset.fallback });
    img.replaceWith(div);
  }, { once: true }));
  $('imports-h').hidden = !imports.length;
  setHTML($('imports'), imports.map(x => `<li><span class="t">${esc(x.title)}</span>${x.quality ? `<span class="chip">${esc(x.quality)}</span>` : ''}<span class="muted">${esc(x.source)} · ${ago(new Date(x.time).getTime())}</span></li>`).join(''));
}

// --------------------------------------------------------------------- Seerr requests
function renderRequests(seerrs) {
  const reqs = seerrs.flatMap(s => (s.data.requests || []).map(r => ({ ...r, svcId: s.id })));
  $('requests-card').hidden = !seerrs.length;
  $('requests-count').textContent = reqs.length ? `${reqs.length} waiting` : 'none waiting';
  if (rollUp('requests-card', !reqs.length)) return;
  setHTML($('requests'), reqs.map(r => `<li>
      <div class="rq-main"><b>${esc(r.title)}</b>${r.year ? ` <span class="muted">(${esc(r.year)})</span>` : ''}
        <span class="chip">${r.type === 'tv' ? `TV${r.seasons?.length ? ` · S${esc(r.seasons.join(', S'))}` : ''}` : 'Movie'}</span>${r.is4k ? '<span class="chip">4K</span>' : ''}
        <div class="muted">requested by ${esc(r.requestedBy)} · ${ago(new Date(r.createdAt).getTime())}</div></div>
      <div class="rq-acts"><button class="btn small" type="button" data-rq="approve" data-svc="${esc(r.svcId)}" data-id="${esc(r.id)}" data-title="${esc(r.title)}">✓ Approve</button>
        <button class="btn small ghost" type="button" data-rq="decline" data-svc="${esc(r.svcId)}" data-id="${esc(r.id)}" data-title="${esc(r.title)}">Decline</button></div>
    </li>`).join('') || '<li class="empty">No requests waiting. 🎉</li>');
}

// --------------------------------------------------------------------- trends (last 24 h)
// Small multiples, one measure each (never two y-scales on one chart). Gaps = no data.
const TREND_CHARTS = [
  { key: 'streams', title: 'Streams', series: [{ name: 'Streams', col: 'streams', cls: 's1', area: true }, { name: 'Transcodes', col: 'transcodes', cls: 's2' }], fmt: v => String(Math.round(v)) },
  { key: 'kbps', title: 'Stream bandwidth', series: [{ name: 'Bandwidth', col: 'kbps', cls: 's1', area: true }], fmt: v => `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} Mbps` },
  { key: 'down', title: 'Download speed', series: [{ name: 'Download', col: 'downBps', cls: 's1', area: true }], fmt: v => rate(v) },
];
const timeOf = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function trendChart(c, t) {
  const W = 360, H = 130, m = { l: 44, r: 6, t: 8, b: 20 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const n = t[c.series[0].col].length;
  const max = niceMax(Math.max(1, ...c.series.flatMap(s => t[s.col].filter(v => v != null))));
  const x = i => m.l + (i / Math.max(1, n - 1)) * pw;
  const y = v => m.t + ph - (v / max) * ph;
  const f = v => v.toFixed(1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)} over the last 24 hours">`;
  for (let k = 0; k <= 2; k++) {
    const v = (max / 2) * k;
    svg += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${f(y(v))}" y2="${f(y(v))}"/><text class="axis" x="${m.l - 6}" y="${f(y(v) + 3)}" text-anchor="end">${esc(c.fmt(v))}</text>`;
  }
  // x labels every 6 hours on the hour
  for (let i = 0; i < n; i++) {
    const d = new Date(t.start + i * t.step);
    if (d.getMinutes() < t.step / 60e3 && d.getHours() % 6 === 0)
      svg += `<text class="axis" x="${f(x(i))}" y="${H - 5}" text-anchor="middle">${d.toLocaleTimeString(undefined, { hour: 'numeric' })}</text>`;
  }
  for (const s of c.series) {
    const data = t[s.col];
    let line = '', area = '', run = [];
    const flush = () => {
      if (run.length) {
        line += 'M' + run.map(i => `${f(x(i))} ${f(y(data[i]))}`).join('L');
        if (s.area) area += `M${f(x(run[0]))} ${f(y(0))}L` + run.map(i => `${f(x(i))} ${f(y(data[i]))}`).join('L') + `L${f(x(run[run.length - 1]))} ${f(y(0))}Z`;
      }
      run = [];
    };
    data.forEach((v, i) => (v == null ? flush() : run.push(i)));
    flush();
    if (area) svg += `<path class="t-area ${s.cls}" d="${area}"/>`;
    svg += `<path class="t-line ${s.cls}" d="${line}"/>`;
  }
  svg += `<line class="t-cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/>`;
  svg += `<rect class="t-hit" data-chart="${c.key}" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" data-l="${m.l}" data-w="${pw}" data-n="${n}" data-vw="${W}"/></svg>`;
  const legend = c.series.length > 1
    ? `<span class="t-legend">${c.series.map(s => `<span><i class="${s.cls}"></i>${esc(s.name)}</span>`).join('')}</span>` : '';
  return `<div class="trend"><div class="t-head"><h3>${esc(c.title)}</h3>${legend}</div>${svg}</div>`;
}

function renderTrends() {
  const t = hist?.trends;
  const card = $('trends-card');
  if (!t || !t.streams.some(v => v != null)) {
    card.hidden = false;
    return setHTML($('trends'), '<div class="empty">Collecting data — trends appear after the first few minutes.</div>');
  }
  card.hidden = false;
  const partial = t.since && Date.now() - t.since < 23 * 3600e3;
  $('trends-sub').textContent = `last 24 hours${partial ? ` · recording since ${timeOf(t.since)}` : ''}`;
  const peak = t.today && t.today.streams
    ? `<p class="peak">Peak today: <b class="num">${t.today.streams}</b> stream${t.today.streams === 1 ? '' : 's'} at ${timeOf(t.today.streamsAt)} · bandwidth high <b class="num">${mbps(t.today.kbps)}</b> at ${timeOf(t.today.kbpsAt)}</p>` : '';
  setHTML($('trends'), peak + `<div class="trend-grid">${TREND_CHARTS.map(c => trendChart(c, t)).join('')}</div>`);
}

$('trends').addEventListener('mousemove', e => {
  const hit = e.target.closest('.t-hit');
  const svg = e.target.closest('svg');
  $('trends').querySelectorAll('.t-cross').forEach(l => l.setAttribute('visibility', 'hidden'));
  if (!hit || !hist?.trends) { tip.hidden = true; return; }
  const t = hist.trends, c = TREND_CHARTS.find(x => x.key === hit.dataset.chart);
  const box = svg.getBoundingClientRect(), scale = Number(hit.dataset.vw) / box.width;
  const l = Number(hit.dataset.l), w = Number(hit.dataset.w), n = Number(hit.dataset.n);
  const i = Math.max(0, Math.min(n - 1, Math.round((((e.clientX - box.left) * scale - l) / w) * (n - 1))));
  const cross = svg.querySelector('.t-cross'), cx = l + (i / Math.max(1, n - 1)) * w;
  cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
  tip.innerHTML = `<div style="margin-bottom:4px;color:var(--text-secondary)">${timeOf(t.start + i * t.step)}</div>` +
    c.series.map(s => `<div class="r"><span><i class="sw-${s.cls}"></i>${esc(s.name)}</span><b>${t[s.col][i] == null ? 'no data' : esc(c.fmt(t[s.col][i]))}</b></div>`).join('');
  placeTip(e);
});
$('trends').addEventListener('mouseleave', () => {
  tip.hidden = true;
  $('trends').querySelectorAll('.t-cross').forEach(l => l.setAttribute('visibility', 'hidden'));
});

// --------------------------------------------------------------------- TV mode (wall display)
// Big, read-only, full-screen view. /?tv=1 opens straight into it (e.g. for a kiosk browser).
function setTvMode(on) {
  document.body.classList.toggle('tv', on);
  $('tv-toggle').innerHTML = on ? '✕ <span class="hide-sm">Exit TV mode</span>' : '⛶ <span class="hide-sm">TV mode</span>';
  const url = new URL(location.href);
  on ? url.searchParams.set('tv', '1') : url.searchParams.delete('tv');
  history.replaceState(null, '', url);
  lastHTML.clear();
  if (state) render(state);
  tvLayout(on);
  lastHTML.clear();
  if (state) render(state);
}

// TV mode gets its own screen-sized layout instead of the long scrolling page: the headline
// row on top, then what's playing and the stream map on the left, and the things that need
// attention (services, errors, downloads, the server) on the right. Cards are moved into
// the two columns and put back exactly where they were on exit. Anything that doesn't fit is
// cut off rather than scrolled.
const TV_LEFT = ['now-playing', 'map-card'];
const TV_RIGHT = ['services-card', 'events-card', 'downloads-card', 'unraid-card', 'truenas-card'];
const tvHomes = [];
function tvLayout(on) {
  if (on && !tvHomes.length) {
    const cols = document.createElement('div');
    cols.id = 'tv-cols';
    cols.innerHTML = '<div class="tv-col" id="tv-left"></div><div class="tv-col" id="tv-right"></div>';
    $('kpis').after(cols);
    for (const [ids, col] of [[TV_LEFT, 'tv-left'], [TV_RIGHT, 'tv-right']]) for (const id of ids) {
      const el = $(id);
      const home = document.createComment(id);
      el.before(home);
      tvHomes.push([home, el]);
      $(col).append(el);
    }
  } else if (!on && tvHomes.length) {
    for (const [home, el] of tvHomes.splice(0)) home.replaceWith(el);
    $('tv-cols')?.remove();
  }
}
$('tv-toggle').addEventListener('click', async () => {
  const on = !document.body.classList.contains('tv');
  setTvMode(on);
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* full screen not allowed (e.g. iOS); TV mode still works */ }
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('tv')) setTvMode(false); });
setInterval(() => { $('tv-clock').textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }, 1000);
// Hide the mouse pointer after a few idle seconds in TV mode.
let idleTimer;
addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
});
if (new URLSearchParams(location.search).get('tv') === '1') setTvMode(true);


refresh();
loadHistory();
