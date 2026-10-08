// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Dashboard entry point: polls /api/overview, renders every card, and starts TV mode when
// the address asks for it (?tv=1).
import { renderTrends, renderWatch } from './charts.js';
import { renderDownloads, renderIndexers, renderRecent, renderRequests, renderUpcoming } from './downloads.js';
import { renderEvents } from './events.js';
import { renderMap } from './map.js';
import { renderSpace } from './space.js';
import { renderStreams } from './streams.js';
import { applyLayout } from './layout.js';
import { renderKpis, renderLibrary, renderServices } from './summary.js';
import { renderDisks, renderHost, renderTrueNAS, renderUnraid } from './system.js';
import { setTvMode } from './tv.js';
import { $, allStreams, esc, lastHTML, mapSource, mediaServers, setHTML, store, uptime } from './util.js';

// --------------------------------------------------------------------- polling
let lastOk = 0;
let timer = null;

// Poll loop. The next request is scheduled only after this one finishes, so a slow server never
// piles up requests; switching back to the tab refreshes immediately.
export async function refresh() {
  clearTimeout(timer);
  try {
    const r = await fetch('/api/overview', { cache: 'no-store' });
    if (r.status === 401) {
      location.href = `/settings?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    if (!r.ok) throw new Error(r.status);
    store.state = await r.json();
    lastOk = Date.now();
    render(store.state);
  } catch (e) {
    console.warn('refresh failed', e);
  }
  // A hidden tab doesn't poll; coming back to it refreshes at once (visibilitychange below).
  if (!document.hidden) timer = setTimeout(refresh, (store.state?.refreshSeconds || 10) * 1000);
}

// "Settings aren't password-protected" can be hidden for 30 days (per browser).
const NUDGE_KEY = 'mo-lock-nudge-hidden';
const nudgeHidden = () => {
  try {
    return Date.now() - Number(localStorage.getItem(NUDGE_KEY) || 0) < 30 * 864e5;
  } catch {
    return false;
  }
};
$('lock-nudge-close').addEventListener('click', () => {
  try {
    localStorage.setItem(NUDGE_KEY, String(Date.now()));
  } catch {
    /* private mode: hide for now only */
  }
  $('lock-nudge').hidden = true;
});

// History (uptime, trends, forecasts) changes slowly, so it's fetched once a minute.
async function loadHistory() {
  try {
    store.hist = await (await fetch('/api/history', { cache: 'no-store' })).json();
    if (store.state) render(store.state);
  } catch {
    /* keep the last copy */
  }
  setTimeout(loadHistory, 60e3);
}

setInterval(() => {
  if (!lastOk) return;
  const ago = Math.round((Date.now() - lastOk) / 1000);
  $('updated').textContent = ago < 2 ? 'live' : `updated ${ago}s ago`;
  $('live').classList.toggle('stale', ago > (store.state?.refreshSeconds || 10) * 3);
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

// --------------------------------------------------------------------- render
export function render(d) {
  const up = kind => d.services.filter(s => s.kind === kind && s.up);
  const all = kinds => d.services.filter(s => kinds.includes(s.kind) && s.up);
  const arrs = all(['sonarr', 'radarr', 'lidarr', 'readarr']);
  const media = mediaServers(d.services);
  const streams = allStreams(d.services);
  const clients = d.services.filter(s => s.up && s.data?.client); // download clients

  applyLayout(d.layout);
  $('demo-badge').hidden = !d.demo;
  $('lock-nudge').hidden = d.demo || d.settingsLocked !== false || nudgeHidden();
  $('self-update').hidden = !d.latestVersion;
  if (d.latestVersion) {
    $('self-update').textContent = `⬆ Media Ops ${d.latestVersion}`;
    $('self-update').title =
      `You have ${d.version}. Update the container: Unraid Docker tab → Check for Updates, or TrueNAS Apps → Update.`;
  }
  const firstRun = !d.demo && !d.configured;
  $('welcome').hidden = !firstRun;
  $('dash').hidden = firstRun;
  const sys = !d.host.system || d.host.system === 'Linux' ? d.host.platform : d.host.system;
  $('hostline').textContent = `${d.host.hostname} · ${sys} · up ${uptime(d.host.uptime)}`;
  $('hostline').title = d.host.platform || '';

  renderAlerts(d);
  renderKpis(d, { streams, arrs, clients });
  renderStreams(streams, d.demo);
  renderServices(d.services);
  renderMap(mapSource(d.services));
  renderEvents(d);
  renderLibrary(media, d.services);
  renderDownloads(clients, arrs);
  renderIndexers(up('prowlarr'));
  renderSpace(d.space);
  renderUpcoming(arrs);
  renderWatch(up('tautulli')[0]);
  renderTrends();
  renderUnraid(up('unraid')[0]);
  renderTrueNAS(up('truenas')[0]);
  renderRecent(media, arrs);
  renderRequests(all(['seerr', 'overseerr', 'jellyseerr']));
  renderDisks(d, arrs);
  renderHost(d.host, d.docker, d.gpus, media.find(m => m.data.resources)?.data.resources);
}

function renderAlerts(d) {
  const items = d.events
    .filter(e => e.live && !e.dismissed && e.source !== 'Queue')
    .map(e => ({
      cls: e.level === 'error' ? 'error' : '',
      html: `<b>${esc(e.svc)}</b> ${esc(e.source === 'Connection' ? `is unreachable — ${e.message.replace(/^Unreachable — /, '')}` : e.message)}`,
      key: e.key,
      svcId: e.svcId,
    }));
  if (Array.isArray(d.docker))
    for (const c of d.docker.filter(x => x.health === 'unhealthy'))
      items.push({ cls: 'error', html: `<b>${esc(c.name)}</b> container is unhealthy` });

  const el = $('alerts');
  el.hidden = !items.length;
  setHTML(
    el,
    items
      .map(
        a =>
          `<div class="alert ${a.cls}"><span aria-hidden="true">${a.cls === 'error' ? '✕' : '⚠'}</span><div>${a.html}</div>${
            a.key
              ? `
      <span class="alert-acts"><button class="icon-btn" type="button" data-recheck="${esc(a.svcId)}" title="Re-check" aria-label="Re-check">↻</button><button class="icon-btn" type="button" data-dismiss="${esc(a.key)}" title="Dismiss" aria-label="Dismiss">✕</button></span>`
              : ''
          }</div>`,
      )
      .join(''),
  );
}

addEventListener('resize', () => {
  lastHTML.delete($('plays-chart'));
  lastHTML.delete($('map'));
  if (store.state) renderMap(mapSource(store.state.services));
  if (store.state) renderWatch(store.state.services.find(s => s.kind === 'tautulli' && s.up));
});

if (new URLSearchParams(location.search).get('tv') === '1') setTvMode(true);

refresh();
loadHistory();
