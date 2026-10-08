// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Transmission: torrents and transfer speed, over its RPC API.
'use strict';
const { basicAuth, join, req, timed } = require('../http');

const STATUS = ['stopped', 'queued to check', 'checking', 'queued', 'downloading', 'queued to seed', 'seeding'];
const FIELDS = ['name', 'percentDone', 'sizeWhenDone', 'eta', 'status', 'rateDownload', 'error', 'errorString'];

// Transmission answers a call without a valid X-Transmission-Session-Id with 409 and the id to
// use (CSRF protection). The id is kept per server and refreshed when Transmission restarts.
const sessions = new Map();

// "http://nas:9091", "http://nas:9091/transmission/web/" and a reverse-proxy path all work.
const rpcUrl = url => join(url.replace(/\/transmission(\/web)?\/?$/, ''), '/transmission/rpc');

async function transmission(cfg) {
  const url = rpcUrl(cfg.url);
  const rpc = async (method, args) => {
    const call = () =>
      req(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Transmission-Session-Id': sessions.get(url) || '',
          ...basicAuth(cfg.username, cfg.password),
        },
        body: JSON.stringify({ method, arguments: args }),
      });
    let r;
    try {
      r = await call();
    } catch (e) {
      const id = e.reply?.status === 409 && e.reply.headers.get('x-transmission-session-id');
      if (!id) throw e;
      sessions.set(url, id);
      r = await call();
    }
    if (r?.result !== 'success') throw new Error(`Transmission: ${r?.result || 'no reply'}`);
    return r.arguments;
  };

  const [session, latency] = await timed(() => rpc('session-get', { fields: ['version'] }));
  const [stats, list] = await Promise.all([rpc('session-stats'), rpc('torrent-get', { fields: FIELDS })]);
  const torrents = list.torrents || [];
  const total = stats['cumulative-stats'] || {};
  const states = {};
  for (const t of torrents) {
    const st = STATUS[t.status] || 'unknown';
    states[st] = (states[st] || 0) + 1;
  }

  return {
    version: String(session.version || '').split(' ')[0] || null,
    latency,
    data: {
      client: 'torrent',
      downBps: stats.downloadSpeed || 0,
      upBps: stats.uploadSpeed || 0,
      ratio: total.downloadedBytes ? total.uploadedBytes / total.downloadedBytes : null,
      allTimeDown: total.downloadedBytes,
      allTimeUp: total.uploadedBytes,
      torrents: torrents.length,
      states,
      items: torrents
        .filter(t => t.percentDone < 1)
        .sort((a, b) => b.rateDownload - a.rateDownload)
        .slice(0, 25)
        .map(t => ({
          title: t.name,
          progress: t.percentDone,
          size: t.sizeWhenDone,
          eta: t.eta >= 0 ? t.eta : null,
          status: STATUS[t.status] || 'unknown',
          speed: t.rateDownload,
        })),
      // error: 1 tracker warning, 2 tracker error, 3 local error (disk full, files missing).
      events: torrents
        .filter(t => t.error >= 2)
        .map(t => ({
          time: new Date().toISOString(),
          level: t.error === 3 ? 'error' : 'warn',
          source: 'Torrent error',
          message: `${t.name}: ${t.errorString || 'error'}`,
          live: true,
        })),
    },
  };
}

module.exports = { transmission, rpcUrl };
