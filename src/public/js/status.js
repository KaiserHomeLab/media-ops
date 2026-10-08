// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Public status page: loads /api/status every 30 seconds and shows whether each app is up,
// with its uptime over the last 24 hours. Builds DOM nodes with textContent (no HTML strings),
// so nothing from the server can become markup.

/** @param {string} id */
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} tag @param {string} [cls] @param {string} [text] */
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
/** @param {number | null} v */
const pct = v => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.9995 || v === 0 ? 0 : 1)}%`);

/** @param {{ title: string, notice: string, checkedAt: number | null, services: { name: string, up: boolean | null, day: number | null, week: number | null, cells: (number | null)[] }[] }} d */
function render(d) {
  document.title = d.title;
  $('stp-title').textContent = d.title;
  $('stp-notice').hidden = !d.notice;
  $('stp-notice').textContent = d.notice || '';

  const down = d.services.filter(s => s.up === false);
  const checked = d.services.some(s => s.up != null);
  const overall = $('stp-overall');
  overall.dataset.state = !checked ? 'checking' : down.length ? 'down' : 'up';
  overall.textContent = !d.services.length
    ? 'Nothing to show yet.'
    : !checked
      ? 'Checking…'
      : down.length
        ? `${down.map(s => s.name).join(', ')} ${down.length === 1 ? 'is' : 'are'} down`
        : 'Everything is up';

  const list = $('stp-list');
  list.replaceChildren(
    ...d.services.map(s => {
      const state = s.up == null ? 'checking' : s.up ? 'up' : 'down';
      const li = el('li', `stp-row is-${state}`);
      const head = el('div', 'stp-row-head');
      head.append(el('span', 'stp-dot'), el('span', 'stp-name', s.name));
      head.append(el('span', 'stp-state', state === 'checking' ? 'Checking' : state === 'up' ? 'Up' : 'Down'));
      li.append(head);
      if (s.cells.some(c => c != null)) {
        // 48 half-hour cells, oldest first. The percentages carry the meaning; color only
        // reinforces it, so the bar is hidden from screen readers.
        const bar = el('div', 'upbar stp-bar');
        bar.setAttribute('aria-hidden', 'true');
        for (const c of s.cells) bar.append(el('i', c == null ? 'none' : c >= 0.999 ? 'ok' : c > 0 ? 'part' : 'bad'));
        const scale = el('div', 'stp-scale');
        scale.append(el('span', '', '24 h ago'), el('span', '', 'now'));
        li.append(bar, scale, el('div', 'stp-pct', `Up ${pct(s.day)} of the last 24 hours · ${pct(s.week)} of 7 days`));
      }
      return li;
    }),
  );
  $('stp-foot').textContent = d.checkedAt
    ? `Checked ${new Date(d.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · updates on its own`
    : '';
}

async function refresh() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
  } catch {
    const o = $('stp-overall');
    o.dataset.state = 'checking';
    o.textContent = "Can't reach the server right now. Trying again…";
  }
}

refresh();
setInterval(refresh, 30e3);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

export {}; // an ES module (type="module" in status.html), not a global script
