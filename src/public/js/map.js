// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The stream map: viewers on a world map with a line back to the server. Viewers it can't
// place go to Asgard, up in the sky, down the beam of the Bifröst (Settings can turn the joke off).
import { $, closest, esc, mbps, placeTip, rollUp, setHTML, tip } from './util.js';

// --------------------------------------------------------------------- stream map
// Remote viewers are placed by city (Plex GeoIP, looked up server-side); LAN viewers sit at
// the home pin. Coastlines are pre-projected in world-map.js with the same projection.
const MAP_GRATICULE = (() => {
  if (!window.MapProjection) return '';
  const { project, LAT_TOP, LAT_BOTTOM } = MapProjection;
  /** @param {[number, number][]} pts longitude, latitude */
  const line = pts =>
    'M' +
    pts
      .map(([lon, lat]) =>
        project(lon, lat)
          .map(v => v.toFixed(1))
          .join(' '),
      )
      .join('L');
  let d = '';
  for (let lon = -180; lon <= 180; lon += 30) {
    /** @type {[number, number][]} */
    const pts = [];
    for (let lat = LAT_BOTTOM; lat <= LAT_TOP; lat += 4) pts.push([lon, lat]);
    d += line(pts);
  }
  for (let lat = -30; lat <= 60; lat += 30) {
    /** @type {[number, number][]} */
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 5) pts.push([lon, lat]);
    d += line(pts);
  }
  return d;
})();

/** @typedef {{ x: number, y: number, geo: any, streams: any[] }} Cluster viewers in one place */
/** @type {{ clusters: Cluster[], atHome: any[], home: any, unknown: any[] }} */
let mapModel = { clusters: [], atHome: [], home: null, unknown: [] };
/** @param {any} g a geo lookup result */
const place = g =>
  [g.city, g.region && g.region !== g.city ? g.region : null, g.code || g.country].filter(Boolean).join(', ');
/** @param {any} s */
const streamLine = s =>
  `<b>${esc(s.user)}</b> · ${esc(s.title)}${s.subtitle && s.type !== 'movie' ? ` <span class="muted">${esc(s.subtitle.split(' · ')[0])}</span>` : ''}`;

// Why a remote viewer has no location (lib/geo.js sets `geoWhy`): a short note for the list,
// and a longer one on hover.
/** @type {Record<string, [string, string]>} */
const UNKNOWN_WHY = {
  'not-plex': [
    'Jellyfin/Emby',
    "Viewers on Jellyfin or Emby aren't looked up: their address would have to go to plex.tv, a third party to them.",
  ],
  private: [
    'private address',
    'The media server only sees a private address for this viewer, so there is nothing to look up. This happens when they connect through a VPN or Tailscale, or when a reverse proxy or tunnel sits in front of the server.',
  ],
  'no-location': [
    'no GeoIP match',
    "Plex's GeoIP service doesn't know where this address is (common for some mobile networks).",
  ],
  failed: ['lookup failed', 'Looking the address up at plex.tv failed; it is tried again in 10 minutes.'],
};

// src: { streams, home, enabled } from util.js mapSource(), or null without a media server.
/** @param {ReturnType<typeof import('./util.js').mapSource>} src */
export function renderMap(src) {
  const show = !!src && src.enabled && !!window.WORLD_MAP;
  $('map-card').hidden = !show;
  if (!show) return;

  if (rollUp('map-card', !src.streams.length)) {
    $('map-count').textContent = 'nobody watching';
    return;
  }

  const { project } = MapProjection;
  const { width: W, height: H, land } = WORLD_MAP;
  const { streams, home } = src;
  const remote = streams.filter(s => !s.local && s.geo);
  const atHome = streams.filter(s => s.local);
  const unknown = streams.filter(s => !s.local && !s.geo);

  // Viewers within a few px of each other (same city) share one numbered dot.
  /** @type {Cluster[]} */
  const clusters = [];
  for (const s of remote) {
    const [x, y] = project(s.geo.lon, s.geo.lat);
    const near = clusters.find(c => Math.hypot(c.x - x, c.y - y) < 12);
    if (near) near.streams.push(s);
    else clusters.push({ x, y, geo: s.geo, streams: [s] });
  }
  const hp = home ? project(home.lon, home.lat) : null;
  mapModel = { clusters, atHome, home, unknown };

  // Zoom to fit home + viewers (never tighter than ~a third of the world); whole world when
  // nobody remote is watching. k converts "screen-sized" marks into map units at this zoom.
  const pts = [...clusters.map(c => [c.x, c.y]), ...(hp ? [hp] : [])];
  let vx = 0,
    vy = 0,
    vw = W,
    vh = H;
  if (clusters.length) {
    const xs = pts.map(p => p[0]),
      ys = pts.map(p => p[1]),
      pad = 70;
    const bw = Math.max(...xs) - Math.min(...xs),
      bh = Math.max(...ys) - Math.min(...ys);
    vw = Math.min(W, Math.max(300, bw + 2 * pad, ((bh + 2 * pad) * W) / H));
    vh = (vw * H) / W;
    vx = Math.min(W - vw, Math.max(0, (Math.min(...xs) + Math.max(...xs)) / 2 - vw / 2));
    vy = Math.min(H - vh, Math.max(0, (Math.min(...ys) + Math.max(...ys)) / 2 - vh / 2));
  }
  // k = map units per screen pixel, so dots and labels keep the same on-screen size at any
  // zoom level and any card width (the map re-renders on resize). In TV mode the map is fitted
  // into a fixed-height box, so the height can be what limits it.
  const mapEl = $('map');
  const tvFit = document.body.classList.contains('tv') && mapEl.clientHeight > 60 ? vh / mapEl.clientHeight : 0;
  const k = Math.max(vw / Math.max(240, mapEl.clientWidth || 800), tvFit) * 1.3;
  /** @param {number} v */
  const f = v => v.toFixed(1);
  let svg = `<svg viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}" role="img" aria-label="World map: ${remote.length} remote and ${atHome.length} local streams${unknown.length ? `, ${unknown.length} without a location` : ''}">`;
  svg += `<path class="grat" d="${MAP_GRATICULE}"/><path class="land" d="${land}"/>`;

  // Asgard: high in the sky of whatever part of the world is in view, straight above home.
  const asgard =
    src.asgard && unknown.length
      ? {
          x: Math.min(vx + vw * 0.9, Math.max(vx + vw * 0.1, hp ? hp[0] : vx + vw / 2)),
          y: vy + vh * 0.08,
          r: 7 * k,
        }
      : null;
  // The Bifröst: a beam of light from Asgard down to the server. Layers, back to front: a blurred
  // iridescent glow, the beam, a white-hot core, and sparks racing up it; where it lands, a
  // glowing ring with turning runes. Blur and gradient use map coordinates (userSpaceOnUse)
  // because a vertical line's bounding box has no width.
  if (asgard) {
    const [x1, y1] = hp || [asgard.x, asgard.y];
    const { x: x2, y: y2 } = asgard;
    const m = 100 * k; // room for the blur
    const fx = Math.min(x1, x2) - m,
      fy = Math.min(y1, y2) - m;
    svg += `<defs>
      <linearGradient id="bifrost-grad" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">
        <stop offset="0" class="bf-s1"/><stop offset="0.3" class="bf-s2"/><stop offset="0.55" class="bf-s3"/><stop offset="0.8" class="bf-s4"/><stop offset="1" class="bf-s5"/>
      </linearGradient>
      <filter id="bifrost-blur" filterUnits="userSpaceOnUse" x="${f(fx)}" y="${f(fy)}" width="${f(Math.abs(x2 - x1) + 2 * m)}" height="${f(Math.abs(y2 - y1) + 2 * m)}">
        <feGaussianBlur stdDeviation="${f(4 * k)}"/>
      </filter>
      <filter id="bifrost-haze" filterUnits="userSpaceOnUse" x="${f(fx)}" y="${f(fy)}" width="${f(Math.abs(x2 - x1) + 2 * m)}" height="${f(Math.abs(y2 - y1) + 2 * m)}">
        <feGaussianBlur stdDeviation="${f(12 * k)}"/>
      </filter>
    </defs>`;
    let beam = '';
    if (hp) {
      const d = `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
      beam =
        `<circle class="bf-land-glow" cx="${f(x1)}" cy="${f(y1)}" r="${f(18 * k)}" filter="url(#bifrost-haze)"/>` +
        `<circle class="bf-runes" cx="${f(x1)}" cy="${f(y1)}" r="${f(12 * k)}" pathLength="100" style="stroke-width:${f(1.6 * k)}"/>` +
        `<path class="bf-haze" d="${d}" stroke="url(#bifrost-grad)" style="stroke-width:${f(40 * k)}" filter="url(#bifrost-haze)"/>` +
        `<path class="bf-glow" d="${d}" stroke="url(#bifrost-grad)" style="stroke-width:${f(16 * k)}" filter="url(#bifrost-blur)"/>` +
        `<path class="bf-beam" d="${d}" stroke="url(#bifrost-grad)" style="stroke-width:${f(5 * k)}"/>` +
        `<path class="bf-core" d="${d}" style="stroke-width:${f(1.5 * k)}"/>` +
        `<path class="bf-spark" d="${d}" pathLength="100" style="stroke-width:${f(2.4 * k)}"/>`;
    }
    svg += `<g class="bifrost">${beam}<circle class="asgard-glow" cx="${f(x2)}" cy="${f(y2)}" r="${f(16 * k)}" filter="url(#bifrost-haze)"/></g>`;
  }

  // Arcs from the server to each viewer, bowed toward the pole so they read as flight paths.
  if (hp)
    for (const c of clusters) {
      const [x1, y1] = hp,
        dist = Math.hypot(c.x - x1, c.y - y1);
      if (dist < 4 * k) continue;
      const paused = c.streams.every(s => s.state === 'paused');
      svg += `<path class="arc${paused ? ' paused' : ''}" d="M${f(x1)} ${f(y1)}Q${f((x1 + c.x) / 2)} ${f((y1 + c.y) / 2 - dist * 0.28)} ${f(c.x)} ${f(c.y)}"/>`;
    }

  // Labels: try right, left, above, below each mark and skip any that would collide.
  // (The list beside the map always names everyone, so a skipped label loses nothing.)
  const marks = clusters.map(c => ({ ...c, r: (5 + Math.min(c.streams.length - 1, 3) * 1.5) * k }));
  const taken = [
    ...marks.map(m => [m.x - m.r, m.y - m.r, m.x + m.r, m.y + m.r]),
    ...(asgard ? [[asgard.x - asgard.r, asgard.y - asgard.r, asgard.x + asgard.r, asgard.y + asgard.r]] : []),
    ...(hp ? [[hp[0] - 7 * k, hp[1] - 7 * k, hp[0] + 7 * k, hp[1] + 7 * k]] : []),
  ];
  /** @param {number[]} b a box: left, top, right, bottom */
  const overlaps = b => taken.some(t => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
  /** @param {number[]} b */
  const fits = b => b[0] >= vx && b[2] <= vx + vw && b[1] >= vy && b[3] <= vy + vh;
  /** @param {number} x @param {number} y @param {number} r @param {string} text @param {string} [cls] */
  const label = (x, y, r, text, cls = '') => {
    const w = text.length * 6.4 * k,
      h = 13 * k,
      gap = 5 * k;
    /** @type {[number, number, string, number, number][]} box left/top, text-anchor, text x/y */
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
  if (asgard) {
    // A five-pointed star.
    const star = Array.from({ length: 10 }, (_, i) => {
      const a = (Math.PI / 5) * i - Math.PI / 2,
        r = i % 2 ? asgard.r * 0.45 : asgard.r * 1.15;
      return `${f(asgard.x + r * Math.cos(a))},${f(asgard.y + r * Math.sin(a))}`;
    }).join(' ');
    svg += `<polygon class="asgard" points="${star}"/>`;
    labels += label(
      asgard.x,
      asgard.y,
      asgard.r,
      `Asgard${unknown.length > 1 ? ` · ${unknown.length}` : ''}`,
      'asgard',
    );
  }
  svg += labels;
  // Hit targets bigger than the marks, drawn last so they sit on top.
  if (asgard) svg += `<circle class="hit" data-asgard cx="${f(asgard.x)}" cy="${f(asgard.y)}" r="${f(14 * k)}"/>`;
  if (hp) svg += `<circle class="hit" data-home cx="${f(hp[0])}" cy="${f(hp[1])}" r="${f(14 * k)}"/>`;
  marks.forEach(
    (m, i) => (svg += `<circle class="hit" data-i="${i}" cx="${f(m.x)}" cy="${f(m.y)}" r="${f(14 * k)}"/>`),
  );
  svg += '</svg>';
  setHTML($('map'), svg);

  $('map-count').textContent = streams.length
    ? `${remote.length + unknown.length} remote · ${atHome.length} local`
    : 'nobody watching';

  // Side list doubles as the text alternative to the map.
  /** @param {string} cls @param {any} s @param {string} where already-escaped HTML @param {string} [why] a longer explanation */
  const li = (cls, s, where, why = '') =>
    `<li${why ? ` title="${esc(why)}"` : ''}><span class="sw ${cls}" aria-hidden="true"></span><span>${streamLine(s)}</span><span class="where">${where}</span></li>`;
  const rows = [
    ...remote.map(s =>
      li(
        s.state === 'paused' ? 'paused' : '',
        s,
        `${esc(place(s.geo))}${s.bandwidth ? ` · ${mbps(s.bandwidth)}` : ''}`,
      ),
    ),
    ...atHome.map(s => li('home', s, `Home network${s.bandwidth ? ` · ${mbps(s.bandwidth)}` : ''}`)),
    ...unknown.map(s => {
      const [short, long] = UNKNOWN_WHY[s.geoWhy] || UNKNOWN_WHY.failed;
      return src.asgard
        ? li('asgard', s, `Asgard · location unknown · ${esc(short)}`, long)
        : li('unknown', s, `Remote · location unknown · ${esc(short)}`, long);
    }),
  ];
  setHTML($('viewers'), rows.join('') || '<li class="muted">Nobody is watching right now.</li>');
  setHTML(
    $('map-legend'),
    [
      'Dots are remote viewers and pulse while playing. Lines run from your server; the ring is home.',
      'Locations are city-level, from Plex’s own GeoIP lookup.',
      asgard ? 'Viewers who can’t be placed are in Asgard (the star); the list says why.' : '',
      home ? '' : '<br><b>Home location unknown.</b> Set it under <a href="/settings">Settings → General</a>.',
    ].join(' '),
  );
}

$('map').addEventListener('mousemove', e => {
  const hit = closest(e, '.hit');
  if (!hit) {
    tip.hidden = true;
    return;
  }
  if ('asgard' in hit.dataset) {
    tip.innerHTML =
      `<div style="margin-bottom:4px"><b>Asgard</b> <span class="muted">· no place on Midgard</span></div>` +
      mapModel.unknown
        .map(s => {
          const [short] = UNKNOWN_WHY[s.geoWhy] || UNKNOWN_WHY.failed;
          return `<div>${streamLine(s)}</div><div class="muted" style="margin-bottom:4px">Location unknown · ${esc(short)}</div>`;
        })
        .join('') +
      '<div class="muted">Heimdall let them across the Bifröst.</div>';
  } else if ('home' in hit.dataset) {
    const h = mapModel.home;
    tip.innerHTML =
      `<div style="margin-bottom:4px"><b>Your server</b>${h?.city ? ` · ${esc(place(h))}` : ''}</div>` +
      (mapModel.atHome.length
        ? mapModel.atHome.map(s => `<div>${streamLine(s)}</div>`).join('')
        : '<div class="muted">No local streams</div>');
  } else {
    const c = mapModel.clusters[Number(hit.dataset.i)];
    tip.innerHTML =
      `<div style="margin-bottom:4px;color:var(--text-secondary)">${esc(place(c.geo))}</div>` +
      c.streams
        .map(
          s =>
            `<div>${streamLine(s)}</div><div class="muted" style="margin-bottom:4px">${esc(s.decision)}${s.bandwidth ? ` · ${mbps(s.bandwidth)}` : ''} · ${esc(s.product || '')}</div>`,
        )
        .join('');
  }
  placeTip(e);
});
$('map').addEventListener('mouseleave', () => (tip.hidden = true));
