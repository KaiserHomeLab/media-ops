// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Deluge: torrents and transfer speed, through the Web UI's JSON-RPC API (/json).
'use strict';
const { join, req, readText, timed } = require('../http');

const FIELDS = [
  'name',
  'progress',
  'total_wanted',
  'total_done',
  'total_uploaded',
  'eta',
  'state',
  'download_payload_rate',
  'message',
];

// The Web UI logs in with a password and hands back a _session_id cookie, kept per server and
// renewed when Deluge says we're not logged in (error code 1). Keyed by the password too, so
// testing a different password in Settings logs in afresh instead of reusing the old session.
const cookies = new Map();
const NOT_AUTHENTICATED = 1;

async function deluge(cfg) {
  const url = join(cfg.url, '/json');
  const key = [url, cfg.password].join('\n');
  let id = 0;
  const post = (method, params, cookie) =>
    req(url, {
      method: 'POST',
      as: method === 'auth.login' ? 'response' : 'json',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ method, params, id: ++id }),
    });

  const login = async () => {
    const res = await post('auth.login', [cfg.password || '']);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status} on /json`);
    }
    let ok = false;
    try {
      ok = JSON.parse(await readText(res))?.result === true;
    } catch {
      /* not JSON: not Deluge's Web UI */
    }
    const cookie = /_session_id=[^;]+/.exec(res.headers.get('set-cookie') || '')?.[0];
    if (!ok || !cookie) throw new Error('Deluge login failed — check the password');
    cookies.set(key, cookie);
    return cookie;
  };
  const call = async (method, params = []) => {
    let r = await post(method, params, cookies.get(key) ?? (await login()));
    if (r?.error?.code === NOT_AUTHENTICATED) r = await post(method, params, await login());
    if (r?.error) throw new Error(`Deluge: ${r.error.message || 'error'}`);
    return r?.result;
  };

  // The Web UI is a front end for a separate daemon. Connect it to the first daemon it knows
  // about when it isn't connected yet (what its Connection Manager does on first open).
  const [connected, latency] = await timed(() => call('web.connected'));
  if (!connected) {
    const hosts = (await call('web.get_hosts')) || [];
    if (!hosts.length) throw new Error('Deluge Web UI has no daemon to connect to');
    await call('web.connect', [hosts[0][0]]);
  }
  const [ui, version] = await Promise.all([call('web.update_ui', [FIELDS, {}]), call('daemon.info').catch(() => null)]);
  const torrents = Object.values(ui?.torrents || {});
  const s = ui?.stats || {};
  const states = {};
  for (const t of torrents) states[t.state] = (states[t.state] || 0) + 1;
  const done = torrents.reduce((a, t) => a + (t.total_done || 0), 0);
  const uploaded = torrents.reduce((a, t) => a + (t.total_uploaded || 0), 0);

  return {
    version: version || null,
    latency,
    data: {
      client: 'torrent',
      downBps: s.download_rate || 0,
      upBps: s.upload_rate || 0,
      ratio: done ? uploaded / done : null,
      allTimeUp: uploaded,
      freeSpace: s.free_space,
      torrents: torrents.length,
      states,
      items: torrents
        .filter(t => t.progress < 100)
        .sort((a, b) => b.download_payload_rate - a.download_payload_rate)
        .slice(0, 25)
        .map(t => ({
          title: t.name,
          progress: t.progress / 100,
          size: t.total_wanted,
          eta: t.eta > 0 ? t.eta : null,
          status: String(t.state || '').toLowerCase(),
          speed: t.download_payload_rate,
        })),
      events: torrents
        .filter(t => t.state === 'Error')
        .map(t => ({
          time: new Date().toISOString(),
          level: 'error',
          source: 'Torrent error',
          message: `${t.name}: ${t.message || 'error'}`,
          live: true,
        })),
    },
  };
}

module.exports = { deluge };
