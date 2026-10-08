// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The server itself: disks, host stats and containers, Unraid and TrueNAS.
import { $, bytes, esc, n0, setHTML, store, uptime } from './util.js';

// --------------------------------------------------------------------- storage / host
// Disks come from two places: what each *arr reports via its API, and the paths configured
// under Settings (statfs inside this container). Merged by path.
const duration = days =>
  days < 14
    ? `${Math.max(1, Math.round(days))} days`
    : days < 120
      ? `${Math.round(days / 7)} weeks`
      : days < 730
        ? `${Math.round(days / 30)} months`
        : `${(days / 365).toFixed(1)} years`;

export function renderDisks(d, arrs) {
  const map = new Map();
  for (const a of arrs)
    for (const k of a.data.disks || [])
      if (k.totalSpace > 0) map.set(k.path, { path: k.path, label: k.label, total: k.totalSpace, free: k.freeSpace });
  for (const k of d.disks || []) if (k.total > 0) map.set(k.path, k);
  // Collapse mounts that are the same filesystem seen through different paths.
  const seen = new Set();
  const disks = [...map.values()]
    .filter(k => {
      const sig = `${k.total}:${Math.round(k.free / 1e8)}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    })
    .sort((a, b) => b.total - a.total);

  if (!disks.length)
    return setHTML(
      $('disks'),
      '<div class="empty">No disk info yet — it comes from the *arrs or the "paths" config.</div>',
    );
  setHTML(
    $('disks'),
    disks
      .map(k => {
        const used = k.total - k.free,
          pct = (used / k.total) * 100;
        const cls = pct > 95 ? 'crit' : pct > 85 ? 'warn' : '';
        const fc = store.hist?.forecasts?.[k.path];
        const soon = fc?.status === 'growing' && fc.daysToFull < 30;
        const fcText = !fc
          ? ''
          : fc.status === 'growing'
            ? `${soon ? '⚠ ' : ''}Full in ~${duration(fc.daysToFull)} at +${bytes(fc.perDay)}/day`
            : fc.status === 'flat'
              ? 'Not growing'
              : `Forecast after 3 days of data (day ${fc.days})`;
        return `<div class="disk ${cls}">
      <div class="row1"><span class="p">${cls ? '⚠ ' : ''}${esc(k.path)}${k.label && k.label !== k.path ? ` <span class="muted">${esc(k.label)}</span>` : ''}</span>
      <span class="m">${bytes(used)} / ${bytes(k.total)} · ${bytes(k.free)} free · ${pct.toFixed(0)}%</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      ${fcText ? `<div class="fc${soon ? ' soon' : ''}">${fcText}</div>` : ''}</div>`;
      })
      .join(''),
  );
}

const vmNote =
  "On Windows and Mac, Docker runs containers inside a small Linux VM, so this is the VM's share, not the whole computer's. In Docker Desktop you can change it under Settings → Resources.";

export function renderHost(h, docker, gpus = [], plexRes = null) {
  $('host-name').textContent = h.hostname;
  const memPct = (h.memUsed / h.memTotal) * 100;
  const cell = (k, v, pct, title = '') =>
    `<div class="h"${title ? ` title="${esc(title)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div>${pct != null ? `<div class="bar"><i style="width:${Math.min(100, pct).toFixed(0)}%"></i></div>` : ''}</div>`;
  setHTML(
    $('host'),
    [
      // On Windows and Mac containers run in a small VM; these numbers are the VM's.
      cell(h.vm ? 'CPU (Docker VM)' : 'CPU', h.cpu != null ? `${h.cpu}%` : '—', h.cpu, h.vm ? vmNote : ''),
      cell(h.vm ? 'Memory (Docker VM)' : 'Memory', `${bytes(h.memUsed)}`, memPct, h.vm ? vmNote : ''),
      cell(`Load (${h.cpus} cores)`, h.load.map(l => l.toFixed(2)).join(' ')),
      cell(h.vm ? 'VM uptime' : 'Uptime', uptime(h.uptime)),
      plexRes?.plexCpu != null &&
        cell(
          'Plex CPU',
          `${Math.round(plexRes.plexCpu)}%`,
          plexRes.plexCpu,
          `Plex Media Server's own CPU use (host total ${Math.round(plexRes.hostCpu)}%)`,
        ),
      ...gpus.map(g =>
        cell(
          esc(g.name),
          g.busy != null ? `${g.busy}%` : g.freqMhz != null ? `${g.freqMhz} MHz` : '—',
          g.busy ?? (g.freqMhz && g.maxMhz ? (g.freqMhz / g.maxMhz) * 100 : null),
          [
            g.busy != null && `${g.busy}% busy`,
            g.freqMhz && `${g.freqMhz}${g.maxMhz ? ` of ${g.maxMhz}` : ''} MHz`,
            g.temp != null && `${g.temp} °C`,
            g.encoderSessions != null && `${g.encoderSessions} encode sessions`,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    ]
      .filter(Boolean)
      .join(''),
  );

  if (!docker) return setHTML($('docker'), '');
  if (docker.error) return setHTML($('docker'), `<div class="empty">Docker: ${esc(docker.error)}</div>`);
  setHTML(
    $('docker'),
    docker
      .map(c => {
        const cls = c.state !== 'running' ? 'down' : c.health === 'unhealthy' ? 'warn' : 'up';
        return `<div class="ctr" title="${esc(c.image)}"><span class="dot ${cls}" aria-label="${esc(c.state)}"></span><span class="n">${esc(c.name)}</span><span class="s">${esc(c.status)}</span></div>`;
      })
      .join(''),
  );
}

// --------------------------------------------------------------------- Unraid
export function renderUnraid(u) {
  $('unraid-card').hidden = !u;
  if (!u) return;
  const d = u.data;
  $('unraid-sub').textContent =
    `${d.server ? `${d.server} · ` : ''}v${u.version || '?'} · array ${d.state.toLowerCase().replace(/_/g, ' ')} · ${bytes(d.capacity.used)} of ${bytes(d.capacity.total)} used`;
  const p = d.parity;
  const when = p.date ? new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  setHTML(
    $('unraid-parity'),
    p.running || p.paused
      ? `<div class="row1"><span><b>Parity ${p.correcting ? 'check (correcting)' : 'check'}</b> ${p.paused ? '· paused' : ''}</span><span class="m">${n0(p.progress)}%${p.speed ? ` · ${esc(p.speed)}` : ''} · ${n0(p.errors)} errors</span></div><div class="bar"><i style="width:${n0(p.progress)}%"></i></div>`
      : `<div class="row1"><span><b>Parity</b> ${p.status === 'NEVER_RUN' ? '· never checked' : `· last check ${esc((p.status || '').toLowerCase())}${when ? ` ${when}` : ''}`}</span><span class="m ${p.errors ? 'hot' : ''}">${p.errors ? `⚠ ${n0(p.errors)} errors` : '0 errors'}</span></div>`,
  );
  setHTML(
    $('unraid-disks'),
    d.disks
      .map(k => {
        const pct = k.used != null && k.size ? (k.used / k.size) * 100 : null;
        const hot =
          k.temp != null && k.temp >= k.tempCrit ? 'crit' : k.temp != null && k.temp >= k.tempWarn ? 'warn' : '';
        const full =
          pct != null && k.fullCrit && pct >= k.fullCrit
            ? 'crit'
            : pct != null && k.fullWarn && pct >= k.fullWarn
              ? 'warn'
              : '';
        const bad = k.status !== 'DISK_OK';
        return `<div class="udisk ${bad ? 'bad' : ''}" title="${esc(`${k.name} · ${k.role}${k.ssd ? ' (SSD)' : ''} · ${bytes(k.size)}${k.temp != null ? ` · ${k.temp} °C (warn ${k.tempWarn}, critical ${k.tempCrit})` : ''}`)}">
      <div class="row1"><b>${esc(k.name)}</b><span class="role">${esc(k.role)}</span></div>
      <div class="temp ${hot}">${k.temp != null ? `${hot ? '⚠ ' : ''}${n0(k.temp)} °C` : k.spinning === false ? '◌ spun down' : '—'}</div>
      ${pct != null ? `<div class="bar ${full}"><i style="width:${pct.toFixed(0)}%"></i></div><div class="m">${pct.toFixed(0)}% of ${bytes(k.size)}</div>` : `<div class="m">${bytes(k.size)}</div>`}
      ${bad ? `<div class="m hot">✕ ${esc(k.status.replace('DISK_', '').toLowerCase())}</div>` : k.errors ? `<div class="m hot">⚠ ${k.errors} errors</div>` : ''}
    </div>`;
      })
      .join(''),
  );
}

// --------------------------------------------------------------------- TrueNAS
const udiskTile = k => {
  const hot = k.temp != null && k.temp >= k.tempCrit ? 'crit' : k.temp != null && k.temp >= k.tempWarn ? 'warn' : '';
  return `<div class="udisk" title="${esc(`${k.name}${k.model ? ` · ${k.model}` : ''} · ${k.ssd ? 'SSD' : 'HDD'} · ${bytes(k.size)}${k.temp != null ? ` · ${k.temp} °C (warn ${k.tempWarn}, critical ${k.tempCrit})` : ''}`)}">
    <div class="row1"><b>${esc(k.name)}</b><span class="role">${esc(k.role)}</span></div>
    <div class="temp ${hot}">${k.temp != null ? `${hot ? '⚠ ' : ''}${n0(k.temp)} °C` : '—'}</div>
    <div class="m">${k.ssd ? 'SSD' : 'HDD'} · ${bytes(k.size)}</div>
  </div>`;
};

export function renderTrueNAS(t) {
  $('truenas-card').hidden = !t;
  if (!t) return;
  const d = t.data;
  $('truenas-sub').textContent = [
    d.server,
    t.version && `v${t.version}`,
    `${d.pools.length} pool${d.pools.length === 1 ? '' : 's'}`,
    d.capacity.total ? `${bytes(d.capacity.used)} of ${bytes(d.capacity.total)} used` : null,
    d.alerts ? `${d.alerts} alert${d.alerts === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  setHTML(
    $('truenas-pools'),
    d.pools
      .map(p => {
        const pct = p.size ? (p.used / p.size) * 100 : null;
        const fill = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''; // TrueNAS's own warning / critical levels
        const sc = p.scan;
        const scanning = sc?.state === 'SCANNING';
        const scanLine = !sc
          ? 'never scrubbed'
          : scanning
            ? `${sc.kind === 'RESILVER' ? 'resilvering' : 'scrubbing'} ${Math.floor(sc.progress ?? 0)}%`
            : `last ${sc.kind.toLowerCase()} ${sc.state === 'CANCELED' ? 'canceled' : sc.end ? new Date(sc.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'finished'} · ${sc.errors ? `⚠ ${sc.errors} errors` : '0 errors'}`;
        return `<div class="pool ${p.healthy && p.status === 'ONLINE' ? '' : 'bad'}">
      <div class="row1"><b>${esc(p.name)}</b><span class="pool-st ${p.healthy && p.status === 'ONLINE' ? 'ok' : 'bad'}">${p.healthy && p.status === 'ONLINE' ? '✓' : '✕'} ${esc(String(p.status || '').toLowerCase())}</span></div>
      ${
        pct != null
          ? `<div class="bar ${fill}"><i style="width:${pct.toFixed(0)}%"></i></div>
      <div class="m">${bytes(p.used)} of ${bytes(p.size)} · ${pct.toFixed(0)}%</div>`
          : ''
      }
      ${scanning ? `<div class="bar scan"><i style="width:${(sc.progress ?? 0).toFixed(1)}%"></i></div>` : ''}
      <div class="m ${sc?.errors ? 'hot' : ''}">${esc(scanLine)}</div>
    </div>`;
      })
      .join(''),
  );

  setHTML($('truenas-disks'), d.disks.map(udiskTile).join(''));

  const apps = d.apps || [];
  const running = apps.filter(a => a.state === 'RUNNING').length;
  const notRunning = apps.filter(a => a.state !== 'RUNNING');
  const updates = apps.filter(a => a.upgrade).length;
  setHTML(
    $('truenas-apps'),
    apps.length
      ? `<span class="muted">Apps</span> <b>${running}</b> running${notRunning.length ? ` · ${notRunning.map(a => `<span class="chip ${a.state === 'CRASHED' ? 'bad' : ''}">${esc(a.name)} ${esc(a.state.toLowerCase())}</span>`).join(' ')}` : ''}${updates ? ` · <span class="muted">${updates} update${updates === 1 ? '' : 's'} available</span>` : ''}`
      : '',
  );
}
