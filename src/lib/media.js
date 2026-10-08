// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media servers (Plex, Jellyfin, Emby) all report streams, libraries and recently added items
// in the same shape, so everything that reads them goes through these helpers instead of
// looking for one kind. Several can run side by side (Plex and Jellyfin, or two Plex servers).
'use strict';

const MEDIA_KINDS = ['plex', 'jellyfin', 'emby'];
const isMedia = kind => MEDIA_KINDS.includes(kind);

// The media servers that answered this poll.
const mediaServers = services => services.filter(s => s.up && isMedia(s.kind));

// Every stream on every media server, each tagged with its server's id (for posters and Stop).
const allStreams = services =>
  mediaServers(services).flatMap(m => (m.data?.streams || []).map(st => ({ ...st, server: m.id })));

module.exports = { MEDIA_KINDS, isMedia, mediaServers, allStreams };
