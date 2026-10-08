// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// GPU load for the Host panel (what Plex hardware transcoding is costing). Read-only, from the
// host's drivers via /sys, which containers can see without extra permissions:
//   AMD    device/gpu_busy_percent
//   Intel  idle (RC6) residency: busy % = 1 - Δidle / Δtime between two polls
//          (i915: power/rc6_residency_ms or gt/gt0/rc6_residency_ms; xe: tile0/gt0/gtidle/idle_residency_ms)
//   Nvidia `nvidia-smi`, available when the container uses the Nvidia runtime
// GPU_SYSFS overrides the /sys/class/drm root (used by the tests).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = () => process.env.GPU_SYSFS || '/sys/class/drm';
const read = p => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};
const num = p => {
  const v = read(p);
  return v == null || v === '' ? null : Number(v);
};
const VENDORS = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'Nvidia' };

const lastIdle = new Map(); // card -> { idleMs, at }

function intelBusy(card, dir) {
  const idle = [
    path.join(dir, 'power', 'rc6_residency_ms'),
    path.join(dir, 'gt', 'gt0', 'rc6_residency_ms'),
    path.join(dir, 'device', 'tile0', 'gt0', 'gtidle', 'idle_residency_ms'),
  ]
    .map(num)
    .find(v => v != null);
  if (idle == null) return null;
  const now = Date.now();
  const prev = lastIdle.get(card);
  lastIdle.set(card, { idleMs: idle, at: now });
  if (!prev || now - prev.at < 500 || idle < prev.idleMs) return null; // need two samples
  return Math.max(0, Math.min(100, Math.round((1 - (idle - prev.idleMs) / (now - prev.at)) * 100)));
}

function fromSysfs() {
  let cards;
  try {
    cards = fs.readdirSync(ROOT()).filter(n => /^card\d+$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const card of cards) {
    const dir = path.join(ROOT(), card);
    const vendor = VENDORS[read(path.join(dir, 'device', 'vendor'))];
    if (!vendor || vendor === 'Nvidia') continue; // Nvidia comes from nvidia-smi
    /** @type {{ card: string, vendor: string, name: string, busy: number | null, freqMhz: number | null, maxMhz: number | null }} */
    const g = { card, vendor, name: `${vendor} GPU`, busy: null, freqMhz: null, maxMhz: null };
    if (vendor === 'AMD') g.busy = num(path.join(dir, 'device', 'gpu_busy_percent'));
    if (vendor === 'Intel') {
      g.name = 'Intel iGPU';
      g.busy = intelBusy(card, dir);
      g.freqMhz =
        num(path.join(dir, 'gt_act_freq_mhz')) ?? num(path.join(dir, 'device', 'tile0', 'gt0', 'freq0', 'act_freq'));
      g.maxMhz =
        num(path.join(dir, 'gt_RP0_freq_mhz')) ?? num(path.join(dir, 'device', 'tile0', 'gt0', 'freq0', 'rp0_freq'));
    }
    out.push(g);
  }
  return out;
}

function fromNvidiaSmi() {
  return new Promise(resolve => {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,encoder.stats.sessionCount',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve([]); // not installed / no Nvidia runtime: just no Nvidia GPUs
        resolve(
          stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line, i) => {
              const [name, util, memUsed, memTotal, temp, enc] = line.split(',').map(x => x.trim());
              const n = v => (v === '' || /N\/A|Not Supported/i.test(v) ? null : Number(v));
              // nvidia-smi reports memory in MiB
              const mib = v => {
                const x = n(v);
                return x ? x * 1048576 : null;
              };
              return {
                card: `nvidia${i}`,
                vendor: 'Nvidia',
                name,
                busy: n(util),
                memUsed: mib(memUsed),
                memTotal: mib(memTotal),
                temp: n(temp),
                encoderSessions: n(enc),
              };
            }),
        );
      },
    );
  });
}

// Skip the nvidia-smi probe after it's been missing once, so we don't fork every poll.
let nvidiaMissing = false;
async function read_() {
  const sys = fromSysfs();
  if (nvidiaMissing) return sys;
  const nv = await fromNvidiaSmi();
  if (!nv.length) nvidiaMissing = true;
  return [...sys, ...nv];
}

module.exports = { read: read_ };
