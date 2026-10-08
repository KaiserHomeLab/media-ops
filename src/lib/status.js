// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The public status page (/status): a page you can share with the people who use your server,
// so they can see whether Plex is up without asking. Off until turned on in Settings. Anyone
// who can reach it can read it, even with the dashboard locked, so it shows only what's listed
// here: each chosen app's name, whether it's up, and its uptime. No addresses, versions,
// errors or anything else from the apps.
'use strict';
const history = require('./history');

// Preselected the first time the page is turned on: what the people watching care about.
const AUDIENCE_KINDS = new Set(['plex', 'jellyfin', 'emby', 'seerr', 'overseerr', 'jellyseerr']);
const defaultServices = services => services.filter(s => AUDIENCE_KINDS.has(s.kind)).map(s => s.id);

/** @param {any} cfg */
const settingsOf = cfg => ({
  enabled: !!cfg.statusPage?.enabled,
  title: cfg.statusPage?.title || '',
  notice: cfg.statusPage?.notice || '',
  services: Array.isArray(cfg.statusPage?.services) ? cfg.statusPage.services : defaultServices(cfg.services),
});

// Settings form -> what's saved. Throws a message for the form on bad input.
function clean(input, services) {
  const title = String(input.title ?? '').trim();
  const notice = String(input.notice ?? '').trim();
  if (title.length > 80) throw new Error('Title is too long (80 characters at most)');
  if (notice.length > 500) throw new Error('Notice is too long (500 characters at most)');
  const known = new Set(services.map(s => s.id));
  const chosen = Array.isArray(input.services) ? input.services.map(String).filter(id => known.has(id)) : [];
  return { enabled: !!input.enabled, title, notice, services: [...new Set(chosen)] };
}

/**
 * What /api/status returns. `raw` is the last background poll (null right after a restart or a
 * settings change, until the next poll finishes).
 * @param {any} cfg @param {any} raw @param {(id: string) => any} [uptimeOf]
 */
function payload(cfg, raw, uptimeOf = history.uptime) {
  const st = settingsOf(cfg);
  const polled = new Map((raw?.services || []).map(s => [s.id, s]));
  const services = st.services
    .map(id => cfg.services.find(s => s.id === id))
    .filter(s => s && s.enabled !== false)
    .map(s => {
      const u = uptimeOf(s.id);
      const now = polled.get(s.id);
      return {
        name: String(s.name),
        up: now ? !!now.up : null, // null: not checked yet
        day: u?.day ?? null,
        week: u?.week ?? null,
        cells: Array.isArray(u?.cells) ? u.cells : [],
      };
    });
  return {
    title: st.title || 'Server status',
    notice: st.notice,
    checkedAt: raw?.generatedAt ?? null,
    services,
  };
}

module.exports = { settingsOf, clean, payload, defaultServices };
