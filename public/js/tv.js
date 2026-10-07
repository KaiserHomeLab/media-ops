// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// TV mode: a full-screen two-column layout for a wall display that never scrolls.
import { render } from './main.js';
import { $, lastHTML, store } from './util.js';

// --------------------------------------------------------------------- TV mode (wall display)
// Big, read-only, full-screen view. /?tv=1 opens straight into it (e.g. for a kiosk browser).
export function setTvMode(on) {
  document.body.classList.toggle('tv', on);
  $('tv-toggle').innerHTML = on ? '✕ <span class="hide-sm">Exit TV mode</span>' : '⛶ <span class="hide-sm">TV mode</span>';
  const url = new URL(location.href);
  on ? url.searchParams.set('tv', '1') : url.searchParams.delete('tv');
  history.replaceState(null, '', url);
  lastHTML.clear();
  if (store.state) render(store.state);
  tvLayout(on);
  lastHTML.clear();
  if (store.state) render(store.state);
}

// TV mode gets its own screen-sized layout instead of the long scrolling page: the headline
// row on top, then what's playing and the stream map on the left, and the things that need
// attention (services, errors, downloads, the server) on the right. Cards are moved into
// the two columns and put back exactly where they were on exit. Anything that doesn't fit is
// cut off rather than scrolled.
const TV_LEFT = ['now-playing', 'map-card'];
const TV_RIGHT = ['services-card', 'events-card', 'downloads-card', 'unraid-card', 'truenas-card'];
const tvHomes = [];
function tvLayout(on) {
  if (on && !tvHomes.length) {
    const cols = document.createElement('div');
    cols.id = 'tv-cols';
    cols.innerHTML = '<div class="tv-col" id="tv-left"></div><div class="tv-col" id="tv-right"></div>';
    $('kpis').after(cols);
    for (const [ids, col] of [[TV_LEFT, 'tv-left'], [TV_RIGHT, 'tv-right']]) for (const id of ids) {
      const el = $(id);
      const home = document.createComment(id);
      el.before(home);
      tvHomes.push([home, el]);
      $(col).append(el);
    }
  } else if (!on && tvHomes.length) {
    for (const [home, el] of tvHomes.splice(0)) home.replaceWith(el);
    $('tv-cols')?.remove();
  }
}
$('tv-toggle').addEventListener('click', async () => {
  const on = !document.body.classList.contains('tv');
  setTvMode(on);
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* full screen not allowed (e.g. iOS); TV mode still works */ }
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('tv')) setTvMode(false); });
setInterval(() => { $('tv-clock').textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }, 1000);
// Hide the mouse pointer after a few idle seconds in TV mode.
let idleTimer;
addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
});
