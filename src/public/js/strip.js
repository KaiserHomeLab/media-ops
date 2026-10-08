// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The live strip in the top bar: streams, download speed, apps up and errors, one click from
// their cards. It shows once the summary row has scrolled out of view (or is turned off), so it
// never repeats what's already on screen. Narrower screens drop streams and downloads first and
// phones get the short form ("✕ 1 down", "⚠ 6"); hidden in TV mode, and Settings → Appearance
// can turn it off. Same numbers as the summary row.
import { $, esc, list, mbps, rate, setHTML, sum } from './util.js';

/** @param {Overview} d @param {{ streams: any[], clients: ServiceState[] }} parts */
export function renderStrip(d, { streams, clients }) {
  const down = d.services.filter(s => !s.up);
  const errors = d.events.filter(e => !e.dismissed && e.level === 'error' && Date.now() - e.t < 864e5).length;
  const bw = mbps(sum(streams, s => s.bandwidth));
  const dl = rate(sum(clients, c => c.data?.downBps));
  // text: the full label; short: what phones show next to the icon.
  /** @type {{ to: string, wide?: boolean, state?: string, icon: string, text: string, short: string }[]} */
  const items = [
    {
      to: 'now-playing',
      wide: true,
      icon: '▶',
      text: streams.length ? `${streams.length} streaming · ${bw}` : 'nothing playing',
      short: String(streams.length),
    },
    ...(clients.length ? [{ to: 'downloads-card', wide: true, icon: '↓', text: dl, short: dl }] : []),
    down.length
      ? {
          to: 'services-card',
          state: 'bad',
          icon: '✕',
          text: down.length === 1 ? `${down[0].name} is down` : `${down.length} apps down`,
          short: `${down.length} down`,
        }
      : {
          to: 'services-card',
          state: 'good',
          icon: '●',
          text: `${d.services.length}/${d.services.length} up`,
          short: `${d.services.length} up`,
        },
    ...(errors
      ? [
          {
            to: 'events-card',
            state: 'warn',
            icon: '⚠',
            text: `${errors} error${errors === 1 ? '' : 's'}`,
            short: String(errors),
          },
        ]
      : []),
  ];
  setHTML(
    $('strip'),
    items
      .map(
        i =>
          `<a class="strip-item${i.wide ? ' wide' : ''}${i.state ? ` ${i.state}` : ''}" href="#${i.to}" title="${esc(i.text)}"><span class="ic" aria-hidden="true">${i.icon}</span><span class="long">${esc(i.text)}</span><span class="short">${esc(i.short)}</span></a>`,
      )
      .join(''),
  );
}

// Cloudflare Tunnel badge, always in the top bar (not part of the strip, which comes and goes):
// red when a tunnel is down or one of the public addresses it serves stops loading.
/** @param {Overview} d */
export function renderTunnel(d) {
  const el = $('tunnel');
  const tunnels = d.services.filter(s => s.kind === 'cloudflared');
  el.hidden = !tunnels.length;
  if (!tunnels.length) return;
  const down = tunnels.filter(s => !s.up);
  /** @type {{ host: string, ok: boolean, problem?: string }[]} */
  const failing = tunnels.flatMap(s => (s.up ? list(s.data?.public).filter(p => !p.ok) : []));
  const bad = down.length || failing.length;
  const text = down.length
    ? down.length === 1
      ? `${down[0].name} down`
      : `${down.length} tunnels down`
    : failing.length === 1
      ? `${failing[0].host} unreachable`
      : failing.length
        ? `${failing.length} sites unreachable`
        : 'Tunnel up';
  const title = tunnels
    .map(s =>
      s.up
        ? [
            `${s.name}: connected (${s.data?.stats?.connections ?? '?'} connections to Cloudflare)`,
            ...list(s.data?.public).map(p => (p.ok ? `✓ ${p.host} loads` : `✕ ${p.host}: ${p.problem}`)),
          ].join('\n')
        : `${s.name}: ${s.error}`,
    )
    .join('\n\n');
  el.className = `strip-item tunnel-pill ${bad ? 'bad' : 'good'}`;
  el.title = title;
  el.setAttribute('aria-label', `Cloudflare Tunnel: ${text}`);
  setHTML(
    el,
    `<span class="ic" aria-hidden="true">☁</span><span class="long">${esc(text)}</span><span class="short">${bad ? '✕' : '●'}</span>`,
  );
}

// Show the strip only while the summary row is off screen.
const observer = new IntersectionObserver(([entry]) => {
  document.body.classList.toggle('strip-on', !entry.isIntersecting);
});
observer.observe($('kpis'));
