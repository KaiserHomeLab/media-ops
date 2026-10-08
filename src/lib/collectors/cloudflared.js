// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Cloudflare Tunnel (cloudflared): is the connector connected to Cloudflare, and do the public
// addresses it serves (e.g. Seerr at https://requests.example.com) load from the internet?
// The first comes from cloudflared's own metrics server (/ready and /metrics, port 20241 in
// Docker); the second opens each public address through Cloudflare, like a user would.
'use strict';
const { cached, join, req, timed } = require('../http');

/**
 * Prometheus text → [{ name, labels, value }].
 * @param {string} text
 */
function parseMetrics(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    /** @type {Record<string, string>} */
    const labels = {};
    for (const [, k, v] of (m[2] || '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v;
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}

/** The addresses to check, from the form's free text (commas, spaces or new lines between). @param {unknown} v */
const publicUrls = v =>
  String(v || '')
    .split(/[\s,]+/)
    .filter(u => /^https?:\/\/[^/\s]+/i.test(u))
    .slice(0, 10);

/**
 * Opens one public address through Cloudflare. Anything below 500 counts (a login page, a
 * redirect or Cloudflare Access asking who you are all mean it's reachable).
 * @param {string} url
 */
async function checkPublic(url) {
  const host = new URL(url).host;
  try {
    const [res, ms] = await timed(() => req(url, { as: 'response', timeout: 10000, headers: { Accept: '*/*' } }));
    res.body?.cancel().catch(() => {});
    const status = res.status;
    if (status < 500) return { host, url, ok: true, status, ms };
    const viaCloudflare = res.headers.has('cf-ray');
    // Cloudflare's own error pages: 530 (error 1033) = no connected tunnel for this hostname;
    // 502/504 = the tunnel is up but the app behind it doesn't answer.
    const problem =
      viaCloudflare && status === 530
        ? 'Cloudflare has no connected tunnel for this address'
        : viaCloudflare && (status === 502 || status === 504)
          ? "the tunnel can't reach the app behind it"
          : `it answers with an error (HTTP ${status})`;
    return { host, url, ok: false, status, ms, problem };
  } catch (e) {
    const code = e.cause?.code;
    const problem =
      code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? "its name doesn't resolve (check the DNS record in Cloudflare)"
        : e.name === 'TimeoutError'
          ? "it doesn't answer (timed out)"
          : "it can't be reached";
    return { host, url, ok: false, status: null, ms: null, problem, detail: code || e.message };
  }
}

/** @param {import('../types').Service} cfg */
async function cloudflared(cfg) {
  const [ready, latency] = await timed(() => req(join(cfg.url, '/ready'), { as: 'response', timeout: 5000 }));
  const readyBody = await ready.json().catch(() => null);
  const [metrics, pub] = await Promise.all([
    req(join(cfg.url, '/metrics'), { as: 'text', timeout: 5000 })
      .then(parseMetrics)
      .catch(() => []),
    // Once a minute is plenty, and keeps the dashboard's fast polling off the public site.
    Promise.all(publicUrls(cfg.publicUrls).map(u => cached(`cloudflared-public:${u}`, 60e3, () => checkPublic(u)))),
  ]);

  /** @param {string} name */
  const all = name => metrics.filter(m => m.name === name);
  /** @param {string} name */
  const one = name => all(name)[0]?.value ?? null;
  const connections = readyBody?.readyConnections ?? one('cloudflared_tunnel_ha_connections');
  // Very old versions have no /ready; then the connection count from /metrics decides.
  if (ready.status === 404 ? !(Number(connections) > 0) : !ready.ok)
    throw new Error('The tunnel is not connected to Cloudflare (0 connections)');

  const conns = Number(connections) || 0;
  const version = all('build_info')[0]?.labels.version || null;
  const locations = [
    ...new Set(
      all('cloudflared_tunnel_server_locations')
        .filter(m => m.value === 1)
        .map(m => m.labels.edge_location)
        .filter(Boolean),
    ),
  ];

  const events = pub
    .filter(p => !p.ok)
    .map(p => ({
      time: new Date().toISOString(),
      level: 'error',
      source: 'Public address',
      live: true,
      message: `${p.host} doesn't load from the internet: ${p.problem}`,
      detail: [p.url, p.status ? `HTTP ${p.status}` : p.detail].filter(Boolean).join('\n'),
    }));
  if (conns === 1)
    events.push({
      time: new Date().toISOString(),
      level: 'warn',
      source: 'Tunnel',
      live: true,
      message: 'The tunnel has only one connection to Cloudflare',
      detail: 'cloudflared normally keeps 4. It still works, but it has no backup if that connection drops.',
    });

  // What Settings → Test shows under "Connected".
  const note = [
    `${conns} connection${conns === 1 ? '' : 's'} to Cloudflare${locations.length ? ` (${locations.join(', ')})` : ''}.`,
    ...pub.map(p => (p.ok ? `✓ ${p.host} loads (HTTP ${p.status}).` : `✕ ${p.host}: ${p.problem}.`)),
  ].join(' ');

  return {
    version,
    latency,
    data: {
      note,
      stats: {
        connections: conns,
        locations,
        requests: one('cloudflared_tunnel_total_requests'),
        errors: one('cloudflared_tunnel_request_errors'),
        publicOk: pub.filter(p => p.ok).length,
        publicTotal: pub.length,
      },
      public: pub.map(({ host, url, ok, status, ms, problem }) => ({ host, url, ok, status, ms, problem })),
      events,
    },
  };
}

module.exports = { cloudflared, parseMetrics, publicUrls };
