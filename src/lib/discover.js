// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Finds supported apps among the Docker containers (Settings → "Found in Docker"), so adding
// them is a click plus the API key. Works from Docker's container list, the same read-only
// call the Host panel makes. Each app is recognised by its image name, for the common image
// families: linuxserver (lscr.io/linuxserver/sonarr), hotio, binhex (binhex/arch-sonarr) and
// the official ones (plexinc/pms-docker, jellyfin/jellyfin…).
//
// The suggested address depends on how Media Ops can reach the app:
//   network    both containers are on the same user-defined network: http://<container>:<port>
//   published  the app publishes its port on the server: http://<server>:<published port>
//   host       the app uses the host's network: http://<server>:<its port>
// The browser fills in <server> (the address Settings was opened with), so the server never
// has to guess its own LAN address.
'use strict';
const os = require('node:os');
const { BY_KIND } = require('./kinds');

// Last part of the image name (without registry, owner, tag or digest) -> kind.
/** @type {Record<string, string>} */
const IMAGE_KIND = {
  plex: 'plex',
  'pms-docker': 'plex',
  'plex-media-server': 'plex',
  jellyfin: 'jellyfin',
  emby: 'emby',
  embyserver: 'emby',
  tautulli: 'tautulli',
  sonarr: 'sonarr',
  radarr: 'radarr',
  lidarr: 'lidarr',
  readarr: 'readarr',
  prowlarr: 'prowlarr',
  bazarr: 'bazarr',
  seerr: 'seerr',
  overseerr: 'overseerr',
  jellyseerr: 'jellyseerr',
  sabnzbd: 'sabnzbd',
  nzbget: 'nzbget',
  qbittorrent: 'qbittorrent',
  'qbittorrent-nox': 'qbittorrent',
  transmission: 'transmission',
  deluge: 'deluge',
  clonarr: 'clonarr',
};

/** @param {string} image */
function kindOfImage(image) {
  const name = String(image || '')
    .split('@')[0] // digest
    .replace(/:[^/]*$/, '') // tag
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/^arch-/, ''); // binhex/arch-sonarr
  const kind = name && IMAGE_KIND[name];
  return kind && BY_KIND[kind] ? kind : null;
}

// Docker's default bridge network has no name lookup between containers, so it doesn't count.
/** @param {any} c a container from Docker's list @returns {string[]} */
const userNetworks = c => Object.keys(c.NetworkSettings?.Networks || {}).filter(n => n !== 'bridge');

/**
 * Supported apps among the running containers.
 * @param {any[]} containers Docker's /containers/json reply
 * @param {string} [self] this container's id (Docker sets the hostname to its short id)
 */
function findApps(containers, self = os.hostname()) {
  const me = containers.find(c => self && String(c.Id || '').startsWith(self));
  const myNetworks = new Set(me ? userNetworks(me) : []);
  return containers
    .filter(c => c !== me && c.State === 'running')
    .flatMap(c => {
      const kind = kindOfImage(c.Image);
      if (!kind) return [];
      const def = BY_KIND[kind];
      const container = String(c.Names?.[0] || '').replace(/^\//, '');
      const tcp = /** @type {any[]} */ (c.Ports || []).filter(p => p.Type === 'tcp');
      // Its usual port if the container exposes it, else the first port it exposes.
      const port = tcp.find(p => p.PrivatePort === def.port) || tcp.find(p => p.PublicPort) || tcp[0];
      const shared = userNetworks(c).find(n => myNetworks.has(n));
      const hostMode = c.HostConfig?.NetworkMode === 'host';
      /** @type {'network' | 'published' | 'host' | null} */
      let via = null;
      if (shared && container && (port?.PrivatePort || def.port)) via = 'network';
      else if (port?.PublicPort) via = 'published';
      else if (hostMode && def.port) via = 'host';
      if (!via) return []; // no way in from here that we can tell
      const app = {
        kind,
        label: def.label,
        container,
        via,
        host: via === 'network' ? container : null, // null: the browser fills in the server's address
        port: via === 'network' ? port?.PrivatePort || def.port : via === 'published' ? port?.PublicPort : def.port,
      };
      return [app];
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.container.localeCompare(b.container));
}

module.exports = { findApps, kindOfImage };
