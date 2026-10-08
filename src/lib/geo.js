// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Where streams are coming from, for the stream map. Locations come from Plex's own GeoIP
// service (plex.tv/api/v2/geoip, the same one Tautulli uses), authenticated with the Plex
// token you already saved, so viewer IPs never go to any other third party. Only city-level
// results leave the server; raw IPs are stripped before the page sees anything.
'use strict';
const { join, req } = require('./http');
const { isMedia } = require('./media');

const DAY = 864e5;
// The last poll's remote viewers: how many were placed, and why the rest weren't (no addresses).
/** @type {{ remote: number, located: number, unknown: Record<string, number> } | null} */
let last = null;
const PLEX_HEADERS = {
  'X-Plex-Product': 'Media Ops',
  'X-Plex-Client-Identifier': 'media-ops',
  Accept: 'application/xml',
};

// LAN, loopback, link-local, CGNAT/Tailscale (100.64/10) and IPv6 private ranges can't be located.
const PRIVATE =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/i;
/** @param {unknown} ip */
const clean = ip =>
  String(ip || '')
    .replace(/^::ffff:/i, '')
    .trim();
/** @param {string | null | undefined} ip */
const isPublic = ip => !!ip && !PRIVATE.test(ip);

// plex.tv answers in XML: <location city="…" subdivisions="…" country="…" code="US" coordinates="41.85, -87.65" …/>
// One pass, so an escaped entity stays escaped: "&amp;quot;" becomes "&quot;", not '"'.
const ENTITIES = { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' };
/** @param {string | undefined} s */
const unescapeXml = s =>
  s?.replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, e) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (e)]);
/** @param {string} xml @param {string} name */
const attr = (xml, name) => unescapeXml(new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1]) || null;

// Found locations are kept for a week; anything else (no location, a failed lookup) for 10
// minutes, so a plex.tv hiccup retries.
// Concurrent callers for the same key share one request.
const memo = new Map();
/** @param {string} key @param {() => Promise<any>} fn @returns {Promise<any>} */
function remember(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() < hit.until) return hit.value;
  // One entry per viewer address seen this week; drop expired ones now and then.
  if (memo.size > 2000) for (const [k, v] of memo) if (Date.now() >= v.until) memo.delete(k);
  const value = fn().catch(() => null);
  memo.set(key, { value, until: Infinity });
  value.then(v =>
    memo.set(key, { value: Promise.resolve(v), until: Date.now() + (v && v.lat != null ? 7 * DAY : 10 * 60e3) }),
  );
  return value;
}

// A location, or { why } when there isn't one: 'no-location' (plex.tv doesn't know the address;
// it answers city "Unknown" at 0, 0, which must not become a dot in the ocean) or 'failed'.
/** @param {string} ip @param {string} token */
function lookup(ip, token) {
  return remember(`ip:${ip}`, async () => {
    let xml;
    try {
      xml = await req(`https://plex.tv/api/v2/geoip?ip_address=${encodeURIComponent(ip)}`, {
        as: 'text',
        timeout: 5000,
        headers: { ...PLEX_HEADERS, 'X-Plex-Token': token },
      });
    } catch (e) {
      return { why: 'failed', detail: e.message };
    }
    const [lat, lon] = String(attr(xml, 'coordinates') || '')
      .split(',')
      .map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || attr(xml, 'city') === 'Unknown')
      return { why: 'no-location' };
    return {
      city: attr(xml, 'city'),
      region: attr(xml, 'subdivisions'),
      country: attr(xml, 'country'),
      code: attr(xml, 'code'),
      lat,
      lon,
    };
  });
}

// "lat, lon" typed in Settings, e.g. "41.88, -87.63".
/** @param {unknown} text */
function parseLatLon(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = Number(m[1]),
    lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// The server's own location: a manual override from Settings, or Plex's public address, geolocated.
/** @param {import('./types').Service} plex @param {string | undefined} override */
async function home(plex, override) {
  const manual = parseLatLon(override);
  if (manual) return { ...manual, city: null, country: null, manual: true };
  const publicIp = await remember(`pub:${plex.url}`, async () => {
    const xml = await req(join(plex.url, '/myplex/account'), {
      as: 'text',
      timeout: 5000,
      headers: { ...PLEX_HEADERS, 'X-Plex-Token': plex.token || '' },
    });
    return attr(xml, 'publicAddress');
  });
  const g = publicIp && isPublic(publicIp) ? await lookup(publicIp, plex.token || '') : null;
  return g?.lat != null ? g : null;
}

// Add `geo` to each remote stream and `home` to each media server's result, then drop raw IPs.
// Lookups go through plex.tv with the Plex token, so only Plex viewers are located: Plex already
// sees their addresses, while sending a Jellyfin or Emby viewer's address to plex.tv would
// share it with a third party. Those show in the viewer list as "location unknown". The
// server's own location can still come from a Plex server (it's the server's address, not a
// viewer's) or from Settings.
/** @param {import('./types').Polled[]} results @param {import('./types').Config} cfg */
async function enrich(results, cfg) {
  const enabled = cfg.map?.enabled !== false;
  const plexes = cfg.services.filter(s => s.kind === 'plex' && s.enabled !== false && s.token);
  for (const r of results) {
    if (!isMedia(r.kind) || !r.up || !Array.isArray(r.data?.streams)) continue;
    const own = cfg.services.find(s => s.id === r.id);
    const plex = own?.kind === 'plex' ? own : plexes[0];
    if (enabled) {
      await Promise.all(
        r.data.streams.map(async st => {
          st.geo = null;
          if (st.local) return;
          // Plex: `address` is what Plex sees; `remotePublicAddress` is what plex.tv sees (helps behind relays).
          const ip = [st.ip, st.publicIp].map(clean).find(isPublic);
          // Why a remote viewer isn't on the map, shown next to "location unknown".
          if (own?.kind !== 'plex') st.geoWhy = 'not-plex';
          else if (!ip) st.geoWhy = 'private';
          else {
            const g = await lookup(ip, own.token || '');
            if (g?.lat != null) st.geo = g;
            else st.geoWhy = g?.why || 'failed';
          }
        }),
      );
      r.data.home = plex
        ? await home(plex, cfg.map?.home)
        : parseLatLon(cfg.map?.home)
          ? { ...parseLatLon(cfg.map?.home), city: null, country: null, manual: true }
          : null;
    }
    r.data.mapEnabled = enabled;
  }
  // How the last poll's remote viewers were placed, for the debug report: counts only.
  /** @type {Record<string, number>} */
  const reasons = {};
  let remote = 0,
    located = 0;
  for (const r of results)
    for (const st of r.data?.streams || [])
      if (!st.local) {
        remote++;
        if (st.geo) located++;
        else reasons[st.geoWhy || 'map-off'] = (reasons[st.geoWhy || 'map-off'] || 0) + 1;
      }
  last = { remote, located, unknown: reasons };
  // Viewer IPs never reach the browser, whatever the server or setting.
  for (const r of results)
    for (const st of r.data?.streams || []) {
      delete st.ip;
      delete st.publicIp;
    }
}

const summary = () => last;

module.exports = { enrich, parseLatLon, unescapeXml, summary };
