// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Unraid (official GraphQL API): array, parity check and disks.
'use strict';
const { join, req, timed } = require('../http');

// Unraid 7.2+ (or the Unraid Connect plugin): POST /graphql with an API key from
// Settings → Management Access → API Keys. A read-only "viewer" key is enough.
const UNRAID_QUERY = `query MediaOps {
  vars { version name }
  array {
    state
    capacity { kilobytes { free used total } }
    parityCheckStatus { status progress errors running paused speed date duration correcting }
    parities { name status temp numErrors warning critical isSpinning size rotational }
    disks { name status temp numErrors warning critical isSpinning size fsSize fsFree fsUsed rotational }
    caches { name status temp numErrors warning critical isSpinning size fsSize fsFree fsUsed rotational }
  }
}`;
const DISK_PROBLEM = {
  DISK_DSBL: 'is disabled', DISK_NP_DSBL: 'is disabled and missing', DISK_NP_MISSING: 'is missing',
  DISK_INVALID: 'is invalid', DISK_WRONG: 'is the wrong disk', DISK_DSBL_NEW: 'is disabled (new disk)',
};
async function unraid(cfg) {
  const [r, latency] = await timed(() => req(join(cfg.url, '/graphql'), {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: UNRAID_QUERY }),
  }));
  if (!r.data?.array) throw new Error(r.errors?.[0]?.message || 'Unraid API returned no array data');
  const a = r.data.array;
  const kb = v => Number(v || 0) * 1024;
  // Sizes are in KiB. `warning`/`critical` are Unraid's disk-*utilization* thresholds (% full);
  // the API has no temperature thresholds, so use Unraid's defaults: 45/55 °C for hard
  // drives, 60/70 °C for SSDs (which run hotter).
  const disk = role => d => {
    const ssd = d.rotational === false;
    return {
      name: d.name, role, status: d.status, temp: Number.isFinite(d.temp) ? d.temp : null,
      tempWarn: ssd ? 60 : 45, tempCrit: ssd ? 70 : 55,
      fullWarn: d.warning || null, fullCrit: d.critical || null,
      errors: Number(d.numErrors || 0), spinning: d.isSpinning, ssd,
      size: d.fsSize != null ? kb(d.fsSize) : kb(d.size), used: d.fsUsed != null ? kb(d.fsUsed) : null,
    };
  };
  const disks = [...(a.parities || []).map(disk('parity')), ...(a.disks || []).map(disk('data')), ...(a.caches || []).map(disk('cache'))];

  // Problems become errors-feed events (and notifications). Messages stay stable so a
  // fluctuating temperature doesn't look like a new problem every poll.
  const events = [];
  const ev = (level, message, detail) => events.push({ time: new Date().toISOString(), level, source: 'Array', message, detail: detail || null, live: true });
  if (a.state !== 'STARTED') ev('error', `Array is not started (${a.state.toLowerCase().replace(/_/g, ' ')})`);
  for (const d of disks) {
    if (DISK_PROBLEM[d.status]) ev('error', `Disk ${d.name} ${DISK_PROBLEM[d.status]}`);
    if (d.temp != null && d.temp >= d.tempCrit) ev('error', `Disk ${d.name} is critically hot`, `${d.temp} °C (critical at ${d.tempCrit} °C)`);
    else if (d.temp != null && d.temp >= d.tempWarn) ev('warn', `Disk ${d.name} is running hot`, `${d.temp} °C (warning at ${d.tempWarn} °C)`);
    const pctFull = d.used != null && d.size ? (d.used / d.size) * 100 : null;
    // Only Unraid's *critical* fill level raises an alert: its default warning level (70%) is
    // normal for data disks under high-water allocation and would just be noise.
    if (pctFull != null && d.fullCrit && pctFull >= d.fullCrit) ev('error', `Disk ${d.name} is nearly full`, `${pctFull.toFixed(0)}% used (Unraid's critical level is ${d.fullCrit}%)`);
    if (d.errors > 0) ev('warn', `Disk ${d.name} has read/write errors`, `${d.errors} errors since the counters were last reset`);
  }
  const p = a.parityCheckStatus || {};
  if (!p.running && p.status === 'COMPLETED' && p.errors > 0) ev('warn', `Last parity check found ${p.errors} errors`);
  if (p.status === 'FAILED') ev('error', 'Last parity check failed');

  return {
    version: r.data.vars?.version || null,
    latency,
    data: {
      server: r.data.vars?.name || null,
      state: a.state,
      capacity: { total: kb(a.capacity?.kilobytes?.total), used: kb(a.capacity?.kilobytes?.used), free: kb(a.capacity?.kilobytes?.free) },
      parity: { status: p.status, running: !!p.running, paused: !!p.paused, progress: p.progress ?? null, errors: p.errors ?? 0, speed: p.speed || null, date: p.date || null, duration: p.duration ?? null, correcting: !!p.correcting },
      disks,
      events,
    },
  };
}

module.exports = { unraid };
