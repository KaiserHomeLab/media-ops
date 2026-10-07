// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The daily digest: one calm summary of the last 24 hours, sent at the time set under
// Settings → Notifications to every destination with "Daily digest" ticked.
'use strict';
const history = require('./history');

const DAY = 864e5;
const GB = 1024 ** 3;
const size = b => (Math.abs(b) >= 1024 * GB ? `${(b / (1024 * GB)).toFixed(2)} TB` : `${(b / GB).toFixed(1)} GB`);
const time = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dur = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function build(raw, events, now = Date.now()) {
  const up = kind => raw.services.filter(s => s.kind === kind && s.up);
  const yesterday = history.dayKey(now - DAY);
  const lines = [];

  // Plays: Tautulli knows exactly; otherwise fall back to our own peak.
  const t = up('tautulli')[0]?.data.playsByDate;
  const i = t?.dates?.indexOf(yesterday) ?? -1;
  if (i >= 0) {
    const plays = t.series.reduce((a, s) => a + (s.data[i] || 0), 0);
    const parts = t.series.filter(s => s.data[i]).map(s => `${s.data[i]} ${s.name}`);
    lines.push(`📺 ${plays} play${plays === 1 ? '' : 's'} yesterday${parts.length ? ` (${parts.join(', ')})` : ''}`);
  }
  const d = history.dayStats(yesterday);
  if (d?.streams) lines.push(`👥 Peak: ${d.streams} stream${d.streams === 1 ? '' : 's'} at ${time(d.streamsAt)}, ${(d.kbps / 1000).toFixed(0)} Mbps`);

  // What the *arrs imported in the last 24 h.
  const count = kinds => raw.services.filter(s => kinds.includes(s.kind) && s.up)
    .reduce((a, s) => a + (s.data.imports || []).filter(x => now - new Date(x.time) < DAY).length, 0);
  const eps = count(['sonarr']), movies = count(['radarr']);
  if (eps || movies) lines.push(`📥 Added: ${[eps && `${eps} episode${eps === 1 ? '' : 's'}`, movies && `${movies} movie${movies === 1 ? '' : 's'}`].filter(Boolean).join(', ')}`);

  const grew = history.diskGrowth().filter(g => Math.abs(g.delta) > GB).sort((a, b) => b.delta - a.delta);
  if (grew.length) lines.push(`💾 Disk: ${grew.slice(0, 2).map(g => `${g.delta > 0 ? '+' : ''}${size(g.delta)} on ${g.path}`).join(', ')}`);

  const out = history.outages(now - DAY);
  const names = new Map(raw.services.map(s => [s.id, s.name]));
  const downs = Object.entries(out).filter(([id]) => names.has(id)).sort((a, b) => b[1] - a[1]);
  lines.push(downs.length ? `🔴 Downtime: ${downs.map(([id, m]) => `${names.get(id)} ~${dur(m)}`).join(', ')}` : '🟢 No downtime');

  const errs = events.filter(e => !e.dismissed && e.level === 'error' && now - e.t < DAY).length;
  if (errs) lines.push(`⚠️ ${errs} error${errs === 1 ? '' : 's'} in the last 24 h (open the dashboard to review)`);

  const pending = raw.services.filter(s => ['seerr', 'overseerr', 'jellyseerr'].includes(s.kind) && s.up)
    .reduce((a, s) => a + (s.data.stats?.pending || 0), 0);
  if (pending) lines.push(`🙋 ${pending} request${pending === 1 ? '' : 's'} waiting for approval`);

  const ur = up('unraid')[0]?.data;
  if (ur) {
    // Judge heat against each disk's own limit (SSDs run hotter than hard drives).
    const hot = ur.disks.filter(x => x.temp != null && x.temp >= x.tempWarn).map(x => `${x.name} ${x.temp} °C`);
    const p = ur.parity;
    lines.push(`🗄️ Array ${ur.state.toLowerCase()}, ${hot.length ? `running hot: ${hot.join(', ')}` : 'disk temperatures OK'}${p.running ? `, parity check ${p.progress ?? 0}%` : ''}`);
  }
  const tn = up('truenas')[0]?.data;
  if (tn) {
    const bad = tn.pools.filter(p => !p.healthy || p.status !== 'ONLINE').map(p => `${p.name} ${String(p.status).toLowerCase()}`);
    const hot = tn.disks.filter(x => x.temp != null && x.temp >= x.tempWarn).map(x => `${x.name} ${x.temp} °C`);
    const scrub = tn.pools.find(p => p.scan?.state === 'SCANNING');
    lines.push(`🗄️ ${bad.length ? `Pools need attention: ${bad.join(', ')}` : `${tn.pools.length === 1 ? 'Pool' : 'All pools'} healthy`}, ${hot.length ? `running hot: ${hot.join(', ')}` : 'disk temperatures OK'}${scrub ? `, ${scrub.scan.kind.toLowerCase()} of ${scrub.name} ${Math.floor(scrub.scan.progress ?? 0)}%` : ''}${tn.alerts ? `, ${tn.alerts} TrueNAS alert${tn.alerts === 1 ? '' : 's'}` : ''}`);
  }
  return { title: `Media Ops daily digest: ${new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}`, lines };
}

// Called every monitor tick: sends once a day, at or after the configured time.
async function maybeSend(cfg, raw, events, sendDigest, now = new Date()) {
  const dg = cfg.notifications?.digest;
  if (!dg?.enabled) return false;
  const [h, m] = String(dg.time || '08:00').split(':').map(Number);
  const today = history.dayKey(now.getTime());
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + (m || 0) || history.meta('lastDigest') === today) return false;
  history.meta('lastDigest', today);
  await sendDigest(cfg, build(raw, events, now.getTime()));
  return true;
}

module.exports = { build, maybeSend };
