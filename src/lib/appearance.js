// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings → Appearance: light or dark, the accent color, a custom title and logo, and how the
// public status page looks. The server writes these into each page's HTML before sending it
// (data-theme / data-accent on <html>, the title, the logo), so the page never flashes the
// default look first and no inline script is needed under the strict CSP.
//
// Accents are a fixed list with colors chosen for contrast in both themes (public/style.css):
// text and buttons stay readable whichever is picked. Status colors (up, warning, down) and
// chart colors never change with the theme.
'use strict';
const crypto = require('node:crypto');

const THEMES = ['auto', 'dark', 'light'];
// dark/light: the shades in public/style.css (a test checks they match), for the swatches.
const ACCENTS = [
  { id: 'amber', label: 'Plex amber', dark: '#e5a00d', light: '#8f6200' },
  { id: 'purple', label: 'Jellyfin purple', dark: '#b98cf0', light: '#7a3fbf' },
  { id: 'green', label: 'Emby green', dark: '#5cc46a', light: '#2c7a35' },
  { id: 'blue', label: 'Blue', dark: '#6aa6f2', light: '#1f63c7' },
  { id: 'teal', label: 'Teal', dark: '#3cc4b2', light: '#00756a' },
  { id: 'red', label: 'Red', dark: '#f07a70', light: '#c0302a' },
];
const LOGO_MAX = 256 * 1024;
// Raster images only, recognised by their first bytes: an SVG can carry script.
const LOGO_TYPES = [
  { type: 'image/png', magic: b => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { type: 'image/jpeg', magic: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/webp',
    magic: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

const pick = (v, list, def) => (list.includes(v) ? v : def);

/** The saved settings, with defaults. The logo comes back as just { type, hash }. @param {any} cfg */
function settingsOf(cfg) {
  const a = cfg.appearance || {};
  return {
    theme: pick(a.theme, THEMES, 'auto'),
    accent: pick(
      a.accent,
      ACCENTS.map(x => x.id),
      'amber',
    ),
    title: typeof a.title === 'string' ? a.title.slice(0, 40) : '',
    statusTheme: pick(a.statusTheme, THEMES, 'auto'),
    liveStrip: a.liveStrip !== false,
    logo: a.logo?.data ? { type: a.logo.type, hash: a.logo.hash } : null,
  };
}

// Settings form -> what's saved (the logo is kept; it has its own upload and remove).
function clean(input, current) {
  const title = String(input?.title ?? '').trim();
  if (title.length > 40) throw new Error('Title is too long (40 characters at most)');
  if (/[<>]/.test(title)) throw new Error("Title can't contain < or >");
  return {
    theme: pick(input?.theme, THEMES, 'auto'),
    accent: pick(
      input?.accent,
      ACCENTS.map(x => x.id),
      'amber',
    ),
    title,
    statusTheme: pick(input?.statusTheme, THEMES, 'auto'),
    liveStrip: input?.liveStrip !== false,
    logo: current?.logo?.data ? current.logo : null,
  };
}

// An uploaded logo (base64) -> { type, data, hash }, or an error message for the form.
function logoFrom(base64) {
  const data = Buffer.from(String(base64 || ''), 'base64');
  if (!data.length) throw new Error('No image received');
  if (data.length > LOGO_MAX) throw new Error('The logo must be 256 KB or smaller');
  const kind = LOGO_TYPES.find(t => t.magic(data));
  if (!kind) throw new Error('Use a PNG, JPEG or WebP image');
  return {
    type: kind.type,
    data: data.toString('base64'),
    hash: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16),
  };
}

const escapeHtml = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Put the appearance into a page's HTML. `page` is 'dashboard', 'settings' or 'status'.
 * @param {string} html @param {any} cfg @param {string} page
 */
function renderPage(html, cfg, page) {
  const a = settingsOf(cfg);
  const theme = page === 'status' ? a.statusTheme : a.theme;
  const attrs = [
    theme !== 'auto' && `data-theme="${theme}"`,
    a.accent !== 'amber' && `data-accent="${a.accent}"`,
    page === 'dashboard' && !a.liveStrip && 'data-strip="off"',
  ]
    .filter(Boolean)
    .join(' ');
  let out = html;
  if (attrs) out = out.replace('<html lang="en">', `<html lang="en" ${attrs}>`);
  if (a.title) {
    const t = escapeHtml(a.title);
    out = out
      .replace('<title>Media Ops</title>', `<title>${t}</title>`)
      .replace('<h1>Media Ops</h1>', `<h1>${t}</h1>`)
      .replace('<title>Media Ops Settings</title>', `<title>${t} Settings</title>`)
      .replace('<div class="sub">Media Ops</div>', `<div class="sub">${t}</div>`);
  }
  const logo = a.logo ? `<img class="logo custom" src="/branding/logo?v=${a.logo.hash}" alt="">` : '';
  if (logo) out = out.replace('<span class="logo" aria-hidden="true"></span>', logo);
  return out.replace('<!--brand-logo-->', logo);
}

// What changes the pages: part of their cache key and ETag.
const pageKey = cfg => JSON.stringify(settingsOf(cfg));

module.exports = { THEMES, ACCENTS, settingsOf, clean, logoFrom, renderPage, pageKey, LOGO_MAX };
