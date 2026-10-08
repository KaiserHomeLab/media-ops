// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Shared helpers: escaping and number formatting for app values, cached card rendering,
// roll-up cards, the floating tooltip, and the store holding the latest data.
import { render } from './main.js';

export const store = { state: null, hist: null }; // latest /api/overview and /api/history

export const $ = id => document.getElementById(id);
export const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const num = n => (n == null ? '—' : Number(n).toLocaleString());
// Only http(s) links get an href: an address from settings or an app can never be javascript:.
export const safeHref = u => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');
export const n0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0); // numbers from apps, before they go into HTML
export const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export function bytes(b, digits = 1) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i < 2 ? 0 : digits)} ${u[i]}`;
}
export const rate = bps => `${bytes(bps)}/s`;
export const mbps = kbps => (kbps ? `${(kbps / 1000).toFixed(1)} Mbps` : '—');
export function clock(ms) {
  const s = Math.floor(ms / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function uptime(sec) {
  const d = Math.floor(sec / 86400),
    h = Math.floor((sec % 86400) / 3600),
    m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export const initials = s =>
  esc(
    (s || '?')
      .replace(/^(the|a)\s+/i, '')
      .slice(0, 2)
      .toUpperCase(),
  );

// Only touch the DOM when a section actually changed (prevents image flicker / hover loss).
export const lastHTML = new Map();
export function setHTML(el, html) {
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}

export function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const timeOf = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// --------------------------------------------------------------------- roll-up cards
// Cards with nothing to show (map with no viewers, no errors, empty download queue, no
// requests) shrink to a slim title bar and open again by themselves when something arrives.
// "Show" opens one anyway until it has content again.
const rollPeek = new Set();
export function rollUp(cardId, idle) {
  const card = $(cardId);
  if (!idle) rollPeek.delete(cardId);
  const collapsed = idle && !rollPeek.has(cardId);
  card.classList.toggle('collapsed', collapsed);
  card.querySelector('.roll-body').hidden = collapsed;
  const toggle = card.querySelector('.roll-toggle');
  toggle.hidden = !idle;
  toggle.textContent = collapsed ? 'Show' : 'Hide';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  return collapsed;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-roll]');
  if (!b) return;
  const id = b.dataset.roll;
  rollPeek.has(id) ? rollPeek.delete(id) : rollPeek.add(id);
  lastHTML.delete($('map')); // the map was drawn (or not) while hidden; redraw at the real width
  if (store.state) render(store.state);
});

export const tip = $('tooltip');
export function placeTip(e) {
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = e.clientX + 14;
  if (left + r.width > innerWidth - 8) left = e.clientX - r.width - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
}

// --------------------------------------------------------------------- media servers
// Plex, Jellyfin and Emby report streams, libraries and recently added items alike (see
// lib/media.js); several can run at once. Streams are tagged with their server's id.
export const MEDIA_KINDS = ['plex', 'jellyfin', 'emby'];
export const mediaServers = services => services.filter(s => s.up && MEDIA_KINDS.includes(s.kind));
export const allStreams = services =>
  mediaServers(services).flatMap(m => (m.data.streams || []).map(st => ({ ...st, server: m.id })));
// What the stream map needs: every stream, the server's location, and whether it's on.
export function mapSource(services) {
  const media = mediaServers(services);
  if (!media.length) return null;
  return {
    streams: allStreams(services),
    home: media.find(m => m.data.home)?.data.home || null,
    enabled: media.some(m => m.data.mapEnabled !== false),
  };
}
// A poster through the server's proxy (tokens stay on the server).
export const thumbUrl = (server, path) =>
  `/api/media/thumb?s=${encodeURIComponent(server)}&p=${encodeURIComponent(path)}`;
