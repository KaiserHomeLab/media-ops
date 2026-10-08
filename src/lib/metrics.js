// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Prometheus metrics (GET /metrics), for people who already graph their homelab in Grafana.
// Off until turned on in Settings, which creates a random token that Prometheus sends as
// `Authorization: Bearer <token>`. Reads the background monitor's last poll and never starts
// one, so scraping can't make Media Ops poll the apps more often.
//
// What's exported is the dashboard's numbers: apps up, latency and updates; streams and their
// bandwidth; download speeds and queues; wanted/missing; pending requests; active errors; disk
// space; host CPU and memory. Never addresses, keys, viewer names or anything from a log line.
'use strict';
const crypto = require('node:crypto');
const { allStreams, answered } = require('./media');
const pkg = require('../package.json');

/** @param {any} cfg */
const settingsOf = cfg => ({ enabled: !!cfg.metrics?.enabled, tokenSet: !!cfg.metrics?.token });

const newToken = () => crypto.randomBytes(24).toString('base64url');

// `Authorization: Bearer <token>`, compared in constant time.
/** @param {string | undefined} header @param {any} cfg */
function authorized(header, cfg) {
  const want = String(cfg.metrics?.token || '');
  const got = /^Bearer\s+(\S+)$/i.exec(String(header || ''))?.[1] || '';
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// Label values are user text (app names): escape backslash, quote and newline, as the format asks.
/** @param {unknown} v */
const label = v =>
  String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

/**
 * The exposition text. `raw` is the last poll (null right after a restart: then only
 * media_ops_info is sent); `events` the errors feed; `disks` the merged disk list.
 * @param {import('./types').PollResult | null} raw
 * @param {any[]} events
 * @param {{ path: string, total: number, free: number }[]} disks
 */
function render(raw, events, disks) {
  /** @type {Map<string, { help: string, type: string, rows: string[] }>} */
  const families = new Map();
  /** @param {string} name @param {string} help @param {Record<string, unknown>} labels @param {number} value @param {string} [type] */
  const add = (name, help, labels, value, type = 'gauge') => {
    if (!Number.isFinite(value)) return;
    const f = families.get(name) || { help, type, rows: [] };
    families.set(name, f);
    const l = Object.entries(labels)
      .map(([k, v]) => `${k}="${label(v)}"`)
      .join(',');
    f.rows.push(`${name}${l ? `{${l}}` : ''} ${value}`);
  };

  add('media_ops_info', 'Media Ops version (always 1)', { version: pkg.version }, 1);
  if (raw) {
    add('media_ops_last_poll_timestamp_seconds', 'When the apps were last checked', {}, (raw.generatedAt || 0) / 1000);
    for (const s of raw.services) {
      const app = { app: s.name, kind: s.kind };
      add('media_ops_app_up', 'Whether the app answered the last check (1 up, 0 down)', app, s.up ? 1 : 0);
      if (!s.up || !s.data) continue;
      if (s.latency != null)
        add('media_ops_app_latency_seconds', 'How long the app took to answer', app, s.latency / 1000);
      add('media_ops_app_update_available', 'Whether a newer version of the app is out', app, s.data.update ? 1 : 0);
      if (Array.isArray(s.data.queue))
        add('media_ops_arr_queue_items', 'Items in the app’s download queue', app, s.data.queue.length);
      if (s.data.stats?.missing != null)
        add('media_ops_arr_missing', 'Monitored items not on disk yet', app, Number(s.data.stats.missing));
      if (s.data.stats?.pending != null)
        add('media_ops_requests_pending', 'Requests waiting for approval', app, Number(s.data.stats.pending));
      if (s.data.client) {
        const client = { client: s.name, protocol: s.data.client };
        add('media_ops_download_bytes_per_second', 'Download speed', client, Number(s.data.downBps) || 0);
        add('media_ops_upload_bytes_per_second', 'Upload speed', client, Number(s.data.upBps) || 0);
        add('media_ops_download_items', 'Unfinished items in the download client', client, (s.data.items || []).length);
      }
    }

    // Streams per media server and kind of playback, and bandwidth by where the viewer is.
    const servers = new Map(raw.services.filter(answered).map(s => [s.id, s.name]));
    /** @type {Map<string, { server: string, decision: string, n: number }>} */
    const byDecision = new Map();
    /** @type {Map<string, { server: string, location: string, kbps: number }>} */
    const byPlace = new Map();
    for (const m of raw.services.filter(answered).filter(s => Array.isArray(s.data.streams)))
      for (const d of ['direct_play', 'direct_stream', 'transcode'])
        byDecision.set(`${m.id}|${d}`, { server: m.name, decision: d, n: 0 });
    for (const st of allStreams(raw.services)) {
      const server = servers.get(st.server) || '';
      const decision = String(st.decision || '').startsWith('Transcode')
        ? 'transcode'
        : st.decision === 'Direct Stream'
          ? 'direct_stream'
          : 'direct_play';
      const d = byDecision.get(`${st.server}|${decision}`);
      if (d) d.n++;
      const location = st.local ? 'lan' : 'wan';
      const key = `${st.server}|${location}`;
      const p = byPlace.get(key) || { server, location, kbps: 0 };
      p.kbps += Number(st.bandwidth) || 0;
      byPlace.set(key, p);
    }
    for (const d of byDecision.values())
      add('media_ops_streams', 'Streams playing now', { server: d.server, decision: d.decision }, d.n);
    for (const p of byPlace.values())
      add(
        'media_ops_stream_bandwidth_bits_per_second',
        'Bandwidth used by streams',
        { server: p.server, location: p.location },
        p.kbps * 1000,
      );

    const host = raw.host;
    if (host) {
      if (host.cpu != null) add('media_ops_host_cpu_ratio', 'Host CPU use (0 to 1)', {}, Number(host.cpu) / 100);
      if (host.memTotal) add('media_ops_host_memory_bytes', 'Host memory', { state: 'total' }, Number(host.memTotal));
      if (host.memUsed) add('media_ops_host_memory_bytes', 'Host memory', { state: 'used' }, Number(host.memUsed));
    }
  }

  // The errors feed as the dashboard counts it: what isn't dismissed, from the last 24 hours.
  const now = Date.now();
  const active = events.filter(e => !e.dismissed && now - e.t < 864e5);
  for (const level of ['error', 'warn'])
    add(
      'media_ops_events',
      'Errors and warnings on the dashboard (last 24 h, not dismissed)',
      { level: level === 'warn' ? 'warning' : 'error' },
      active.filter(e => e.level === level).length,
    );

  for (const d of disks) {
    add('media_ops_disk_size_bytes', 'Disk size', { path: d.path }, d.total);
    add('media_ops_disk_used_bytes', 'Disk space used', { path: d.path }, d.total - d.free);
  }

  return (
    [...families]
      .map(([name, f]) => [`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`, ...f.rows].join('\n'))
      .join('\n') + '\n'
  );
}

module.exports = { settingsOf, newToken, authorized, render, label };
