// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The stream map: viewers on a world map with a line back to the server.
import { $, esc, mbps, placeTip, rollUp, setHTML, tip } from './util.js';

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

export function renderMap(plex) {
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
