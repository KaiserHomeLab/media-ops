// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The live strip in the top bar: streams, download speed, apps up and errors, one click from
// their cards. It shows once the summary row has scrolled out of view (or is turned off), so it
// never repeats what's already on screen. Narrower screens drop streams and downloads first and
// phones get the short form ("✕ 1 down", "⚠ 6"); hidden in TV mode, and Settings → Appearance
// can turn it off. Same numbers as the summary row.
import { $, esc, mbps, rate, setHTML } from './util.js';

const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);

export function renderStrip(d, { streams, clients }) {
  const down = d.services.filter(s => !s.up);
  const errors = d.events.filter(e => !e.dismissed && e.level === 'error' && Date.now() - e.t < 864e5).length;
  const bw = mbps(sum(streams, s => s.bandwidth));
  const dl = rate(sum(clients, c => c.data.downBps));
  // text: the full label; short: what phones show next to the icon.
  const items = [
    {
      to: 'now-playing',
      wide: true,
      icon: '▶',
      text: streams.length ? `${streams.length} streaming · ${bw}` : 'nothing playing',
      short: String(streams.length),
    },
    clients.length && { to: 'downloads-card', wide: true, icon: '↓', text: dl, short: dl },
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
    errors && {
      to: 'events-card',
      state: 'warn',
      icon: '⚠',
      text: `${errors} error${errors === 1 ? '' : 's'}`,
      short: String(errors),
    },
  ].filter(Boolean);
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

// Show the strip only while the summary row is off screen.
const observer = new IntersectionObserver(([entry]) => {
  document.body.classList.toggle('strip-on', !entry.isIntersecting);
});
observer.observe($('kpis'));
