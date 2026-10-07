// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Where streams are coming from, for the stream map. Locations come from Plex's own GeoIP
// service (plex.tv/api/v2/geoip, the same one Tautulli uses), authenticated with the Plex
// token you already saved, so viewer IPs never go to any other third party. Only city-level
// results leave the server; raw IPs are stripped before the page sees anything.
'use strict';
const { join, req } = require('./http');

const DAY = 864e5;
const PLEX_HEADERS = { 'X-Plex-Product': 'Media Ops', 'X-Plex-Client-Identifier': 'media-ops', Accept: 'application/xml' };

// LAN, loopback, link-local, CGNAT/Tailscale (100.64/10) and IPv6 private ranges can't be located.
const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/i;
const clean = ip => String(ip || '').replace(/^::ffff:/i, '').trim();
const isPublic = ip => !!ip && !PRIVATE.test(ip);

// plex.tv answers in XML: <location city="…" subdivisions="…" country="…" code="US" coordinates="41.85, -87.65" …/>
const unescape = s => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attr = (xml, name) => unescape(new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1]) || null;

// Successful lookups are kept for a week, failures for 10 minutes (so a plex.tv hiccup retries).
// Concurrent callers for the same key share one request.
const memo = new Map();
function remember(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() < hit.until) return hit.value;
  // One entry per viewer address seen this week; drop expired ones now and then.
  if (memo.size > 2000) for (const [k, v] of memo) if (Date.now() >= v.until) memo.delete(k);
  const value = fn().catch(() => null);
  memo.set(key, { value, until: Infinity });
  value.then(v => memo.set(key, { value: Promise.resolve(v), until: Date.now() + (v ? 7 * DAY : 10 * 60e3) }));
  return value;
}

function lookup(ip, token) {
  return remember(`ip:${ip}`, async () => {
    const xml = await req(`https://plex.tv/api/v2/geoip?ip_address=${encodeURIComponent(ip)}`, {
      as: 'text', timeout: 5000, headers: { ...PLEX_HEADERS, 'X-Plex-Token': token },
    });
    const [lat, lon] = String(attr(xml, 'coordinates') || '').split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { city: attr(xml, 'city'), region: attr(xml, 'subdivisions'), country: attr(xml, 'country'), code: attr(xml, 'code'), lat, lon };
  });
}

// "lat, lon" typed in Settings, e.g. "41.88, -87.63".
function parseLatLon(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// The server's own location: a manual override from Settings, or Plex's public address, geolocated.
async function home(plex, override) {
  const manual = parseLatLon(override);
  if (manual) return { ...manual, city: null, country: null, manual: true };
  const publicIp = await remember(`pub:${plex.url}`, async () => {
    const xml = await req(join(plex.url, '/myplex/account'), { as: 'text', timeout: 5000, headers: { ...PLEX_HEADERS, 'X-Plex-Token': plex.token } });
    return attr(xml, 'publicAddress');
  });
  return publicIp && isPublic(publicIp) ? lookup(publicIp, plex.token) : null;
}

// Add `geo` to each remote stream and `home` to the Plex result, then drop raw IPs.
async function enrich(results, cfg) {
  const enabled = cfg.map?.enabled !== false;
  for (const r of results) {
    if (r.kind !== 'plex' || !r.up) continue;
    const plex = cfg.services.find(s => s.id === r.id);
    if (enabled && plex) {
      await Promise.all(r.data.streams.map(async st => {
        // `address` is what Plex sees; `remotePublicAddress` is what plex.tv sees (helps behind relays).
        const ip = [st.ip, st.publicIp].map(clean).find(isPublic);
        st.geo = !st.local && ip ? await lookup(ip, plex.token) : null;
      }));
      r.data.home = await home(plex, cfg.map?.home);
    }
    r.data.mapEnabled = enabled;
    for (const st of r.data.streams) { delete st.ip; delete st.publicIp; }
  }
}

module.exports = { enrich, parseLatLon };
