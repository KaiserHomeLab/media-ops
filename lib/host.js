// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The machine Media Ops runs on: CPU, memory, load and uptime for the Host panel, local disk
// space, the Docker container list, and which platform it is (lib/platform.js).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { join, req: httpReq, unixGet } = require('./http');
const { platform } = require('./platform');

let lastCpu = os.cpus();
// CPU % since the previous call. os.cpus() only gives cumulative tick counters, so
// we diff against the last sample.
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i]?.times || c.times;
    for (const k of Object.keys(c.times)) total += c.times[k] - prev[k];
    idle += c.times.idle - prev.idle;
  });
  lastCpu = now;
  return total ? Math.round((1 - idle / total) * 100) : null;
}

// Which NAS the container is running on, so Settings can suggest adding it (lib/platform.js).
function hostOs() {
  const { id } = platform();
  return id === 'unraid' || id === 'truenas' ? id : null;
}

// The most common setup mistake: inside a container, localhost is the container itself.
function loopbackNote(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return ''; }
  if (!/^(localhost|127(\.\d+){3}|\[::1\])$/i.test(host)) return '';
  return ` Note: inside the Media Ops container, ${host} means the container itself, not your server. Use the server's network IP${platform().vm ? ', or host.docker.internal for an app installed on this computer' : ''}.`;
}

// Stats for the machine this runs on. Inside a container, CPU, RAM, load and uptime are the
// host's (Linux doesn't virtualise them), but the hostname isn't, hence HOST_NAME.
function hostStats() {
  return {
    hostname: process.env.HOST_NAME || os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    system: platform().label,
    vm: platform().vm, // Docker Desktop: CPU, memory and uptime are its VM's, not the computer's
    os: hostOs(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim(),
    cpu: cpuPercent(),
    load: os.loadavg(),
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    uptime: os.uptime(),
    node: process.version,
  };
}

// Free/total space for the paths listed under Settings → Disks (as seen inside the container).
async function localDisks(paths = []) {
  const out = [];
  for (const p of paths) {
    try {
      const s = await fs.promises.statfs(p);
      out.push({ path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch { /* path not mounted / not visible */ }
  }
  return out;
}

// Container list from the Docker Engine API: a mounted unix socket, or (safer) the URL of a
// read-only socket proxy such as tecnativa/docker-socket-proxy. Read-only: one GET.
async function dockerContainers(cfg) {
  const where = cfg?.socket;
  if (!where) return null;
  const viaProxy = /^https?:\/\//i.test(where);
  if (!viaProxy && !fs.existsSync(where)) return null; // socket not mounted — just hide the panel
  try {
    const list = viaProxy
      ? await httpReq(join(where, '/containers/json?all=1'), { timeout: 4000 })
      : await unixGet(where, '/containers/json?all=1');
    return list
      .map(c => ({
        name: (c.Names?.[0] || c.Id).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { hostOs, hostStats, loopbackNote, localDisks, dockerContainers };
