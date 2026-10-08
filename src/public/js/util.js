// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Shared helpers: escaping and number formatting for app values, cached card rendering,
// roll-up cards, the floating tooltip, and the store holding the latest data.
import { render } from './main.js';

/** @type {{ state: Overview | null, hist: any }} */
export const store = { state: null, hist: null }; // latest /api/overview and /api/history

// Elements by id. The ids are fixed in our own HTML, so one that's missing is a bug, not a case
// to handle: typed as always there.
/** @param {string} id */
export const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/** @type {Record<string, string>} */
const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// The element matching `selector` that an event happened in (event delegation), or null.
/** @param {Event} e @param {string} selector @returns {HTMLElement | null} */
export const closest = (e, selector) =>
  e.target instanceof Element ? /** @type {HTMLElement | null} */ (e.target.closest(selector)) : null;
/** @param {unknown} s */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ENTITY[c]);
/** @param {unknown} n */
export const num = n => (n == null ? '—' : Number(n).toLocaleString());
// Only http(s) links get an href: an address from settings or an app can never be javascript:.
/** @param {unknown} u */
export const safeHref = u => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');
/** @param {unknown} v */
export const n0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0); // numbers from apps, before they go into HTML
/** @template T @param {T[]} arr @param {(x: T) => unknown} f */
export const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

/** @param {number} b @param {number} [digits] */
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
/** @param {number} bps */
export const rate = bps => `${bytes(bps)}/s`;
/** @param {number | null | undefined} kbps */
export const mbps = kbps => (kbps ? `${(kbps / 1000).toFixed(1)} Mbps` : '—');
/** @param {number} ms */
export function clock(ms) {
  const s = Math.floor(ms / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** @param {number} sec */
export function uptime(sec) {
  const d = Math.floor(sec / 86400),
    h = Math.floor((sec % 86400) / 3600),
    m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
/** @param {unknown} s */
export const initials = s =>
  esc(
    String(s || '?')
      .replace(/^(the|a)\s+/i, '')
      .slice(0, 2)
      .toUpperCase(),
  );

// Only touch the DOM when a section actually changed (prevents image flicker / hover loss).
export const lastHTML = new Map();
/** @param {HTMLElement} el @param {string} html */
export function setHTML(el, html) {
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}

/** @param {number} t milliseconds since 1970 */
export function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** @param {number | string} t */
export const timeOf = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// --------------------------------------------------------------------- roll-up cards
// Cards with nothing to show (map with no viewers, no errors, empty download queue, no
// requests) shrink to a slim title bar and open again by themselves when something arrives.
// "Show" opens one anyway until it has content again.
/** @type {Set<string>} */
const rollPeek = new Set();
/** @param {string} cardId @param {boolean} idle @returns {boolean} whether it's rolled up */
export function rollUp(cardId, idle) {
  const card = $(cardId);
  if (!idle) rollPeek.delete(cardId);
  const collapsed = idle && !rollPeek.has(cardId);
  card.classList.toggle('collapsed', collapsed);
  /** @type {HTMLElement} */ (card.querySelector('.roll-body')).hidden = collapsed;
  const toggle = /** @type {HTMLElement} */ (card.querySelector('.roll-toggle'));
  toggle.hidden = !idle;
  toggle.textContent = collapsed ? 'Show' : 'Hide';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  return collapsed;
}
document.addEventListener('click', e => {
  const b = closest(e, '[data-roll]');
  if (!b) return;
  const id = b.dataset.roll || '';
  rollPeek.has(id) ? rollPeek.delete(id) : rollPeek.add(id);
  lastHTML.delete($('map')); // the map was drawn (or not) while hidden; redraw at the real width
  if (store.state) render(store.state);
});

export const tip = $('tooltip');
/** @param {MouseEvent} e */
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
// A list from an app's data: the array if it is one, otherwise empty.
/** @param {unknown} v @returns {any[]} */
export const list = v => (Array.isArray(v) ? v : []);
/** An app that answered, so it has data. @param {ServiceState} s @returns {s is ServiceState & { data: Record<string, any> }} */
export const answered = s => s.up && !!s.data;
/** @param {ServiceState[]} services */
export const mediaServers = services => services.filter(answered).filter(s => MEDIA_KINDS.includes(s.kind));
/** @param {ServiceState[]} services @returns {any[]} */
export const allStreams = services =>
  mediaServers(services).flatMap(m => list(m.data.streams).map(st => ({ ...st, server: m.id })));
// What the stream map needs: every stream, the server's location, whether it's on, and whether
// viewers it can't place go to Asgard.
/** @param {ServiceState[]} services */
export function mapSource(services) {
  const media = mediaServers(services);
  if (!media.length) return null;
  return {
    streams: allStreams(services),
    home: media.find(m => m.data.home)?.data.home || null,
    enabled: media.some(m => m.data.mapEnabled !== false),
    asgard: media.some(m => m.data.mapAsgard !== false),
  };
}
// A poster through the server's proxy (tokens stay on the server).
/** @param {string} server @param {string} path */
export const thumbUrl = (server, path) =>
  `/api/media/thumb?s=${encodeURIComponent(server)}&p=${encodeURIComponent(path)}`;
