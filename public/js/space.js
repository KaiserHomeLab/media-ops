// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// What's using space: biggest titles, recent downloads and cleanup candidates.
import { $, bytes, esc, safeHref, setHTML, store } from './util.js';

// --------------------------------------------------------------------- what's using space
let spaceTab = 'biggest';
const daysText = d => {
  if (d >= 365) { const y = Math.round(d / 365 * 10) / 10; return `${d >= 730 ? Math.round(y) : y} year${y === 1 ? '' : 's'}`; }
  return d >= 60 ? `${Math.round(d / 30)} months` : `${d} day${d === 1 ? '' : 's'}`;
};
const span = t => daysText(Math.floor((Date.now() - t) / 864e5));
export function renderSpace(sp) {
  const show = !!sp && (sp.biggest.length || sp.downloaded.items.length);
  $('space-card').hidden = !show;
  if (!show) return;
  $('space-tabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.space === spaceTab)));
  const c = sp.cleanup;
  $('space-sub').textContent = c?.count ? `${bytes(c.total)} in ${c.count} title${c.count === 1 ? '' : 's'} nobody watched in ${daysText(c.days)}` : '';

  let list = [], note = '', sizeOf = x => x.size, extra = () => '';
  if (spaceTab === 'biggest') {
    list = sp.biggest;
    note = 'The largest series, movies and artists, from Sonarr, Radarr and Lidarr.';
  } else if (spaceTab === 'downloaded') {
    list = sp.downloaded.items;
    sizeOf = x => x.bytes;
    extra = x => `${x.count} import${x.count === 1 ? '' : 's'}`;
    note = list.length ? `${bytes(sp.downloaded.total)} imported in the last 30 days (upgrades included, so it isn't all new space).${sp.downloaded.loading ? ' Still loading import history from some apps…' : ''}`
      : sp.downloaded.loading ? 'Loading import history… (this can take a minute on a big library)' : 'Nothing imported in the last 30 days.';
  } else if (!c) {
    note = sp.tautulli ? 'Collecting watch history from Tautulli…' : 'Add Tautulli (Settings → Add app) to see which movies and shows nobody watches.';
  } else {
    list = c.items;
    extra = x => (x.lastPlayed ? `last watched ${span(x.lastPlayed)} ago` : 'never watched') + (x.added ? ` · added ${span(x.added)} ago` : '');
    note = `${c.count ? `${bytes(c.total)} in ${c.count} titles` : 'Nothing'} not watched in ${daysText(c.days)}. Only a list: nothing is deleted.`
      + (c.historyDays != null && c.historyDays < c.days ? ` Tautulli's history only goes back ${c.historyDays} days, so earlier plays aren't counted.` : '');
  }
  $('space-note').textContent = note;
  const max = Math.max(1, ...list.map(sizeOf));
  setHTML($('space-list'), list.map(x => {
    const title = `${esc(x.title)}${x.year ? ` <span class="muted">(${esc(x.year)})</span>` : ''}`;
    return `<li class="sp-row">
      <span class="sp-t">${x.link ? `<a href="${safeHref(x.link)}" target="_blank" rel="noopener">${title}</a>` : title}
        <span class="sp-meta">${esc(x.app)}${extra(x) ? ` · ${esc(extra(x))}` : ''}</span></span>
      <span class="sp-bar" aria-hidden="true"><i style="width:${(sizeOf(x) / max * 100).toFixed(1)}%"></i></span>
      <span class="num">${bytes(sizeOf(x))}</span>
    </li>`;
  }).join(''));
}
$('space-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-space]');
  if (!b) return;
  spaceTab = b.dataset.space;
  if (store.state) renderSpace(store.state.space);
});
