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
    if (!r.ok) throw new Error(r.status);
    state = await r.json();
    lastOk = Date.now();
    render(state);
  } catch (e) {
    console.warn('refresh failed', e);
  }
  timer = setTimeout(refresh, (state?.refreshSeconds || 10) * 1000);
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
  const firstRun = !d.demo && !d.configured;
  $('welcome').hidden = !firstRun;
  $('dash').hidden = firstRun;
  $('hostline').textContent = `${d.host.hostname} · ${d.host.platform} · up ${uptime(d.host.uptime)}`;

  renderAlerts(d);
  renderKpis(d, { streams, arrs, clients });
  renderStreams(streams, d.demo);
  renderServices(d.services);
  renderMap(plex);
  renderEvents(d);
  renderLibrary(plex, d.services);
  renderDownloads(clients, arrs);
  renderUpcoming(arrs);
  renderWatch(up('tautulli')[0]);
  renderDisks(d, arrs);
  renderHost(d.host, d.docker);
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
    kpi('Stream bandwidth', mbps(wan + lan).replace(' Mbps', '<small>Mbps</small>'), `WAN ${mbps(wan)} · LAN ${mbps(lan)}`),
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

function renderStreams(streams, demo) {
  $('np-count').textContent = streams.length ? `${streams.length} active` : '';
  if (!streams.length) return setHTML($('streams'), '<div class="empty">Nothing playing. The server is resting.</div>');

  const html = streams.map(s => {
    const poster = s.thumb && !demo
      ? `<img class="poster" loading="lazy" alt="" src="/api/plex/thumb?p=${encodeURIComponent(s.thumb)}" data-fallback="${initials(s.title)}">`
      : `<div class="poster" aria-hidden="true">${initials(s.title)}</div>`;
    const dc = s.decision.startsWith('Transcode') ? 'tc' : s.decision === 'Direct Play' ? 'dp' : 'ds';
    const chips = [
      `<span class="chip ${dc}">${esc(s.decision)}${s.hw && dc === 'tc' ? ' (HW)' : ''}${s.transcodeSpeed ? ` ${s.transcodeSpeed}×` : ''}</span>`,
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
        <div class="row1"><div class="title">${esc(s.title)}</div><span class="state">${s.state === 'paused' ? '❚❚ paused' : s.state === 'buffering' ? '◌ buffering' : '▶ playing'}</span></div>
        <div class="subtitle">${esc(s.subtitle)}</div>
        <div class="who"><b>${esc(s.user)}</b> on ${esc(s.player || s.product)} · ${esc(s.product)}${s.platform ? ` (${esc(s.platform)})` : ''}</div>
        <div class="chips">${chips}</div>
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
  $('svc-count').textContent = `${up}/${services.length} up`;
  setHTML($('services'), services.map(s => {
    const meta = s.up
      ? [s.version && `v${String(s.version).replace(/^v/, '')}`, s.latency != null && `${s.latency}ms`].filter(Boolean).join(' · ')
      : esc(s.error);
    const slow = s.up && s.latency > 1500;
    return `<a class="svc ${s.up ? '' : 'down'}" href="${esc(s.link)}" target="_blank" rel="noopener" title="${esc(s.up ? s.name + ' is up' : s.error)}">
      <span class="dot ${!s.up ? 'down' : slow ? 'warn' : 'up'}" aria-label="${s.up ? 'up' : 'down'}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="meta">${s.up ? '' : '✕ '}${meta}</span>
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
    const kv = rows[s.kind](s.data.stats).map(([k, v, bad]) => `<dt>${k}</dt><dd class="${bad ? 'bad' : ''}">${v}</dd>`).join('');
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
  // zoom level and any card width (the map re-renders on resize).
  const k = vw / Math.max(240, $('map').clientWidth || 800) * 1.3;
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

  $('map-count').textContent = streams.length ? `${remote.length + unknown.length} remote · ${atHome.length} local` : '';

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
  $('ev-count').textContent = active.length ? `${errs} errors · ${active.length - errs} warnings` : '';

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
    const acts = e.dismissed
      ? '<span class="tag">dismissed</span>'
      : `${e.live && (e.healthCheck || e.source === 'Connection') ? `<button class="icon-btn" type="button" data-recheck="${esc(e.svcId)}" title="Re-check ${esc(svc?.name || '')}" aria-label="Re-check ${esc(svc?.name || '')}">↻</button>` : ''}
         <button class="icon-btn" type="button" data-dismiss="${esc(e.key)}" title="Dismiss" aria-label="Dismiss">✕</button>`;
    const cells = `<span class="lvl ${e.level}">${e.level === 'error' ? 'error' : 'warn'}</span>
      <span class="svc-n">${esc(e.svc)}</span>
      <span class="msg"><span class="src" data-svc="${esc(e.svc)}">${esc(e.source)}</span>${esc(e.message)}</span>
      <span class="ago" title="${new Date(e.t).toLocaleString()}">${e.live ? 'active' : ago(e.t)}</span>
      <span class="ev-acts">${acts}</span>`;
    const cls = `ev${e.dismissed ? ' is-dismissed' : ''}`;
    return e.detail
      ? `<details class="${cls}" data-key="${esc(e.key)}"${open.has(e.key) ? ' open' : ''}><summary>${cells}</summary><pre>${esc(e.detail)}</pre></details>`
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
  const b = e.target.closest('[data-dismiss],[data-dismiss-all],[data-restore],[data-recheck],[data-clear],[data-toggle-dismissed]');
  if (!b) return;
  e.preventDefault(); // buttons inside <summary> must not toggle the row
  e.stopPropagation();
  const name = id => state?.services.find(s => s.id === id)?.name || 'app';
  if ('dismiss' in b.dataset) return runAction(b, () => post('/dismiss', { keys: [b.dataset.dismiss] }));
  if ('dismissAll' in b.dataset) return runAction(b, () => post('/dismiss', evFilter.svc === 'all' ? { all: true } : { svcId: evFilter.svc }));
  if ('restore' in b.dataset) return runAction(b, () => post('/restore'));
  if ('recheck' in b.dataset) return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.recheck)}/recheck`));
  if ('toggleDismissed' in b.dataset) { evFilter.showDismissed = !evFilter.showDismissed; return renderEvents(state); }
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
  setHTML($('clients'), clients.map(c => {
    const d = c.data;
    const x = c.kind === 'qbittorrent'
      ? `${num(d.torrents)} torrents · ratio ${d.ratio?.toFixed(2) ?? '—'} · ${bytes(d.allTimeUp)} seeded`
      : `${d.paused ? 'PAUSED' : esc(d.status)}${d.totals ? ` · today ${bytes(d.totals.day)} · month ${bytes(d.totals.month)}` : ''}`;
    return `<div class="client"><h3>${esc(c.name)}</h3>
      <div class="speeds"><span class="down">${rate(d.downBps)}</span>${c.kind === 'qbittorrent' ? `<span class="up">${rate(d.upBps)}</span>` : ''}</div>
      <div class="x">${x}</div></div>`;
  }).join(''));

  // Prefer the *arr queues (clean titles); fall back to raw client items when no arr is grabbing anything.
  let items = arrs.flatMap(a => a.data.queue.map(q => ({ ...q, source: a.name })));
  if (!items.length) items = clients.flatMap(c => c.data.items.map(q => ({ ...q, source: c.name })));
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
  ].join('') + (t.data.mostConcurrent ? `<div class="toplist"><h3>Peak concurrent</h3><div class="num" style="font-size:22px;font-weight:600">${t.data.mostConcurrent} streams</div></div>` : ''));
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
    shown.map((s, si) => `<div class="r"><span><i style="background:var(${SERIES_VAR[si]})"></i>${esc(s.name)}</span><b>${s.data[i] || 0}</b></div>`).join('') +
    `<div class="r" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><b>${sum(shown, s => s.data[i])}</b></div>`;
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
    return `<div class="disk ${cls}">
      <div class="row1"><span class="p">${cls ? '⚠ ' : ''}${esc(k.path)}${k.label && k.label !== k.path ? ` <span class="muted">${esc(k.label)}</span>` : ''}</span>
      <span class="m">${bytes(used)} / ${bytes(k.total)} · ${bytes(k.free)} free · ${pct.toFixed(0)}%</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
  }).join(''));
}

function renderHost(h, docker) {
  $('host-name').textContent = h.hostname;
  const memPct = (h.memUsed / h.memTotal) * 100;
  const cell = (k, v, pct) => `<div class="h"><div class="k">${k}</div><div class="v">${v}</div>${pct != null ? `<div class="bar"><i style="width:${Math.min(100, pct).toFixed(0)}%"></i></div>` : ''}</div>`;
  setHTML($('host'), [
    cell('CPU', h.cpu != null ? `${h.cpu}%` : '—', h.cpu),
    cell('Memory', `${bytes(h.memUsed)}`, memPct),
    cell(`Load (${h.cpus} cores)`, h.load.map(l => l.toFixed(2)).join(' ')),
    cell('Uptime', uptime(h.uptime)),
  ].join(''));

  if (!docker) return setHTML($('docker'), '');
  if (docker.error) return setHTML($('docker'), `<div class="empty">Docker: ${esc(docker.error)}</div>`);
  setHTML($('docker'), docker.map(c => {
    const cls = c.state !== 'running' ? 'down' : c.health === 'unhealthy' ? 'warn' : 'up';
    return `<div class="ctr" title="${esc(c.image)}"><span class="dot ${cls}" aria-label="${esc(c.state)}"></span><span class="n">${esc(c.name)}</span><span class="s">${esc(c.status)}</span></div>`;
  }).join(''));
}

refresh();
