// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Plex Media Server: streams (with why each one transcodes), libraries, recently added,
// resource use and update status.
'use strict';
const { join, req, timed, cached, background } = require('../http');
const { DAY, pad, UPDATE_TTL } = require('./shared');

// Plex doesn't say *why* it's transcoding, but the TranscodeSession tells us what changed
// (codec, resolution, subtitles, audio), which is what Tautulli and Plex Web infer from too.
const UP = s => String(s || '').toUpperCase();
function transcodeReason(ts, media) {
  const why = [];
  if (ts.subtitleDecision === 'burn') why.push('burning in subtitles');
  if (ts.videoDecision === 'transcode') {
    const src = ts.sourceVideoCodec || media.videoCodec;
    if (src && ts.videoCodec && UP(src) !== UP(ts.videoCodec))
      why.push(`client can't play ${UP(src)} → ${UP(ts.videoCodec)}`);
    const srcRes = /^4k$/i.test(String(media.videoResolution)) ? 2160 : Number(media.videoResolution) || null;
    if (srcRes && ts.height && Number(ts.height) < srcRes * 0.9)
      why.push(`quality limit ${srcRes === 2160 ? '4K' : `${srcRes}p`} → ${ts.height}p`);
    if (!why.length) why.push('video transcode (bitrate or quality setting)');
  }
  if (ts.audioDecision === 'transcode') {
    const src = ts.sourceAudioCodec || media.audioCodec;
    why.push(
      src && ts.audioCodec && UP(src) !== UP(ts.audioCodec)
        ? `audio ${UP(src)} → ${UP(ts.audioCodec)}`
        : 'audio transcode',
    );
  }
  if (!why.length && ts.videoDecision === 'copy')
    why.push(`remux ${UP(media.container)} → ${UP(ts.container)} (direct stream)`);
  return why.join(' · ') || null;
}

async function plex(cfg) {
  const headers = { 'X-Plex-Token': cfg.token };
  const api = p => req(join(cfg.url, p), { headers });
  const [identity, latency] = await timed(() => api('/identity'));

  const [sessions, libraries, resources, recent] = await Promise.all([
    api('/status/sessions'),
    cached(`plex-libs:${cfg.url}`, 5 * 60e3, async () => {
      const sections = await api('/library/sections');
      const count = async (key, type) => {
        const q = `${type ? `type=${type}&` : ''}X-Plex-Container-Start=0&X-Plex-Container-Size=0`;
        const r = await api(`/library/sections/${key}/all?${q}`);
        return r.MediaContainer.totalSize ?? r.MediaContainer.size ?? 0;
      };
      return Promise.all(
        (sections.MediaContainer.Directory || []).map(async d => {
          const lib = { title: d.title, type: d.type, count: await count(d.key) };
          if (d.type === 'show') lib.episodes = await count(d.key, 4);
          if (d.type === 'artist') [lib.albums, lib.tracks] = await Promise.all([count(d.key, 9), count(d.key, 10)]);
          return lib;
        }),
      );
    }),
    // Host + Plex CPU/RAM, as on Plex's own dashboard (may need Plex Pass; skipped if refused).
    api('/statistics/resources?timespan=6').catch(() => null),
    cached(`plex-recent:${cfg.url}`, 2 * 60e3, () =>
      api('/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=16').catch(() => null),
    ),
  ]);
  // Plex lists a newer release under /updater/status once it has checked for one.
  const current = identity.MediaContainer?.version || '';
  const update = await background(`update:${cfg.url}`, UPDATE_TTL, () =>
    api('/updater/status').then(r => {
      const rel = [].concat(r?.MediaContainer?.Release || [])[0];
      return rel?.version && rel.version.split('-')[0] !== current.split('-')[0]
        ? { version: rel.version.split('-')[0] }
        : null;
    }),
  );
  const res = resources?.MediaContainer?.StatisticsResources?.at(-1);

  const streams = (sessions.MediaContainer.Metadata || []).map(m => {
    const media = m.Media?.find(x => x.selected) || m.Media?.[0] || {};
    const ts = m.TranscodeSession;
    let decision = 'Direct Play';
    if (ts) {
      const v = ts.videoDecision,
        a = ts.audioDecision;
      decision = v === 'transcode' ? 'Transcode' : a === 'transcode' ? 'Transcode (audio)' : 'Direct Stream';
    }
    const reason = ts ? transcodeReason(ts, media) : null;
    const ep = m.type === 'episode';
    const track = m.type === 'track';
    return {
      id: m.sessionKey,
      user: m.User?.title || 'Unknown',
      player: m.Player?.title,
      product: m.Player?.product,
      platform: m.Player?.platform,
      state: m.Player?.state,
      local: m.Player?.local ?? m.Session?.location === 'lan',
      ip: m.Player?.address, // used for the stream map, then removed by lib/geo.js
      publicIp: m.Player?.remotePublicAddress,
      type: m.type,
      title: ep || track ? m.grandparentTitle : m.title,
      subtitle: ep
        ? `S${pad(m.parentIndex)}E${pad(m.index)} · ${m.title}`
        : track
          ? `${m.title} — ${m.parentTitle}`
          : m.year
            ? String(m.year)
            : '',
      thumb: ep ? m.grandparentThumb : track ? m.parentThumb : m.thumb,
      offset: m.viewOffset || 0,
      duration: m.duration || 0,
      decision,
      sessionId: m.Session?.id, // needed to stop a stream
      reason,
      fourKTranscode: ts?.videoDecision === 'transcode' && /^4k$/i.test(String(media.videoResolution || '')),
      hwName: ts?.transcodeHwEncodingTitle || ts?.transcodeHwDecodingTitle || null,
      hw: !!(ts && (ts.transcodeHwRequested || ts.transcodeHwFullPipeline)),
      transcodeSpeed: ts?.speed,
      resolution: media.videoResolution,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
      container: media.container,
      bitrate: media.bitrate, // kbps
      bandwidth: m.Session?.bandwidth, // kbps
    };
  });

  // Plex sorts by addedAt, so an item with a corrupt future date (seen in the wild: year 2098)
  // would sit at the front forever. Skip anything "added" more than a day from now.
  const recentlyAdded = (recent?.MediaContainer?.Metadata || [])
    .filter(m => !(m.addedAt * 1000 > Date.now() + DAY))
    .map(m => ({
      id: m.ratingKey,
      type: m.type,
      title: m.type === 'episode' ? m.grandparentTitle : m.type === 'season' ? m.parentTitle : m.title,
      sub:
        m.type === 'episode'
          ? `S${pad(m.parentIndex)}E${pad(m.index)} · ${m.title}`
          : m.type === 'season'
            ? m.title
            : m.type === 'album'
              ? m.parentTitle
              : m.year
                ? String(m.year)
                : '',
      thumb: m.type === 'episode' ? m.grandparentThumb : m.type === 'season' ? m.parentThumb || m.thumb : m.thumb,
      addedAt: (m.addedAt || 0) * 1000,
      library: m.librarySectionTitle,
    }));
  return {
    version: identity.MediaContainer?.version,
    latency,
    data: {
      update,
      streams,
      libraries,
      recentlyAdded,
      resources: res
        ? {
            hostCpu: res.hostCpuUtilization,
            plexCpu: res.processCpuUtilization,
            hostMem: res.hostMemoryUtilization,
            plexMem: res.processMemoryUtilization,
          }
        : null,
    },
  };
}

module.exports = { plex };
