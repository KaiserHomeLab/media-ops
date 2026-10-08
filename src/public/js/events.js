// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The errors & warnings feed, plus the buttons that act on apps (dismiss, clear, re-check,
// stop a stream, retry a download, approve a request) and the toast that reports back.
import { refresh } from './main.js';
import { $, ago, esc, lastHTML, rollUp, setHTML, store } from './util.js';

// --------------------------------------------------------------------- errors & warnings feed
const evFilter = { svc: 'all', level: 'all', showDismissed: false };

export function renderEvents(d) {
  const active = d.events.filter(e => !e.dismissed);
  const dismissedN = d.events.length - active.length;
  const errs = active.filter(e => e.level === 'error').length;
  $('ev-count').textContent = active.length
    ? `${errs} errors · ${active.length - errs} warnings`
    : `all clear${dismissedN ? ` · ${dismissedN} dismissed` : ''}`;
  if (rollUp('events-card', !active.length)) return;

  const names = new Map(d.services.map(s => [s.id, s.name]));
  const bySvc = new Map();
  for (const e of active) bySvc.set(e.svcId, (bySvc.get(e.svcId) || 0) + 1);
  if (evFilter.svc !== 'all' && !names.has(evFilter.svc)) evFilter.svc = 'all';
  const btn = (kind, val, label, n) =>
    `<button type="button" data-${kind}="${esc(val)}" aria-pressed="${evFilter[kind] === val}">${esc(label)}${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
  setHTML(
    $('ev-filters'),
    [
      btn('level', 'all', 'All levels'),
      btn('level', 'error', 'Errors only', errs),
      '<span class="sep"></span>',
      btn('svc', 'all', 'All apps', active.length),
      ...[...bySvc].map(([id, n]) => btn('svc', id, names.get(id) || id, n)),
      // keep the selected app's chip even once its errors are all dismissed
      ...(evFilter.svc !== 'all' && !bySvc.has(evFilter.svc)
        ? [btn('svc', evFilter.svc, names.get(evFilter.svc), 0)]
        : []),
    ].join(''),
  );

  const inFilter = e =>
    (evFilter.level === 'all' || e.level === evFilter.level) && (evFilter.svc === 'all' || e.svcId === evFilter.svc);
  const shownActive = active.filter(inFilter);
  const shown = (evFilter.showDismissed ? d.events : active).filter(inFilter).slice(0, 150);

  // Action bar: app actions on the left (when one app is selected), feed actions on the right.
  const sel = evFilter.svc !== 'all' && d.services.find(s => s.id === evFilter.svc);
  const left = sel
    ? [
        `<button class="btn small" type="button" data-recheck="${esc(sel.id)}" title="${sel.actions.recheck === 'health' ? `Run ${esc(sel.name)}'s health checks now` : `Poll ${esc(sel.name)} again now`}">↻ Re-check ${esc(sel.name)}</button>`,
        sel.actions.clear
          ? `<button class="btn small danger ghost" type="button" data-clear="${esc(sel.id)}">Clear ${esc(sel.name)}'s log…</button>`
          : '',
      ]
    : [];
  const right = [
    shownActive.length
      ? `<button class="btn small" type="button" data-dismiss-all>Dismiss ${evFilter.svc === 'all' ? 'all' : `all from ${esc(sel?.name || '')}`}</button>`
      : '',
    dismissedN
      ? `<button class="btn small ghost" type="button" data-toggle-dismissed>${evFilter.showDismissed ? 'Hide' : 'Show'} dismissed <span class="num">${dismissedN}</span></button>`
      : '',
    dismissedN && evFilter.showDismissed
      ? `<button class="btn small ghost" type="button" data-restore>Restore all</button>`
      : '',
  ];
  setHTML($('ev-actions'), `<div class="ev-left">${left.join('')}</div><div class="ev-right">${right.join('')}</div>`);

  const el = $('events');
  if (!shown.length) {
    const msg =
      d.events.length && !active.length
        ? `✓ All caught up. ${dismissedN} dismissed.`
        : active.length
          ? 'Nothing matches this filter.'
          : '✓ No errors or warnings. Everything is behaving.';
    return setHTML(el, `<div class="empty">${msg}</div>`);
  }

  // Keep expanded rows expanded across refreshes.
  const open = new Set([...el.querySelectorAll('details[open]')].map(x => x.dataset.key));
  setHTML(
    el,
    shown
      .map(e => {
        const svc = d.services.find(s => s.id === e.svcId);
        const queueActs =
          !e.dismissed && e.source === 'Queue' && e.queueId != null
            ? `<button class="mini-btn" type="button" data-qretry="${esc(e.svcId)}" title="Ask ${esc(svc?.name || '')} to re-check its downloads and try the import again">Retry</button>
         <button class="mini-btn" type="button" data-qremove="${esc(e.svcId)}" data-qid="${esc(e.queueId)}" title="Remove from the downloader, blocklist this release and search for another">Replace…</button>`
            : '';
        const acts = e.dismissed
          ? '<span class="tag">dismissed</span>'
          : `${queueActs}${e.live && (e.healthCheck || e.source === 'Connection') ? `<button class="icon-btn" type="button" data-recheck="${esc(e.svcId)}" title="Re-check ${esc(svc?.name || '')}" aria-label="Re-check ${esc(svc?.name || '')}">↻</button>` : ''}
         <button class="icon-btn" type="button" data-dismiss="${esc(e.key)}" title="Dismiss" aria-label="Dismiss">✕</button>`;
        const lvl = e.level === 'error' ? 'error' : 'warn';
        const cells = `<span class="lvl ${lvl}">${lvl}</span>
      <span class="svc-n">${esc(e.svc)}</span>
      <span class="msg"><span class="src" data-svc="${esc(e.svc)}">${esc(e.source)}</span>${esc(e.message)}${e.hint ? '<span class="hint-mark" title="Has a how-to-fix tip: click to open"> 💡</span>' : ''}</span>
      <span class="ago" title="${new Date(e.t).toLocaleString()}">${e.live ? 'active' : ago(e.t)}</span>
      <span class="ev-acts">${acts}</span>`;
        const cls = `ev${e.dismissed ? ' is-dismissed' : ''}`;
        const body = `${e.hint ? `<p class="ev-hint"><b>How to fix:</b> ${esc(e.hint)}</p>` : ''}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}`;
        return body
          ? `<details class="${cls}" data-key="${esc(e.key)}"${open.has(e.key) ? ' open' : ''}><summary>${cells}</summary>${body}</details>`
          : `<div class="${cls}"><div class="row">${cells}</div></div>`;
      })
      .join(''),
  );
}

$('ev-filters').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.level) evFilter.level = b.dataset.level;
  if (b.dataset.svc) evFilter.svc = b.dataset.svc;
  if (store.state) renderEvents(store.state);
});

// --------------------------------------------------------------------- dismiss / clear / re-check
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.innerHTML = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), kind === 'bad' ? 7000 : 3500);
}

async function post(path, body = {}) {
  const r = await fetch(`/api/events${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { needLogin: data.needLogin });
  return data;
}

async function runAction(btn, fn) {
  btn.disabled = true;
  const label = btn.innerHTML;
  if (!btn.classList.contains('icon-btn')) btn.textContent = 'Working…';
  try {
    const r = await fn();
    if (r?.message) toast(`✓ ${esc(r.message)}`);
  } catch (err) {
    toast(
      err.needLogin ? `${esc(err.message)} — <a href="/settings">open Settings</a>` : `✕ ${esc(err.message)}`,
      'bad',
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
    lastHTML.clear(); // force a full redraw with fresh data
    refresh();
  }
}

document.addEventListener('click', e => {
  const b = e.target.closest(
    '[data-dismiss],[data-dismiss-all],[data-restore],[data-recheck],[data-clear],[data-toggle-dismissed],[data-stop],[data-qretry],[data-qremove],[data-rq]',
  );
  if (!b) return;
  e.preventDefault(); // buttons inside <summary> must not toggle the row
  e.stopPropagation();
  const name = id => store.state?.services.find(s => s.id === id)?.name || 'app';
  if ('dismiss' in b.dataset) return runAction(b, () => post('/dismiss', { keys: [b.dataset.dismiss] }));
  if ('dismissAll' in b.dataset)
    return runAction(b, () => post('/dismiss', evFilter.svc === 'all' ? { all: true } : { svcId: evFilter.svc }));
  if ('restore' in b.dataset) return runAction(b, () => post('/restore'));
  if ('recheck' in b.dataset)
    return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.recheck)}/recheck`));
  if ('toggleDismissed' in b.dataset) {
    evFilter.showDismissed = !evFilter.showDismissed;
    return renderEvents(store.state);
  }
  if ('rq' in b.dataset) {
    if (b.dataset.rq === 'decline' && !confirm(`Decline the request for ${b.dataset.title}?`)) return;
    return runAction(b, () =>
      post(`/services/${encodeURIComponent(b.dataset.svc)}/request-${b.dataset.rq}`, {
        requestId: Number(b.dataset.id),
      }),
    );
  }
  if ('stop' in b.dataset) {
    const reason = prompt(
      `Stop ${b.dataset.user}'s stream?\n\nMessage shown on their screen:`,
      'The server is going down for maintenance. Sorry!',
    );
    if (reason === null) return;
    return runAction(b, () =>
      post(`/services/${encodeURIComponent(b.dataset.svc)}/stop`, { sessionId: b.dataset.stop, reason }),
    );
  }
  if ('qretry' in b.dataset)
    return runAction(b, () => post(`/services/${encodeURIComponent(b.dataset.qretry)}/queue-retry`));
  if ('qremove' in b.dataset) {
    if (
      !confirm(`Remove this download, blocklist the release, and have ${name(b.dataset.qremove)} search for another?`)
    )
      return;
    return runAction(b, () =>
      post(`/services/${encodeURIComponent(b.dataset.qremove)}/queue-remove`, { queueId: Number(b.dataset.qid) }),
    );
  }
  if ('clear' in b.dataset) {
    const svc = store.state.services.find(s => s.id === b.dataset.clear);
    if (!confirm(`Clear ${name(svc.id)}'s log?\n\n${svc.actions.clear}`)) return;
    return runAction(b, () => post(`/services/${encodeURIComponent(svc.id)}/clear`));
  }
});

// *arr/SABnzbd send ETAs as "hh:mm:ss" strings; qBittorrent sends seconds (8640000 = unknown).
