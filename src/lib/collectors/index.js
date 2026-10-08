// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// One collector per app. Each takes a saved service ({ url, apiKey | token, … }) and
// returns { version, latency, data }; throwing means the app is down. public/js/ renders
// `data`, and an optional `data.events` array feeds the errors panel.
//
// To add an app: write a collector in its own file here, export it below, and describe its
// settings form in lib/kinds.js.
'use strict';
const { sonarr, radarr, lidarr, readarr, prowlarr } = require('./arr');
const { plex } = require('./plex');
const { jellyfin, emby } = require('./jellyfin');
const { tautulli } = require('./tautulli');
const { bazarr } = require('./bazarr');
const { overseerr } = require('./seerr');
const { sabnzbd } = require('./sabnzbd');
const { nzbget } = require('./nzbget');
const { qbittorrent } = require('./qbittorrent');
const { transmission } = require('./transmission');
const { deluge } = require('./deluge');
const { clonarr } = require('./clonarr');
const { unraid } = require('./unraid');
const { truenas } = require('./truenas');
const { ping } = require('./ping');

/** @type {Record<string, (svc: any) => Promise<import('../types').CollectorResult>>} */
module.exports = {
  plex,
  jellyfin,
  emby,
  tautulli,
  sonarr,
  radarr,
  lidarr,
  readarr,
  prowlarr,
  bazarr,
  overseerr,
  jellyseerr: overseerr,
  seerr: overseerr,
  sabnzbd,
  nzbget,
  qbittorrent,
  transmission,
  deluge,
  clonarr,
  unraid,
  truenas,
  ping,
};
