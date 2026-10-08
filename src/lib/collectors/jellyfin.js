// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Jellyfin and Emby: streams (with why each one transcodes), libraries, recently added and
// update status. Jellyfin began as a fork of Emby and the two still share this part of the
// API; they differ in how the API key is sent. Results have the same shape as lib/collectors/
// plex.js, so the dashboard, history and notifications treat every media server alike.
'use strict';
const net = require('node:net');
const { join, req, timed, cached } = require('../http');
const { DAY, pad } = require('./shared');

const TICKS_PER_MS = 10000; // durations and positions are in 100-nanosecond ticks

// How each server takes the API key.
/** @type {Record<string, (key: string) => Record<string, string>>} */
const AUTH = {
  jellyfin: key => ({ Authorization: `MediaBrowser Token="${key}"` }),
  emby: key => ({ 'X-Emby-Token': key }),
};

// The server's TranscodeReasons, in plain words (the codecs fill in where they're known).
function transcodeReason(reasons, src, ti) {
  const UP = s => String(s || '').toUpperCase();
  const why = [];
  for (const r of reasons || []) {
    if (/^Subtitle/.test(r)) why.push('burning in subtitles');
    else if (r === 'VideoCodecNotSupported' || r === 'VideoProfileNotSupported' || r === 'VideoLevelNotSupported')
      why.push(
        src.video && ti.VideoCodec && UP(src.video) !== UP(ti.VideoCodec)
          ? `client can't play ${UP(src.video)} → ${UP(ti.VideoCodec)}`
          : "client can't play this video format",
      );
    else if (/^VideoResolution|^VideoBitDepth|^VideoRange/.test(r)) why.push('client limit on resolution or HDR');
    else if (/Bitrate/.test(r)) why.push('bitrate limit');
    else if (/^Audio/.test(r))
      why.push(
        src.audio && ti.AudioCodec && UP(src.audio) !== UP(ti.AudioCodec)
          ? `audio ${UP(src.audio)} → ${UP(ti.AudioCodec)}`
          : 'audio transcode',
      );
    else if (/^Container/.test(r)) why.push(`remux ${UP(src.container)} → ${UP(ti.Container)}`);
  }
  return [...new Set(why)].join(' · ') || null;
}

const resolutionOf = height =>
  !height ? null : height >= 2000 ? '4k' : height >= 1000 ? '1080' : height >= 700 ? '720' : 'sd';
const TYPE = { Episode: 'episode', Movie: 'movie', Audio: 'track', MusicVideo: 'clip', TvChannel: 'live' };

// RemoteEndPoint is "1.2.3.4", "1.2.3.4:5678", "2001:db8::1" or "[2001:db8::1]:5678".
function hostOf(endpoint) {
  const e = String(endpoint || '').trim();
  const bracketed = /^\[([^\]]+)\]/.exec(e);
  if (bracketed) return bracketed[1];
  return (e.match(/:/g) || []).length === 1 ? e.split(':')[0] : e;
}

// Private and loopback addresses are on the home network.
function isLocal(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (!net.isIP(a)) return false;
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(a);
}

function mapSession(s) {
  const it = s.NowPlayingItem;
  const ps = s.PlayState || {};
  const ti = s.TranscodingInfo || null;
  const streams = it.MediaStreams || [];
  const video = streams.find(x => x.Type === 'Video');
  const audio = streams.find(x => x.Type === 'Audio' && x.IsDefault) || streams.find(x => x.Type === 'Audio');
  const transcoding = ps.PlayMethod === 'Transcode' && ti;
  const decision = transcoding
    ? ti.IsVideoDirect
      ? 'Transcode (audio)'
      : 'Transcode'
    : ps.PlayMethod === 'DirectStream'
      ? 'Direct Stream'
      : 'Direct Play';
  const type = TYPE[it.Type] || String(it.Type || '').toLowerCase();
  const ep = type === 'episode';
  const track = type === 'track';
  const srcBitrate = streams.reduce((a, x) => a + (x.Type === 'Video' || x === audio ? x.BitRate || 0 : 0), 0);
  const ip = hostOf(s.RemoteEndPoint);
  return {
    id: s.Id,
    user: s.UserName || 'Unknown',
    player: s.DeviceName,
    product: s.Client,
    platform: null,
    state: ps.IsPaused ? 'paused' : 'playing',
    local: isLocal(ip),
    ip, // used for the stream map, then removed by lib/geo.js
    type,
    title: ep ? it.SeriesName : track ? it.AlbumArtist || it.Artists?.[0] || it.Name : it.Name,
    subtitle: ep
      ? `S${pad(it.ParentIndexNumber)}E${pad(it.IndexNumber)} · ${it.Name}`
      : track
        ? `${it.Name} — ${it.Album || ''}`
        : it.ProductionYear
          ? String(it.ProductionYear)
          : '',
    thumb: `/Items/${ep && it.SeriesId ? it.SeriesId : track && it.AlbumId ? it.AlbumId : it.Id}/Images/Primary`,
    offset: Math.round((ps.PositionTicks || 0) / TICKS_PER_MS),
    duration: Math.round((it.RunTimeTicks || 0) / TICKS_PER_MS),
    decision,
    sessionId: s.Id, // needed to stop a stream
    reason: transcoding
      ? transcodeReason(ti.TranscodeReasons, { video: video?.Codec, audio: audio?.Codec, container: it.Container }, ti)
      : null,
    fourKTranscode: !!transcoding && !ti.IsVideoDirect && (video?.Height || 0) >= 2000,
    hwName: transcoding && ti.HardwareAccelerationType ? String(ti.HardwareAccelerationType).toUpperCase() : null,
    hw: !!(transcoding && ti.HardwareAccelerationType),
    transcodeSpeed: null,
    resolution: resolutionOf(video?.Height),
    videoCodec: video?.Codec,
    audioCodec: audio?.Codec,
    container: it.Container,
    bitrate: srcBitrate ? Math.round(srcBitrate / 1000) : null, // kbps
    bandwidth: Math.round(((transcoding && ti.Bitrate) || srcBitrate) / 1000) || null, // kbps
  };
}

const LIB_TYPE = { movies: 'movie', tvshows: 'show', music: 'artist', homevideos: 'photo', photos: 'photo' };

function collector(kind) {
  return async function mediaServer(cfg) {
    const headers = AUTH[kind](cfg.apiKey);
    const api = p => req(join(cfg.url, p), { headers });
    const [info, latency] = await timed(() => api('/System/Info'));

    // Library-wide item queries need no user with an API key (Jellyfin 10.9+, Emby 4.7+). On
    // older versions the counts and "recently added" stay empty; streams still work.
    const items = query => api(`/Items?${query}`);
    const count = (parent, types) =>
      items(`ParentId=${encodeURIComponent(parent)}&Recursive=true&IncludeItemTypes=${types}&Limit=0`)
        .then(r => r?.TotalRecordCount ?? 0)
        .catch(() => null);

    const [sessions, libraries, recent] = await Promise.all([
      api('/Sessions?ActiveWithinSeconds=600'),
      cached(`${kind}-libs:${cfg.url}`, 5 * 60e3, async () => {
        const folders = (await api('/Library/VirtualFolders').catch(() => [])) || [];
        return Promise.all(
          folders.map(async f => {
            const type = LIB_TYPE[f.CollectionType] || 'other';
            const id = f.ItemId;
            const lib = { title: f.Name, type, count: null };
            if (type === 'movie') lib.count = await count(id, 'Movie');
            else if (type === 'show')
              [lib.count, lib.episodes] = await Promise.all([count(id, 'Series'), count(id, 'Episode')]);
            else if (type === 'artist')
              [lib.count, lib.albums, lib.tracks] = await Promise.all([
                count(id, 'MusicArtist'),
                count(id, 'MusicAlbum'),
                count(id, 'Audio'),
              ]);
            else lib.count = await count(id, 'Movie,Video,Photo,Book,AudioBook');
            return lib;
          }),
        );
      }),
      cached(`${kind}-recent:${cfg.url}`, 2 * 60e3, () =>
        items(
          'SortBy=DateCreated&SortOrder=Descending&Recursive=true&IncludeItemTypes=Movie,Episode,MusicAlbum&Limit=16&Fields=DateCreated&IsVirtualItem=false',
        ).catch(() => null),
      ),
    ]);

    const streams = (sessions || []).filter(s => s.NowPlayingItem).map(mapSession);
    const recentlyAdded = (recent?.Items || [])
      .map(m => {
        const type = m.Type === 'Episode' ? 'episode' : m.Type === 'MusicAlbum' ? 'album' : 'movie';
        return {
          id: m.Id,
          type,
          title: type === 'episode' ? m.SeriesName : m.Name,
          sub:
            type === 'episode'
              ? `S${pad(m.ParentIndexNumber)}E${pad(m.IndexNumber)} · ${m.Name}`
              : type === 'album'
                ? m.AlbumArtist || ''
                : m.ProductionYear
                  ? String(m.ProductionYear)
                  : '',
          thumb: `/Items/${type === 'episode' && m.SeriesId ? m.SeriesId : m.Id}/Images/Primary`,
          addedAt: Date.parse(m.DateCreated) || 0,
          library: null,
        };
      })
      .filter(m => !(m.addedAt > Date.now() + DAY));

    return {
      version: info.Version,
      latency,
      data: {
        update: info.HasUpdateAvailable ? { version: null } : null,
        streams,
        libraries,
        recentlyAdded,
        resources: null,
      },
    };
  };
}

const jellyfin = collector('jellyfin');
const emby = collector('emby');

module.exports = { jellyfin, emby, transcodeReason, isLocal, hostOf, AUTH };
