// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Everything the dashboard remembers over time, fed by the background monitor:
//   uptime   15-minute buckets per app, 8 days     -> uptime bars + percentages
//   metrics  one row per minute, 24 hours          -> trend charts
//   daily    peaks per day, 60 days                -> "peak today"
//   disks    one used-bytes sample per day, 180 d  -> "full in ~N weeks" forecast
// Kept in memory and saved to history.json next to config.json every few minutes and on
// shutdown, so a restart loses at most a few minutes.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const BUCKET = 15 * MIN;
const FILE = path.join(path.dirname(config.FILE), 'history.json');

let h = { v: 1, uptime: {}, metrics: [], daily: {}, disks: {}, meta: {} };
let dirty = false;

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (saved.v === 1) h = { ...h, ...saved };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Could not read ${FILE}: ${e.message} — starting fresh history.`);
  }
}

function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(h), { mode: 0o600 });
    fs.renameSync(`${FILE}.tmp`, FILE);
    dirty = false;
  } catch (e) {
    console.error(`Could not save ${FILE}: ${e.message}`);
  }
}

const dayKey = t => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD in server-local time

// Same merge as the Storage panel: what the *arrs report plus the configured paths.
function diskList(raw) {
  const map = new Map();
  for (const s of raw.services) for (const d of s.up ? s.data?.disks || [] : [])
    if (d.totalSpace > 0) map.set(d.path, { path: d.path, total: d.totalSpace, free: d.freeSpace });
  for (const d of raw.disks || []) if (d.total > 0) map.set(d.path, d);
  return [...map.values()];
}

function record(raw) {
  const now = Date.now();

  // Uptime: [polls up, polls total] per 15-minute bucket.
  const b = Math.floor(now / BUCKET) * BUCKET;
  for (const s of raw.services) {
    const u = (h.uptime[s.id] ||= {});
    const cell = (u[b] ||= [0, 0]);
    cell[0] += s.up ? 1 : 0;
    cell[1] += 1;
  }

  // Metrics: one row per minute; within a minute keep the busiest sample.
  const plex = raw.services.find(s => s.kind === 'plex' && s.up);
  const streams = plex?.data.streams || [];
  const dl = raw.services.filter(s => s.up && (s.kind === 'sabnzbd' || s.kind === 'qbittorrent'));
  const row = [
    Math.floor(now / MIN) * MIN,
    streams.length,
    streams.filter(s => s.decision?.startsWith('Transcode')).length,
    streams.reduce((a, s) => a + (s.bandwidth || 0), 0), // kbps
    dl.reduce((a, s) => a + (s.data.downBps || 0), 0),   // bytes/s
  ];
  const last = h.metrics[h.metrics.length - 1];
  if (last && last[0] === row[0]) for (let i = 1; i < row.length; i++) last[i] = Math.max(last[i], row[i]);
  else h.metrics.push(row);

  // Daily peaks.
  const today = (h.daily[dayKey(now)] ||= { streams: 0, streamsAt: null, kbps: 0, kbpsAt: null });
  if (row[1] > today.streams) Object.assign(today, { streams: row[1], streamsAt: now });
  if (row[3] > today.kbps) Object.assign(today, { kbps: row[3], kbpsAt: now });

  // Disks: latest reading of the day.
  for (const d of diskList(raw)) {
    const series = (h.disks[d.path] ||= []);
    const k = dayKey(now);
    const entry = [k, d.total - d.free, d.total];
    if (series.length && series[series.length - 1][0] === k) series[series.length - 1] = entry;
    else series.push(entry);
  }

  prune(now);
  dirty = true;
}

function prune(now) {
  for (const u of Object.values(h.uptime))
    for (const t of Object.keys(u)) if (now - Number(t) > 8 * DAY) delete u[t];
  while (h.metrics.length && now - h.metrics[0][0] > DAY) h.metrics.shift();
  for (const k of Object.keys(h.daily)) if (now - new Date(k).getTime() > 60 * DAY) delete h.daily[k];
  for (const series of Object.values(h.disks)) while (series.length > 180) series.shift();
}

// Uptime for one app: 48 half-hour cells for the last 24 h (null = no data) + percentages.
function uptime(id, now = Date.now()) {
  const u = h.uptime[id] || {};
  const sum = since => {
    let up = 0, total = 0;
    for (const [t, [a, n]] of Object.entries(u)) if (Number(t) >= since) { up += a; total += n; }
    return total ? up / total : null;
  };
  const cells = [];
  const end = Math.floor(now / BUCKET) * BUCKET + BUCKET;
  for (let i = 47; i >= 0; i--) {
    const from = end - (i + 1) * 30 * MIN;
    const parts = [u[from], u[from + BUCKET]].filter(Boolean);
    const total = parts.reduce((a, p) => a + p[1], 0);
    cells.push(total ? parts.reduce((a, p) => a + p[0], 0) / total : null);
  }
  return { cells, day: sum(now - DAY), week: sum(now - 7 * DAY) };
}

// Trend series at 5-minute resolution for the last 24 h.
function trends(now = Date.now()) {
  const step = 5 * MIN;
  const start = Math.floor((now - DAY) / step) * step;
  const n = Math.ceil((now - start) / step);
  const cols = { streams: Array(n).fill(null), transcodes: Array(n).fill(null), kbps: Array(n).fill(null), downBps: Array(n).fill(null) };
  for (const [t, s, tc, kbps, dbps] of h.metrics) {
    const i = Math.floor((t - start) / step);
    if (i < 0 || i >= n) continue;
    cols.streams[i] = Math.max(cols.streams[i] ?? 0, s);
    cols.transcodes[i] = Math.max(cols.transcodes[i] ?? 0, tc);
    cols.kbps[i] = Math.max(cols.kbps[i] ?? 0, kbps);
    cols.downBps[i] = Math.max(cols.downBps[i] ?? 0, dbps);
  }
  return { start, step, ...cols, today: h.daily[dayKey(now)] || null, since: h.metrics[0]?.[0] ?? null };
}

// Least-squares growth over the last 30 daily samples -> days until full.
function forecast(diskPath) {
  const series = (h.disks[diskPath] || []).slice(-30);
  if (series.length < 2) return { status: 'collecting', days: series.length };
  const t0 = new Date(series[0][0]).getTime();
  const xs = series.map(([k]) => (new Date(k).getTime() - t0) / DAY);
  const ys = series.map(([, used]) => used);
  const span = xs[xs.length - 1];
  if (span < 3) return { status: 'collecting', days: Math.round(span) + 1 };
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  const perDay = den ? num / den : 0;
  const [, used, total] = series[series.length - 1];
  if (perDay <= 0) return { status: 'flat', perDay };
  return { status: 'growing', perDay, daysToFull: (total - used) / perDay };
}

const diskPaths = () => Object.keys(h.disks);

// Approximate minutes each app was down since `since` (from the 15-minute buckets).
function outages(since) {
  const out = {};
  for (const [id, u] of Object.entries(h.uptime)) {
    let down = 0;
    for (const [t, [up, n]] of Object.entries(u)) if (Number(t) >= since && n) down += ((n - up) / n) * 15;
    if (down >= 1) out[id] = Math.round(down);
  }
  return out;
}

// Growth between the last two daily disk samples, per path.
function diskGrowth() {
  return Object.entries(h.disks)
    .filter(([, s]) => s.length >= 2)
    .map(([p, s]) => ({ path: p, delta: s[s.length - 1][1] - s[s.length - 2][1] }));
}

const dayStats = key => h.daily[key] || null;
// meta(k) reads a value, meta(k, v) stores one (and marks the file for saving).
function meta(k, v) {
  if (v === undefined) return h.meta?.[k];
  (h.meta ||= {})[k] = v;
  dirty = true;
  return v;
}

module.exports = { load, save, record, uptime, trends, forecast, diskList, diskPaths, outages, diskGrowth, dayStats, dayKey, meta, FILE };
