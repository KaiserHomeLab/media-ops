// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Now playing: one card per Plex stream.
import { $, clock, esc, initials, mbps, setHTML } from './util.js';

export function renderStreams(streams, demo, plexId) {
  $('np-count').textContent = streams.length ? `${streams.length} active` : '';
  if (!streams.length) return setHTML($('streams'), '<div class="empty">Nothing playing. The server is resting.</div>');

  const html = streams
    .map(s => {
      const poster =
        s.thumb && !demo
          ? `<img class="poster" loading="lazy" alt="" src="/api/plex/thumb?p=${encodeURIComponent(s.thumb)}" data-fallback="${initials(s.title)}">`
          : `<div class="poster" aria-hidden="true">${initials(s.title)}</div>`;
      const dc = s.decision.startsWith('Transcode') ? 'tc' : s.decision === 'Direct Play' ? 'dp' : 'ds';
      const chips = [
        `<span class="chip ${dc}"${s.hwName ? ` title="Hardware: ${esc(s.hwName)}"` : ''}>${esc(s.decision)}${s.hw && dc === 'tc' ? ' (HW)' : ''}${s.transcodeSpeed ? ` ${esc(s.transcodeSpeed)}×` : ''}</span>`,
        s.fourKTranscode &&
          '<span class="chip k4" title="4K transcodes are the heaviest load on the server">4K transcode</span>',
        s.resolution &&
          `<span class="chip">${esc(/^\d+$/.test(s.resolution) ? s.resolution + 'p' : s.resolution.toUpperCase())}</span>`,
        s.videoCodec && `<span class="chip">${esc(s.videoCodec.toUpperCase())}</span>`,
        s.audioCodec && `<span class="chip">${esc(s.audioCodec.toUpperCase())}</span>`,
        s.bandwidth && `<span class="chip">${mbps(s.bandwidth)}</span>`,
        `<span class="chip">${s.local ? 'LAN' : 'WAN'}</span>`,
      ]
        .filter(Boolean)
        .join('');
      const pct = s.duration ? Math.min(100, (s.offset / s.duration) * 100) : 0;
      return `<article class="stream ${esc(s.type)}">
      ${poster}
      <div style="min-width:0">
        <div class="row1"><div class="title">${esc(s.title)}</div><span class="state">${s.state === 'paused' ? '❚❚ paused' : s.state === 'buffering' ? '◌ buffering' : '▶ playing'}${s.sessionId && plexId ? `<button class="mini-btn" type="button" data-stop="${esc(s.sessionId)}" data-svc="${esc(plexId)}" data-user="${esc(s.user)}" title="Stop this stream">■ Stop</button>` : ''}</span></div>
        <div class="subtitle">${esc(s.subtitle)}</div>
        <div class="who"><b>${esc(s.user)}</b> on ${esc(s.player || s.product)} · ${esc(s.product)}${s.platform ? ` (${esc(s.platform)})` : ''}</div>
        <div class="chips">${chips}</div>
        ${s.reason ? `<div class="why"><span>Likely reason:</span> ${esc(s.reason)}</div>` : ''}
        <div class="progress"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="t">${clock(s.offset)} / ${clock(s.duration)}</span></div>
      </div>
    </article>`;
    })
    .join('');
  setHTML($('streams'), html);
  $('streams')
    .querySelectorAll('img[data-fallback]')
    .forEach(img =>
      img.addEventListener(
        'error',
        () => {
          const div = document.createElement('div');
          div.className = 'poster';
          div.textContent = img.dataset.fallback;
          img.replaceWith(div);
        },
        { once: true },
      ),
    );
}
