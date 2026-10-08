// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Dashboard layout (Settings → Dashboard): which cards show and the order of the rows. The
// dashboard is a column of blocks; a block is one card or two side by side, and a pair moves
// together. Each card can be turned off on its own. Saved in config.json, so every screen
// (and TV mode) shows the same layout.
//
// The ids here are the elements in public/index.html (data-block on each row, id on each
// card); test/core.test.js checks they match.
'use strict';

const BLOCKS = [
  { id: 'summary', cards: [{ id: 'kpis', label: 'Summary numbers' }] },
  {
    id: 'playing',
    cards: [
      { id: 'now-playing', label: 'Now playing' },
      { id: 'services-card', label: 'Services' },
    ],
  },
  { id: 'map', cards: [{ id: 'map-card', label: 'Stream map' }] },
  { id: 'events', cards: [{ id: 'events-card', label: 'Errors & warnings' }] },
  { id: 'library', cards: [{ id: 'library-card', label: 'Library' }] },
  {
    id: 'downloads',
    cards: [
      { id: 'downloads-card', label: 'Downloads' },
      { id: 'upcoming-card', label: 'Coming up' },
    ],
  },
  { id: 'indexers', cards: [{ id: 'indexers-card', label: 'Indexer limits' }] },
  {
    id: 'recent',
    cards: [
      { id: 'recent-card', label: 'Recently added' },
      { id: 'requests-card', label: 'Requests' },
    ],
  },
  { id: 'space', cards: [{ id: 'space-card', label: "What's using space" }] },
  { id: 'unraid', cards: [{ id: 'unraid-card', label: 'Unraid' }] },
  { id: 'truenas', cards: [{ id: 'truenas-card', label: 'TrueNAS' }] },
  { id: 'trends', cards: [{ id: 'trends-card', label: 'Trends' }] },
  { id: 'watch', cards: [{ id: 'watch-card', label: 'Watch stats' }] },
  {
    id: 'system',
    cards: [
      { id: 'storage-card', label: 'Storage' },
      { id: 'host-card', label: 'Host' },
    ],
  },
];
const BLOCK_IDS = BLOCKS.map(b => b.id);
const CARD_IDS = new Set(BLOCKS.flatMap(b => b.cards.map(c => c.id)));

// Any input -> a complete, valid layout: known ids only, each once, and every block placed
// (blocks missing from a saved order, such as cards added in a later version, go at the end).
function clean(input) {
  const order = [...new Set((Array.isArray(input?.order) ? input.order : []).map(String))].filter(id =>
    BLOCK_IDS.includes(id),
  );
  const hidden = [...new Set((Array.isArray(input?.hidden) ? input.hidden : []).map(String))].filter(id =>
    CARD_IDS.has(id),
  );
  return { order: [...order, ...BLOCK_IDS.filter(id => !order.includes(id))], hidden };
}

/** What the dashboard gets: the saved layout plus which cards make up each row. @param {any} cfg */
const forDashboard = cfg => ({
  ...clean(cfg.layout),
  blocks: Object.fromEntries(BLOCKS.map(b => [b.id, b.cards.map(c => c.id)])),
});

module.exports = { BLOCKS, clean, forDashboard };
