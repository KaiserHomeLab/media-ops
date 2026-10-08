// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Which platform the container runs on, so the dashboard can name it and Settings can give
// setup tips that fit (disk paths, how to reach apps on the same computer). Containers share
// the host's kernel, and its release string names most platforms:
//   6.12.54-Unraid                       Unraid
//   6.12.15-production+truenas           TrueNAS
//   5.15.167.4-microsoft-standard-WSL2   Windows (Docker Desktop or Docker inside WSL 2)
//   6.10.14-linuxkit                     Docker Desktop (Mac, or Windows' older Hyper-V backend)
//   6.11.6-orbstack                      OrbStack on a Mac
//   4.4.302+                             Synology DSM
//   6.8.12-4-pve                         Proxmox (Docker in an LXC container)
// HOST_OS overrides the guess (Unraid's Docker manager sets it; anyone can).
// "vm" platforms run containers inside a small Linux VM: CPU, memory and uptime are the VM's.
'use strict';
const os = require('node:os');

const PLATFORMS = [
  { id: 'unraid', label: 'Unraid', test: /unraid/i },
  { id: 'truenas', label: 'TrueNAS', test: /truenas/i },
  { id: 'synology', label: 'Synology', test: /synology|^\d+\.\d+\.\d+\+$/i },
  { id: 'qnap', label: 'QNAP', test: /\bqnap\b|\bqts\b/i },
  { id: 'windows', label: 'Windows', test: /microsoft|\bwsl|windows/i, vm: true },
  { id: 'mac', label: 'macOS', test: /orbstack|darwin|\bmac ?os\b|^mac$/i, vm: true },
  { id: 'docker-desktop', label: 'Docker Desktop', test: /linuxkit|docker ?desktop/i, vm: true },
  { id: 'proxmox', label: 'Proxmox', test: /-pve$|proxmox/i },
];
const LINUX = { id: 'linux', label: 'Linux' };

function detect(hint = process.env.HOST_OS, release = os.release()) {
  const pick = s => (s && PLATFORMS.find(p => p.test.test(String(s).trim()))) || null;
  const p = pick(hint) || pick(release) || LINUX;
  return { id: p.id, label: p.label, vm: !!p.vm };
}

/** @type {{ id: string, label: string, vm: boolean } | null} */
let current = null;
const platform = () => (current ??= detect());

module.exports = { detect, platform };
