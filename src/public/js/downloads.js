// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Downloads, coming up, indexer limits, recently added, Seerr requests and the Media Review queue.
import {
  $,
  ago,
  bytes,
  clock,
  esc,
  initials,
  list,
  num,
  rate,
  rollUp,
  setHTML,
  store,
  thumbUrl,
  timeOf,
} from './util.js';

/** @param {unknown} eta seconds, or the client's own text */
function etaText(eta) {
  if (eta == null || eta === '') return '';
  if (typeof eta === 'number') return eta >= 8640000 ? '∞' : clock(eta * 1000);
  return String(eta).replace(/^00:/, '');
}

/** @param {Answered[]} clients @param {Answered[]} arrs */
export function renderDownloads(clients, arrs) {
  // Prefer the *arr queues (clean titles); fall back to raw client items when no arr is grabbing anything.
  let items = arrs.flatMap(a => list(a.data.queue).map(q => ({ ...q, source: a.name })));
  if (!items.length) items = clients.flatMap(c => list(c.data.items).map(q => ({ ...q, source: c.name })));
  const today = clients.reduce((n, c) => n + (c.data.totals?.day || 0), 0);
  $('downloads-count').textContent = items.length
    ? `${items.length} in queue`
    : `queue empty${today ? ` · ${bytes(today)} today` : ''}`;
  if (rollUp('downloads-card', !items.length)) return;

  setHTML(
    $('clients'),
    clients
      .map(c => {
        const d = c.data;
        const x =
          d.client === 'torrent'
            ? `${num(d.torrents)} torrents · ratio ${d.ratio?.toFixed(2) ?? '—'} · ${bytes(d.allTimeUp)} seeded`
            : `${d.paused ? 'PAUSED' : esc(d.status)}${d.totals ? ` · today ${bytes(d.totals.day)} · month ${bytes(d.totals.month)}` : ''}`;
        return `<div class="client"><h3>${esc(c.name)}</h3>
      <div class="speeds"><span class="down">${rate(d.downBps)}</span>${d.client === 'torrent' ? `<span class="up">${rate(d.upBps)}</span>` : ''}</div>
      <div class="x">${x}</div></div>`;
      })
      .join(''),
  );

  if (!items.length) return setHTML($('queue'), '<div class="empty">Queue is empty.</div>');

  setHTML(
    $('queue'),
    items
      .slice(0, 15)
      .map(q => {
        const done = q.progress >= 1;
        const meta = [
          `${Math.floor(q.progress * 100)}%`,
          q.size && bytes(q.size),
          !done && etaText(q.eta),
          done && esc(q.status),
          esc(q.source),
        ]
          .filter(Boolean)
          .join(' · ');
        return `<div class="qitem ${done ? 'done' : ''} ${q.warning ? 'warn' : ''}">
      <div class="row1"><span class="name" title="${esc(q.title)}">${q.warning ? '⚠ ' : ''}${esc(q.title)}</span><span class="m">${meta}</span></div>
      <div class="bar"><i style="width:${(q.progress * 100).toFixed(1)}%"></i></div></div>`;
      })
      .join(''),
  );
}

/** @param {string} date */
function dayLabel(date) {
  const d = new Date(date),
    today = new Date();
  const diff = Math.round((new Date(d.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/** @param {Answered[]} arrs */
export function renderUpcoming(arrs) {
  const cutoff = Date.now() - 864e5;
  const items = arrs
    .flatMap(a => list(a.data.upcoming))
    .filter(u => new Date(u.date).getTime() >= cutoff)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 16);
  if (!items.length) return setHTML($('upcoming'), '<div class="empty">Nothing on the calendar.</div>');
  let html = '',
    last = '';
  for (const u of items) {
    const label = dayLabel(u.date);
    if (label !== last) {
      html += `<div class="day">${label}</div>`;
      last = label;
    }
    const time =
      u.kind === 'tv' ? new Date(u.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    html += `<div class="up-item"><span class="sw ${u.kind}" aria-label="${u.kind}"></span>
      <div class="t">${esc(u.title)}<span>${esc(u.sub)}</span></div>
      <span class="when ${u.hasFile ? 'got' : ''}">${u.hasFile ? '✓ grabbed' : time}</span></div>`;
  }
  setHTML($('upcoming'), html);
}

// --------------------------------------------------------------------- indexer limits (Prowlarr)
// One row per enabled indexer: queries and grabs in Prowlarr's own rolling window, against the
// limits set on the indexer. Bars only where a limit is set; the numbers are always shown.
/** @param {Answered[]} prowlarrs */
export function renderIndexers(prowlarrs) {
  const rows = prowlarrs.flatMap(p => list(p.data.limits));
  $('indexers-card').hidden = !rows.length;
  if (!rows.length) return;
  const limited = rows.filter(l => l.queryLimit || l.grabLimit).length;
  $('indexers-sub').textContent =
    `${rows.length} indexer${rows.length === 1 ? '' : 's'}${limited ? ` · ${limited} with limits` : ''}`;
  $('indexers-note').hidden = limited === rows.length;
  /** @param {string} label @param {number} used @param {number | null} max */
  const meter = (label, used, max) => {
    if (!max)
      return `<div class="meter none"><div class="m-top"><span>${label}</span><span class="num">${num(used)}</span></div><div class="m-sub">no limit set</div></div>`;
    const pct = used / max;
    const cls = pct >= 1 ? 'crit' : pct >= 0.9 ? 'warn' : '';
    return `<div class="meter ${cls}"><div class="m-top"><span>${label}</span><span class="num">${cls ? '⚠ ' : ''}${num(used)} / ${num(max)}</span></div>
      <div class="bar" role="img" aria-label="${label}: ${used} of ${max}"><i style="width:${Math.min(100, pct * 100).toFixed(1)}%"></i></div></div>`;
  };
  setHTML(
    $('indexers'),
    rows
      .map(
        l => `<div class="idx">
      <div class="idx-name"><b>${esc(l.name)}</b><span class="muted">last ${l.unit === 'hour' ? 'hour' : '24 h'}</span>
        ${l.pausedUntil ? `<span class="chip bad" title="Prowlarr paused it after failures">paused until ${esc(timeOf(l.pausedUntil))}</span>` : ''}</div>
      ${meter('API calls', l.queries, l.queryLimit)}${meter('Grabs', l.grabs, l.grabLimit)}
    </div>`,
      )
      .join(''),
  );
}

// --------------------------------------------------------------------- recently added + imports
/** @param {Answered[]} media @param {Answered[]} arrs */
export function renderRecent(media, arrs) {
  const items = media
    .flatMap(m => list(m.data.recentlyAdded).map(x => ({ ...x, server: m.id })))
    .sort((a, b) => b.addedAt - a.addedAt);
  const imports = arrs
    .flatMap(a => list(a.data.imports).map(x => ({ ...x, source: a.name })))
    .filter(x => Date.now() - new Date(x.time).getTime() < 2 * 864e5)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 8);
  $('recent-card').hidden = !items.length && !imports.length;
  /** @param {any} m */
  const thumb = m => (m.thumb && !store.state?.demo ? thumbUrl(m.server, m.thumb) : null);
  setHTML(
    $('recent-posters'),
    items
      .slice(0, 8)
      .map(
        m => `<figure class="pcard" title="${esc(`${m.title} ${m.sub} · ${m.library || ''}`)}">
      ${thumb(m) ? `<img loading="lazy" alt="" src="${thumb(m)}" data-fallback="${initials(m.title)}">` : `<div class="ph" aria-hidden="true">${initials(m.title)}</div>`}
      <figcaption><b>${esc(m.title)}</b><span>${esc(m.sub)}</span><span class="muted">${ago(m.addedAt)}</span></figcaption></figure>`,
      )
      .join(''),
  );
  $('recent-posters')
    .querySelectorAll('img[data-fallback]')
    .forEach(img =>
      img.addEventListener(
        'error',
        () => {
          const div = Object.assign(document.createElement('div'), {
            className: 'ph',
            textContent: /** @type {HTMLElement} */ (img).dataset.fallback || '',
          });
          img.replaceWith(div);
        },
        { once: true },
      ),
    );
  $('imports-h').hidden = !imports.length;
  setHTML(
    $('imports'),
    imports
      .map(
        x =>
          `<li><span class="t">${esc(x.title)}</span>${x.quality ? `<span class="chip">${esc(x.quality)}</span>` : ''}<span class="muted">${esc(x.source)} · ${ago(new Date(x.time).getTime())}</span></li>`,
      )
      .join(''),
  );
}

// --------------------------------------------------------------------- Seerr requests
/** @param {Answered[]} seerrs */
export function renderRequests(seerrs) {
  const reqs = seerrs.flatMap(s => list(s.data.requests).map(r => ({ ...r, svcId: s.id })));
  $('requests-card').hidden = !seerrs.length;
  $('requests-count').textContent = reqs.length ? `${reqs.length} waiting` : 'none waiting';
  if (rollUp('requests-card', !reqs.length)) return;
  setHTML(
    $('requests'),
    reqs
      .map(
        r => `<li>
      <div class="rq-main"><b>${esc(r.title)}</b>${r.year ? ` <span class="muted">(${esc(r.year)})</span>` : ''}
        <span class="chip">${r.type === 'tv' ? `TV${r.seasons?.length ? ` · S${esc(r.seasons.join(', S'))}` : ''}` : 'Movie'}</span>${r.is4k ? '<span class="chip">4K</span>' : ''}
        <div class="muted">requested by ${esc(r.requestedBy)} · ${ago(new Date(r.createdAt).getTime())}</div></div>
      <div class="rq-acts"><button class="btn small" type="button" data-rq="approve" data-svc="${esc(r.svcId)}" data-id="${esc(r.id)}" data-title="${esc(r.title)}">✓ Approve</button>
        <button class="btn small ghost" type="button" data-rq="decline" data-svc="${esc(r.svcId)}" data-id="${esc(r.id)}" data-title="${esc(r.title)}">Decline</button></div>
    </li>`,
      )
      .join('') || '<li class="empty">No requests waiting. 🎉</li>',
  );
}

// --------------------------------------------------------------------- Media Review queue
// Titles friends have Downvoted past Media Review's threshold. Media Review decides what's here;
// this only shows it, with who Downvoted and how much each vote weighed, and sends the Owner's Keep or Remove
// back. Open Problem Reports follow, with Resolve and Close. Removed titles are listed under Leaving Soon, with
// Keep after all.
/** @param {Answered[]} reviews */
export function renderReviewQueue(reviews) {
  const queue = reviews.flatMap(s => list(s.data.reviewQueue).map(q => ({ ...q, svcId: s.id })));
  const leaving = reviews.flatMap(s => list(s.data.leavingSoon).map(l => ({ ...l, svcId: s.id })));
  const problems = reviews.flatMap(s => list(s.data.problemReports).map(p => ({ ...p, svcId: s.id })));
  const held = reviews.flatMap(s => list(s.data.heldBack).map(h => ({ ...h, svcId: s.id })));
  $('review-card').hidden = !reviews.length;
  $('review-count').textContent =
    (queue.length ? `${queue.length} to decide` : 'nothing to decide') +
    (problems.length ? ` · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : '') +
    (held.length ? ` · ${held.length} asked back` : '') +
    (leaving.length ? ` · ${leaving.length} leaving soon` : '');
  if (rollUp('review-card', !queue.length && !leaving.length && !problems.length && !held.length)) return;
  $('review-held-h').hidden = !held.length;
  setHTML(
    $('review-held'),
    held
      .map(
        h => `<li>
      <div class="rq-main"><b>${esc(h.title)}</b>${h.year ? ` <span class="muted">(${esc(h.year)})</span>` : ''}
        <span class="chip">${esc(h.library || (h.kind === 'show' ? 'Show' : 'Movie'))}</span><span class="chip kind">↺ ${esc(list(h.asks).length)} ask${list(h.asks).length === 1 ? '' : 's'}</span>
        ${list(h.asks)
          .map(a => `<div class="muted">${esc(a.voter)} asked${a.note ? `: “${esc(a.note)}”` : ''}</div>`)
          .join('')}<div class="muted">Deleted ${ago(new Date(h.deletedAt).getTime())}${
          list(h.downvotes).length
            ? ` · Downvoted by ${list(h.downvotes)
                .map(d => (d.voteWeight == null ? esc(d.voter) : `${esc(d.voter)} (${esc(num(d.voteWeight))})`))
                .join(', ')}`
            : ''
        }${h.kept ? ` · Kept ${h.kept === 1 ? 'once' : `${esc(h.kept)} times`} before` : ''}</div></div>
      <div class="rq-acts"><button class="btn small" type="button" data-hb="bring-back" data-svc="${esc(h.svcId)}" data-id="${esc(h.ratingKey)}" data-title="${esc(h.title)}">Bring back</button>
        <button class="btn small ghost" type="button" data-hb="decline" data-svc="${esc(h.svcId)}" data-id="${esc(h.ratingKey)}" data-title="${esc(h.title)}">Decline</button></div>
    </li>`,
      )
      .join(''),
  );
  $('review-problems-h').hidden = !problems.length;
  setHTML(
    $('review-problems'),
    problems
      .map(
        p => `<li>
      <div class="rq-main"><b>${esc(p.title)}</b>${p.year ? ` <span class="muted">(${esc(p.year)})</span>` : ''}
        <span class="chip">${esc(p.library || (p.kind === 'show' ? 'Show' : 'Movie'))}</span><span class="chip kind">⚑ ${esc(p.reason)}</span>
        <div class="muted">${esc(p.part || (p.kind === 'show' ? 'Whole show' : 'The movie'))} · reported ${ago(new Date(p.reportedAt).getTime())}</div>${list(
          p.reporters,
        )
          .map(r => `<div class="muted">${esc(r.voter)}${r.note ? `: “${esc(r.note)}”` : ''}</div>`)
          .join('')}</div>
      <div class="rq-acts"><button class="btn small" type="button" data-pr="resolve" data-svc="${esc(p.svcId)}" data-id="${esc(p.id)}" data-title="${esc(p.title)}">Resolve</button>
        <button class="btn small ghost" type="button" data-pr="close" data-svc="${esc(p.svcId)}" data-id="${esc(p.id)}" data-title="${esc(p.title)}">Close</button></div>
    </li>`,
      )
      .join(''),
  );
  $('review-leaving-h').hidden = !leaving.length;
  setHTML(
    $('review-leaving'),
    leaving
      .map(
        l => `<li>
      <div class="rq-main"><b>${esc(l.title)}</b>${l.year ? ` <span class="muted">(${esc(l.year)})</span>` : ''}
        <span class="chip">${esc(l.library || (l.kind === 'show' ? 'Show' : 'Movie'))}</span>
<span class="chip kind">⏳ ${l.daysLeft <= 0 ? 'leaves today' : l.daysLeft === 1 ? 'leaves tomorrow' : `leaves in ${esc(l.daysLeft)} days`}</span>${
          !l.objectionsOpen
            ? '<div class="muted">Sent back once already: no Objections this time</div>'
            : list(l.objections).length
              ? `<div class="muted">Objections: ${esc(num(l.objectionWeight))} of ${esc(num(l.objectionBar))} · ${list(
                  l.objections,
                )
                  .map(o => `${esc(o.voter)} (${esc(num(o.voteWeight))})`)
                  .join(', ')}</div>`
              : ''
        }${
          l.deleteError
            ? `<div class="bad">Couldn't delete: ${esc(l.deleteError)}. Media Review tries again tonight.</div>`
            : ''
        }</div>
      <div class="rq-acts"><button class="btn small" type="button" data-rv="leaving-keep" data-svc="${esc(l.svcId)}" data-id="${esc(l.ratingKey)}" data-title="${esc(l.title)}">Keep after all</button></div>
    </li>`,
      )
      .join(''),
  );
  setHTML(
    $('review'),
    queue
      .map(
        q => `<li>
      <div class="rq-main"><b>${esc(q.title)}</b>${q.year ? ` <span class="muted">(${esc(q.year)})</span>` : ''}
        <span class="chip">${esc(q.library || (q.kind === 'show' ? 'Show' : 'Movie'))}</span><span class="chip kind">▼ ${esc(list(q.downvotes).length)} Downvote${list(q.downvotes).length === 1 ? '' : 's'}</span>${q.sentBack ? '<span class="chip">sent back by Objections</span>' : ''}
        <div class="muted">${esc(num(q.downvoteWeight))} of ${esc(num(q.audienceWeight))} weight from an Audience of ${esc(q.audience)} · queued ${ago(new Date(q.queuedAt).getTime())}</div>
        <div class="muted">Downvoted by ${list(q.downvotes)
          .map(d => `${esc(d.voter)} (${esc(num(d.voteWeight))})`)
          .join(', ')}</div>${
          list(q.watchedSince).length
            ? `<div class="muted">Watched it since: ${list(q.watchedSince).map(esc).join(', ')}</div>`
            : ''
        }${
          list(q.objections).length
            ? `<div class="muted">Objected: ${list(q.objections)
                .map(o => `${esc(o.voter)} (${esc(num(o.voteWeight))})`)
                .join(', ')}</div>`
            : ''
        }${q.kept ? `<div class="muted">Kept ${q.kept === 1 ? 'once' : `${esc(q.kept)} times`} before</div>` : ''}</div>
      <div class="rq-acts"><button class="btn small" type="button" data-rv="keep" data-svc="${esc(q.svcId)}" data-id="${esc(q.ratingKey)}" data-title="${esc(q.title)}">Keep</button>
        <button class="btn small danger" type="button" data-rv="remove" data-svc="${esc(q.svcId)}" data-id="${esc(q.ratingKey)}" data-title="${esc(q.title)}">Remove</button></div>
    </li>`,
      )
      .join('') || '<li class="empty">Nothing waiting for review.</li>',
  );
}
