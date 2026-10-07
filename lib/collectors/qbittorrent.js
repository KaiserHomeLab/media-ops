// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// qBittorrent: torrents and transfer speed.
'use strict';
const { join, req, timed } = require('../http');

// qBittorrent Web API v2 uses a cookie session. Login is skipped when no username is set
// (its "bypass auth for LAN" option); the SID is cached per server and renewed on 401/403.
const qbitSid = new Map();
async function qbittorrent(cfg) {
  const login = async () => {
    if (!cfg.username) return null;
    const res = await req(join(cfg.url, '/api/v2/auth/login'), {
      method: 'POST',
      as: 'response',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: cfg.url },
      body: new URLSearchParams({ username: cfg.username, password: cfg.password || '' }),
    });
    const sid = /SID=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
    if (!sid) throw new Error('qBittorrent login failed');
    qbitSid.set(cfg.url, sid);
    return sid;
  };
  const call = async (p, as = 'json') => {
    const doCall = sid =>
      req(join(cfg.url, p), { as, headers: { Referer: cfg.url, ...(sid ? { Cookie: `SID=${sid}` } : {}) } });
    try {
      return await doCall(qbitSid.get(cfg.url) ?? (await login()));
    } catch (e) {
      if (!/HTTP 40[13]/.test(e.message) || !cfg.username) throw e;
      return doCall(await login());
    }
  };
  const [version, latency] = await timed(() => call('/api/v2/app/version', 'text'));
  const main = await call('/api/v2/sync/maindata?rid=0');
  const s = main.server_state || {};
  const torrents = Object.values(main.torrents || {});
  const states = {};
  for (const t of torrents) states[t.state] = (states[t.state] || 0) + 1;
  return {
    version,
    latency,
    data: {
      client: 'torrent',
      downBps: s.dl_info_speed || 0,
      upBps: s.up_info_speed || 0,
      ratio: Number(s.global_ratio) || null,
      allTimeDown: s.alltime_dl,
      allTimeUp: s.alltime_ul,
      freeSpace: s.free_space_on_disk,
      torrents: torrents.length,
      states,
      items: torrents
        .filter(t => t.progress < 1)
        .sort((a, b) => b.dlspeed - a.dlspeed)
        .slice(0, 25)
        .map(t => ({
          title: t.name,
          progress: t.progress,
          size: t.size,
          eta: t.eta,
          status: t.state,
          speed: t.dlspeed,
        })),
    },
  };
}

module.exports = { qbittorrent };
