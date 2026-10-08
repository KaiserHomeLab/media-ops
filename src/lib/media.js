// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Media servers (Plex, Jellyfin, Emby) all report streams, libraries and recently added items
// in the same shape, so everything that reads them goes through these helpers instead of
// looking for one kind. Several can run side by side (Plex and Jellyfin, or two Plex servers).
'use strict';

const MEDIA_KINDS = ['plex', 'jellyfin', 'emby'];
/** @param {string} kind */
const isMedia = kind => MEDIA_KINDS.includes(kind);

/**
 * An app that answered this poll, so it has data. Use it with filter() and the type follows.
 * @param {import('./types').Polled} s
 * @returns {s is import('./types').Polled & { data: import('./types').CollectorData }}
 */
const answered = s => s.up && !!s.data;

// The media servers that answered this poll.
/** @param {import('./types').Polled[]} services */
const mediaServers = services => services.filter(s => s.up && isMedia(s.kind));

// Every stream on every media server, each tagged with its server's id (for posters and Stop).
/** @param {import('./types').Polled[]} services @returns {any[]} */
const allStreams = services =>
  mediaServers(services).flatMap(m => (m.data?.streams || []).map(st => ({ ...st, server: m.id })));

module.exports = { MEDIA_KINDS, isMedia, answered, mediaServers, allStreams };
