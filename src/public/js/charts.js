// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Charts: Tautulli plays per day and the 24-hour trends, with tooltips and table views.
import { $, esc, mbps, n0, num, placeTip, rate, setHTML, store, sum, timeOf, tip } from './util.js';

// --------------------------------------------------------------------- watch stats (stacked bar chart)
const SERIES_CLASS = ['s1', 's2', 's3'];
const SERIES_VAR = ['--series-1', '--series-2', '--series-3'];

// Axis top = 4 × a "nice" step (1, 2, 5 × 10^n), so every gridline is a whole number.
function niceMax(v) {
  const raw = Math.max(1, v) / 4,
    p = 10 ** Math.floor(Math.log10(raw)),
    n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p * 4;
}
const shortDate = s => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function renderWatch(t) {
  $('watch-card').hidden = !t;
  if (!t) return;
  const { dates, series } = t.data.playsByDate;
  const shown = series.slice(0, 3); // fixed slots: TV, Movies, Music

  setHTML(
    $('plays-legend'),
    shown
      .map(
        (s, i) =>
          `<span><i style="background:var(${SERIES_VAR[i]})"></i>${esc(s.name)} <b class="num">${num(sum(s.data, x => x))}</b></span>`,
      )
      .join(''),
  );

  const W = Math.max(320, $('plays-chart').clientWidth || 600),
    H = 220;
  const m = { l: 30, r: 4, t: 8, b: 22 };
  const pw = W - m.l - m.r,
    ph = H - m.t - m.b;
  const totals = dates.map((_, i) => sum(shown, s => s.data[i]));
  const max = niceMax(Math.max(...totals));
  const step = pw / dates.length,
    bw = Math.max(3, Math.min(22, step - 3));
  const y = v => m.t + ph - (v / max) * ph;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Plays per day for the last 30 days, stacked by media type">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k,
      yy = y(v);
    svg += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="axis" x="${m.l - 6}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  dates.forEach((dt, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = 0;
    const segs = shown.map((s, si) => ({ v: s.data[i] || 0, si })).filter(s => s.v > 0);
    segs.forEach((s, idx) => {
      const y0 = y(base),
        y1 = y(base + s.v);
      const top = idx === segs.length - 1;
      const gap = idx > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const h = Math.max(0, y0 - y1 - gap);
      const yTop = y1,
        r = top ? Math.min(4, bw / 2, h) : 0;
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

  setHTML(
    $('plays-table'),
    `<table class="data"><thead><tr><th>Date</th>${shown.map(s => `<th>${esc(s.name)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${dates
      .map(
        (d, i) =>
          `<tr><td>${shortDate(d)}</td>${shown.map(s => `<td>${s.data[i] || 0}</td>`).join('')}<td>${totals[i]}</td></tr>`,
      )
      .reverse()
      .join('')}</tbody></table>`,
  );

  const list = (title, rows) => {
    if (!rows?.length) return '';
    const top = rows[0].plays || 1;
    return `<div class="toplist"><h3>${title}</h3><ol>${rows
      .map(
        r =>
          `<li><span class="nm">${esc(r.name)}</span><span class="pl">${num(r.plays)}</span><span class="mini"><i style="width:${(r.plays / top) * 100}%"></i></span></li>`,
      )
      .join('')}</ol></div>`;
  };
  setHTML(
    $('toplists'),
    [
      list('Top users', t.data.topUsers),
      list('Top shows', t.data.topShows),
      list('Top movies', t.data.topMovies),
      list('Top platforms', t.data.topPlatforms),
    ].join('') +
      (t.data.mostConcurrent
        ? `<div class="toplist"><h3>Peak concurrent</h3><div class="num" style="font-size:22px;font-weight:600">${num(t.data.mostConcurrent)} streams</div></div>`
        : ''),
  );
}

// Hover tooltips (chart + map). Delegated, so they survive re-renders.

$('plays-chart').addEventListener('mousemove', e => {
  const hit = e.target.closest('.hit');
  const t = store.state?.services.find(s => s.kind === 'tautulli' && s.up);
  if (!hit || !t) {
    tip.hidden = true;
    return;
  }
  const i = Number(hit.dataset.i);
  const { dates, series } = t.data.playsByDate;
  const shown = series.slice(0, 3);
  tip.innerHTML =
    `<div style="margin-bottom:4px;color:var(--text-secondary)">${new Date(dates[i] + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>` +
    shown
      .map(
        (s, si) =>
          `<div class="r"><span><i style="background:var(${SERIES_VAR[si]})"></i>${esc(s.name)}</span><b>${n0(s.data[i])}</b></div>`,
      )
      .join('') +
    `<div class="r" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><b>${n0(sum(shown, s => s.data[i]))}</b></div>`;
  placeTip(e);
});
$('plays-chart').addEventListener('mouseleave', () => (tip.hidden = true));
$('plays-table-toggle').addEventListener('click', e => {
  const table = $('plays-table'),
    showTable = table.hidden;
  table.hidden = !showTable;
  $('plays-chart').hidden = showTable;
  e.target.textContent = showTable ? 'Show as chart' : 'Show as table';
});

// --------------------------------------------------------------------- trends (last 24 h)
// Small multiples, one measure each (never two y-scales on one chart). Gaps = no data.
const TREND_CHARTS = [
  {
    key: 'streams',
    title: 'Streams',
    series: [
      { name: 'Streams', col: 'streams', cls: 's1', area: true },
      { name: 'Transcodes', col: 'transcodes', cls: 's2' },
    ],
    fmt: v => String(Math.round(v)),
  },
  {
    key: 'kbps',
    title: 'Stream bandwidth',
    series: [{ name: 'Bandwidth', col: 'kbps', cls: 's1', area: true }],
    fmt: v => `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} Mbps`,
  },
  {
    key: 'down',
    title: 'Download speed',
    series: [{ name: 'Download', col: 'downBps', cls: 's1', area: true }],
    fmt: v => rate(v),
  },
];

function trendChart(c, t) {
  const W = 360,
    H = 130,
    m = { l: 44, r: 6, t: 8, b: 20 };
  const pw = W - m.l - m.r,
    ph = H - m.t - m.b;
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
    let line = '',
      area = '',
      run = [];
    const flush = () => {
      if (run.length) {
        line += 'M' + run.map(i => `${f(x(i))} ${f(y(data[i]))}`).join('L');
        if (s.area)
          area +=
            `M${f(x(run[0]))} ${f(y(0))}L` +
            run.map(i => `${f(x(i))} ${f(y(data[i]))}`).join('L') +
            `L${f(x(run[run.length - 1]))} ${f(y(0))}Z`;
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
  const legend =
    c.series.length > 1
      ? `<span class="t-legend">${c.series.map(s => `<span><i class="${s.cls}"></i>${esc(s.name)}</span>`).join('')}</span>`
      : '';
  return `<div class="trend"><div class="t-head"><h3>${esc(c.title)}</h3>${legend}</div>${svg}</div>`;
}

export function renderTrends() {
  const t = store.hist?.trends;
  const card = $('trends-card');
  if (!t || !t.streams.some(v => v != null)) {
    card.hidden = false;
    return setHTML(
      $('trends'),
      '<div class="empty">Collecting data — trends appear after the first few minutes.</div>',
    );
  }
  card.hidden = false;
  const partial = t.since && Date.now() - t.since < 23 * 3600e3;
  $('trends-sub').textContent = `last 24 hours${partial ? ` · recording since ${timeOf(t.since)}` : ''}`;
  const peak =
    t.today && t.today.streams
      ? `<p class="peak">Peak today: <b class="num">${t.today.streams}</b> stream${t.today.streams === 1 ? '' : 's'} at ${timeOf(t.today.streamsAt)} · bandwidth high <b class="num">${mbps(t.today.kbps)}</b> at ${timeOf(t.today.kbpsAt)}</p>`
      : '';
  setHTML($('trends'), peak + `<div class="trend-grid">${TREND_CHARTS.map(c => trendChart(c, t)).join('')}</div>`);
}

$('trends').addEventListener('mousemove', e => {
  const hit = e.target.closest('.t-hit');
  const svg = e.target.closest('svg');
  $('trends')
    .querySelectorAll('.t-cross')
    .forEach(l => l.setAttribute('visibility', 'hidden'));
  if (!hit || !store.hist?.trends) {
    tip.hidden = true;
    return;
  }
  const t = store.hist.trends,
    c = TREND_CHARTS.find(x => x.key === hit.dataset.chart);
  const box = svg.getBoundingClientRect(),
    scale = Number(hit.dataset.vw) / box.width;
  const l = Number(hit.dataset.l),
    w = Number(hit.dataset.w),
    n = Number(hit.dataset.n);
  const i = Math.max(0, Math.min(n - 1, Math.round((((e.clientX - box.left) * scale - l) / w) * (n - 1))));
  const cross = svg.querySelector('.t-cross'),
    cx = l + (i / Math.max(1, n - 1)) * w;
  cross.setAttribute('x1', cx);
  cross.setAttribute('x2', cx);
  cross.setAttribute('visibility', 'visible');
  tip.innerHTML =
    `<div style="margin-bottom:4px;color:var(--text-secondary)">${timeOf(t.start + i * t.step)}</div>` +
    c.series
      .map(
        s =>
          `<div class="r"><span><i class="sw-${s.cls}"></i>${esc(s.name)}</span><b>${t[s.col][i] == null ? 'no data' : esc(c.fmt(t[s.col][i]))}</b></div>`,
      )
      .join('');
  placeTip(e);
});
$('trends').addEventListener('mouseleave', () => {
  tip.hidden = true;
  $('trends')
    .querySelectorAll('.t-cross')
    .forEach(l => l.setAttribute('visibility', 'hidden'));
});
