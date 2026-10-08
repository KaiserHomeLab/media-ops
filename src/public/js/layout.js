// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The layout chosen under Settings → Dashboard: the order of the rows (data-block) and which
// cards are turned off. `layout.blocks` maps each row to its card ids (lib/layout.js). Cards
// turned off get .user-off rather than [hidden], because each card's own code sets [hidden]
// when it has nothing to show.
import { $ } from './util.js';

let applied = '';

/** @param {Overview['layout'] | undefined} layout */
export function applyLayout(layout) {
  const key = JSON.stringify(layout || null);
  if (!layout || key === applied) return;
  applied = key;
  const dash = $('dash');
  const off = new Set(layout.hidden);
  for (const id of layout.order) {
    const block = dash.querySelector(`:scope > [data-block="${CSS.escape(id)}"]`);
    if (block) dash.append(block);
  }
  // Cards are found by id, not by position: TV mode moves some out of their row.
  for (const [id, cardIds] of Object.entries(layout.blocks)) {
    for (const c of cardIds) $(c)?.classList.toggle('user-off', off.has(c));
    document.querySelector(`[data-block="${CSS.escape(id)}"]`)?.classList.toggle(
      'user-off',
      cardIds.every(c => off.has(c)),
    );
  }
  // TV mode's columns sit right after the summary row; keep them there if it moved.
  const tvCols = $('tv-cols');
  if (tvCols) $('kpis').after(tvCols);
}
