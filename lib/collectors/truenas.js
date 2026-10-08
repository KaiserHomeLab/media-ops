// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// TrueNAS (JSON-RPC over WebSocket, lib/jsonrpc-ws.js): pools, disks, apps and alerts.
'use strict';
const crypto = require('node:crypto');
const { trace } = require('../http');
const rpc = require('../jsonrpc-ws');
const pins = require('../pins');

// TrueNAS 25.04+ (SCALE). Its REST API is gone in TrueNAS 26, so this uses the WebSocket API
// at wss://<host>/api/current, logging in with an API key and the username that owns it.
// Always wss, even when the address is entered as http://: TrueNAS revokes an API key the
// moment it's sent over plain http.
// Tells connections for different API keys apart without keeping the key itself in the map key:
// an HMAC with a random per-process secret (a fingerprint, not a stored password hash).
const FINGERPRINT_SECRET = crypto.randomBytes(32);
const keyFingerprint = apiKey => crypto.createHmac('sha256', FINGERPRINT_SECRET).update(String(apiKey)).digest('hex');

const truenasConns = new Map(); // host+user+key -> Promise<Connection>, reused between polls
const truenasUsed = new Map(); // same key -> last poll time
// Close connections nobody has polled for 10 minutes (a removed app, or a changed key).
setInterval(() => {
  for (const [key, at] of truenasUsed) {
    if (Date.now() - at < 10 * 60e3) continue;
    truenasConns.get(key)?.then(
      c => c.close(),
      () => {},
    );
    truenasConns.delete(key);
    truenasUsed.delete(key);
  }
}, 60e3).unref();

async function truenasLogin(cfg, fresh) {
  const u = new URL(cfg.url);
  const port = u.protocol === 'https:' && u.port ? Number(u.port) : 443;
  const open = async () => {
    const c = await rpc.connect(u.hostname, port);
    // Refuse a certificate that changed since the first connection, before sending the key.
    const pinError = pins.check(`${u.hostname}:${port}`, c.fingerprint);
    if (pinError) {
      c.close();
      throw new Error(pinError);
    }
    const r = await c
      .call(
        'auth.login_ex',
        [
          {
            mechanism: 'API_KEY_PLAIN',
            username: cfg.username,
            api_key: cfg.apiKey,
            login_options: { user_info: false },
          },
        ],
        { record: false },
      )
      .catch(e => {
        c.close();
        throw e;
      });
    if (r?.response_type !== 'SUCCESS') {
      c.close();
      throw new Error(
        {
          AUTH_ERR: 'TrueNAS refused the API key. Check the username is the one the key belongs to.',
          EXPIRED: 'The API key has expired or was revoked. Create a new one in TrueNAS.',
          OTP_REQUIRED: 'This account needs a one-time password; API keys for it need a different user.',
        }[r?.response_type] || `TrueNAS login failed (${r?.response_type || 'no answer'})`,
      );
    }
    return c;
  };
  if (fresh) return open(); // diagnostics: a clean connection, so the report shows the whole path
  const key = `${u.hostname}:${port}:${cfg.username}:${keyFingerprint(cfg.apiKey)}`;
  truenasUsed.set(key, Date.now());
  const existing = await truenasConns.get(key)?.catch(() => null);
  if (existing && !existing.closed) return existing;
  const p = open();
  truenasConns.set(key, p);
  return p.catch(e => {
    truenasConns.delete(key);
    throw e;
  });
}

const tnTime = v => (v && typeof v === 'object' && '$date' in v ? v.$date : v) || null;
// TrueNAS alert text contains HTML. It's escaped again before display; this just makes it plain
// text. Stray < and > (from a malformed or nested tag) are dropped after the tags are removed.
const stripHtml = s =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/[<>]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function truenas(cfg) {
  const tracing = !!trace.getStore();
  const t0 = performance.now();
  const c = await truenasLogin(cfg, tracing);
  const latency = Math.round(performance.now() - t0);
  try {
    const [info, pools, disksRaw, alerts, apps] = await Promise.all([
      c.call('system.info'),
      c.call('pool.query'),
      c.call('disk.query', [[], { extra: { pools: true } }]),
      c.call('alert.list').catch(() => []),
      c.call('app.query').catch(() => null), // not every install uses Apps
    ]);
    const names = disksRaw.map(d => d.name).filter(Boolean);
    // Cached by TrueNAS for 5 minutes; a missing reading just shows as "—".
    const temps = names.length ? await c.call('disk.temperatures', [names]).catch(() => ({})) : {};
    const tempOf = n => {
      const v = temps?.[n];
      const t = typeof v === 'number' ? v : (v?.temperature ?? v?.temp ?? v?.current);
      return Number.isFinite(t) ? Math.round(t) : null;
    };

    const disks = disksRaw
      .map(d => {
        const ssd = d.type === 'SSD';
        return {
          name: d.name,
          role: d.pool || 'not in a pool',
          status: 'DISK_OK',
          model: d.model || null,
          temp: tempOf(d.name),
          tempWarn: ssd ? 60 : 45,
          tempCrit: ssd ? 70 : 55,
          fullWarn: null,
          fullCrit: null,
          errors: 0,
          spinning: null,
          ssd,
          size: d.size || 0,
          used: null,
        };
      })
      .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name, undefined, { numeric: true }));

    const events = [];
    const ev = (level, source, message, detail) =>
      events.push({ time: new Date().toISOString(), level, source, message, detail: detail || null, live: true });
    const active = alerts.filter(a => !a.dismissed);
    const alertLevel = { WARNING: 'warn', ERROR: 'error', CRITICAL: 'error', ALERT: 'error', EMERGENCY: 'error' };
    for (const a of active) {
      const level = alertLevel[a.level];
      if (!level) continue; // INFO / NOTICE
      const text = stripHtml(a.formatted || a.text);
      ev(level, 'TrueNAS', text.length > 160 ? `${text.slice(0, 157)}…` : text, text.length > 160 ? text : null);
    }
    // TrueNAS raises its own alert for an unhealthy pool; only add one if that alert isn't there.
    const poolAlert = active.some(a => a.klass === 'VolumeStatus');
    const poolList = pools.map(p => {
      const scan = p.scan || {};
      if ((!p.healthy || p.status !== 'ONLINE') && !poolAlert)
        ev('error', 'Pool', `Pool ${p.name} is ${String(p.status || 'unhealthy').toLowerCase()}`);
      if (scan.state === 'FINISHED' && scan.errors > 0)
        ev(
          'warn',
          'Pool',
          `Last ${String(scan.function || 'scrub').toLowerCase()} of ${p.name} found ${scan.errors} errors`,
        );
      return {
        name: p.name,
        status: p.status,
        healthy: !!p.healthy,
        size: p.size ?? null,
        used: p.allocated ?? null,
        free: p.free ?? null,
        scan: scan.function
          ? {
              kind: scan.function,
              state: scan.state,
              progress: scan.percentage ?? null,
              errors: scan.errors ?? 0,
              end: tnTime(scan.end_time),
            }
          : null,
      };
    });
    for (const d of disks) {
      if (d.temp != null && d.temp >= d.tempCrit)
        ev('error', 'Pool', `Disk ${d.name} is critically hot`, `${d.temp} °C (critical at ${d.tempCrit} °C)`);
      else if (d.temp != null && d.temp >= d.tempWarn)
        ev('warn', 'Pool', `Disk ${d.name} is running hot`, `${d.temp} °C (warning at ${d.tempWarn} °C)`);
    }
    const appList = Array.isArray(apps)
      ? apps.map(a => ({ name: a.name, state: a.state, upgrade: !!a.upgrade_available }))
      : null;
    for (const a of appList || []) if (a.state === 'CRASHED') ev('error', 'Apps', `App ${a.name} has crashed`);

    return {
      version: String(info.version || '').replace(/^TrueNAS-(SCALE-)?/i, '') || null,
      latency,
      data: {
        server: info.hostname || null,
        pools: poolList,
        capacity: {
          total: poolList.reduce((n, p) => n + (p.size || 0), 0),
          used: poolList.reduce((n, p) => n + (p.used || 0), 0),
        },
        disks,
        apps: appList,
        alerts: active.filter(a => alertLevel[a.level]).length,
        events,
      },
    };
  } finally {
    if (tracing) c.close();
  }
}

module.exports = { truenas, stripHtml };
