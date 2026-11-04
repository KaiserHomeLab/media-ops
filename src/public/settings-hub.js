// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings → Notification Hub: the on/off switch and Activity, the last 200 events with the rule
// each matched and what happened to it (lib/hub, /api/settings/hub). A classic script loaded
// after settings.js, whose helpers ($, api, esc, showError, flash, S) it uses; settings.js calls
// loadHub() once the page has loaded.
'use strict';
/* exported loadHub */

/** @type {HubSettings | null} */
let hubState = null;
/** @type {HubEvent[]} */
let hubEvents = [];

// What happened, in words. Destinations come from the server with their names filled in.
/** @param {HubEvent} e */
function hubOutcome(e) {
  const names = e.destinations.map(d => d.name).join(', ');
  const failed = e.deliveries.filter(d => !d.ok);
  switch (e.status) {
    case 'sent':
      return failed.length
        ? `Sent to ${e.deliveries
            .filter(d => d.ok)
            .map(d => d.name)
            .join(', ')}; failed for ${failed.map(d => d.name).join(', ')}`
        : `Sent to ${names}`;
    case 'failed':
      return `Couldn't send to ${names}`;
    case 'pending':
      return `Sending to ${names} at the next check`;
    case 'held':
      return `Held for quiet hours, then to ${names}`;
    case 'suppressed':
      return 'Not sent: the same thing went out moments ago';
    case 'queued':
      return `Saved for the "${e.digestId}" digest`;
    case 'digested':
      return `In the "${e.digestId}" digest${e.sentAt ? ` sent ${hubWhen(e.sentAt)}` : ' (nothing else new, so not posted)'}`;
    case 'dropped':
      return 'Dropped';
    case 'unrouted':
      return 'Not sent: the rule has no destination';
    case 'skipped':
      return 'Skipped: someone started watching during quiet hours';
    default:
      return 'Recorded';
  }
}

/** @type {Record<string, string[]>} */
const HUB_FILTERS = {
  sent: ['sent'],
  waiting: ['pending', 'held'],
  queued: ['queued', 'digested'],
  'not-sent': ['dropped', 'suppressed', 'unrouted', 'skipped', 'logged'],
  failed: ['failed'],
};
// Sent with a failure somewhere still counts as failed for the filter: that's what you look for.
/** @param {HubEvent} e @param {string} filter */
const hubShown = (e, filter) =>
  !filter || HUB_FILTERS[filter]?.includes(e.status) || (filter === 'failed' && e.deliveries.some(d => !d.ok));

/** @param {number} t */
const hubWhen = t =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function renderHubLog() {
  const filter = /** @type {HTMLSelectElement} */ ($('hub-filter')).value;
  const shown = hubEvents.filter(e => hubShown(e, filter));
  $('hub-log').innerHTML = shown.length
    ? shown
        .map(e => {
          const bad = e.status === 'failed' || e.deliveries.some(d => !d.ok);
          const sends = e.deliveries
            .map(
              d =>
                `<li class="${d.ok ? '' : 'bad'}">${esc(hubWhen(d.at))} · ${esc(d.name)}: ${d.ok ? 'delivered' : esc(d.error || 'failed')}</li>`,
            )
            .join('');
          return `<li class="hub-row st-${esc(e.status)}${bad ? ' bad' : ''}">
            <span class="hub-when muted">${esc(hubWhen(e.receivedAt))}</span>
            <details>
              <summary><span class="hub-summary">${esc(e.summary)}</span>
                <span class="hub-what"><span class="chip">${esc(e.type)}</span> ${esc(hubOutcome(e))}</span></summary>
              <dl class="kv hub-detail">
                <dt>Rule</dt><dd>${esc(e.rule || '—')}</dd>
                <dt>From</dt><dd>${esc(e.source)}${e.sourceInstance && e.sourceInstance !== e.source ? ` · ${esc(e.sourceInstance)}` : ''}</dd>
                <dt>Severity</dt><dd>${esc(e.severity)}</dd>
                ${e.media?.library ? `<dt>Library</dt><dd>${esc(e.media.library)}</dd>` : ''}
                ${e.media?.quality ? `<dt>Quality</dt><dd>${esc(e.media.quality)}</dd>` : ''}
                ${e.dedupeKey ? `<dt>Same-thing key</dt><dd><code>${esc(e.dedupeKey)}</code></dd>` : ''}
              </dl>
              ${sends ? `<ul class="fix-log hub-sends">${sends}</ul>` : ''}
            </details>
          </li>`;
        })
        .join('')
    : `<li class="hub-empty muted">${hubEvents.length ? 'Nothing matches that filter.' : 'Nothing yet. Events show up here as they arrive.'}</li>`;
}

async function loadHubActivity() {
  try {
    hubEvents = (await api('/hub/activity')).events;
  } catch (err) {
    showError($('hub-error'), err.message);
    return;
  }
  renderHubLog();
}

function renderHub() {
  if (!hubState) return;
  const f = $form('hub-form');
  f.enabled.checked = hubState.enabled;
  field(f, 'publicUrl').value = hubState.publicUrl || '';
  $('hub-config').hidden = !hubState.enabled;
  if (hubState.enabled) {
    hubRules = structuredClone(hubState.rules);
    $form('hub-rules-form').flapMinutes.value = String(hubState.flapMinutes);
    renderSources();
    renderRules();
    renderDigests();
  }
  const show = hubState.enabled || S.demo;
  $('hub-activity').hidden = !show;
  if (show) loadHubActivity();
}

// Called by settings.js load(), after the settings payload is in.
async function loadHub() {
  try {
    hubState = await api('/hub');
  } catch (err) {
    showError($('hub-error'), err.message);
    return;
  }
  renderHub();
}

$form('hub-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('hub-error'), '');
  const f = $form('hub-form');
  try {
    hubState = await api('/hub', {
      method: 'PUT',
      body: { enabled: f.enabled.checked, publicUrl: field(f, 'publicUrl').value },
    });
    renderHub();
    flash($('hub-saved'));
  } catch (err) {
    showError($('hub-error'), err.message);
  }
});

/** @param {number | null | undefined} t */
const hubAgo = t => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : hubWhen(t);
};
/** @param {string} id */
const targetName = id => S.notifications.targets.find(t => t.id === id)?.name || 'a removed destination';
/** @param {string} label @param {string} value */
const copyRow = (label, value) =>
  `<label class="field wide"><span>${esc(label)}</span><div class="logo-row"><input readonly spellcheck="false" value="${esc(value)}"><button class="btn small" type="button" data-copy>Copy</button></div></label>`;
// Copy buttons in the modal copy the input beside them.
modal.addEventListener('click', async e => {
  const b = closest(e, '[data-copy]');
  if (!b) return;
  const input = /** @type {HTMLInputElement | null} */ (b.parentElement?.querySelector('input'));
  if (!input) return;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    b.textContent = 'Copied';
  } catch {
    document.execCommand('copy');
  }
});

// --------------------------------------------------------------------- sources
function renderSources() {
  if (!hubState) return;
  const st = hubState;
  $('hub-sources').innerHTML = st.sources.length
    ? st.sources
        .map(
          s => `<li class="hub-item">
        <div><b>${esc(s.name)}</b> <span class="chip">${esc(s.type)}${s.instance !== s.type ? ` · ${esc(s.instance)}` : ''}</span>
          <div class="muted"><code>${esc(s.path)}</code></div>
          <div class="muted">Last heard ${esc(hubAgo(s.lastSeen))}${s.received ? ` · ${esc(String(s.received))} received` : ''}${s.lastType ? ` · last: ${esc(s.lastType)}` : ''}</div></div>
        <div class="hub-item-acts"><button class="btn small" type="button" data-token="${esc(s.id)}">New token</button><button class="btn small danger ghost" type="button" data-del-source="${esc(s.id)}">Delete</button></div>
      </li>`,
        )
        .join('')
    : '<li class="hub-empty muted">No sources yet.</li>';
  const rej = $('hub-rejected');
  rej.hidden = !st.rejected.count;
  rej.textContent = st.rejected.count
    ? `${st.rejected.count} request${st.rejected.count === 1 ? '' : 's'} with a wrong token since Media Ops started (last ${hubAgo(st.rejected.lastAt)}). An app with an old token? Give it a new one.`
    : '';
}

// The token, once: the full address with it, and the header form for apps that can send one.
/** @param {{ source: HubSettings['sources'][number], token: string }} made */
function showToken({ source, token }) {
  const type = hubState?.types.find(t => t.type === source.type);
  const url = `${location.origin}${source.path}`;
  openModal(
    `${source.name}: its address`,
    `<div class="form grid-form">
      <p class="hint wide"><b>Copy this now: the token isn't shown again.</b> ${esc(type?.how || '')}</p>
      ${copyRow('Webhook URL (token included)', `${url}?token=${token}`)}
      ${copyRow('Or the URL, plus this as an X-Hub-Token header (or the password, for Basic auth)', url)}
      ${copyRow('Token', token)}
      <p class="hint wide">Use the address the app reaches Media Ops at: from another container on the same Docker network that's usually <code>http://media-ops:8484</code>, not this page's address.</p>
      <div class="actions wide"><span class="spacer"></span><button class="btn primary" type="button" data-close>Done</button></div>
    </div>`,
  );
}

$('hub-add-source').addEventListener('click', () => {
  if (!hubState) return;
  openModal(
    'Add source',
    `<form class="form grid-form" id="hub-source-form">
      <label class="field"><span>App</span><select name="type">${hubState.types.map(t => `<option value="${esc(t.type)}">${esc(t.label)}</option>`).join('')}</select></label>
      <label class="field"><span>Name</span><input name="name" placeholder="Sonarr" maxlength="100"></label>
      <label class="field"><span>Instance <em>part of its address</em></span><input name="instance" placeholder="sonarr" pattern="[a-z0-9][a-z0-9\\-]{0,39}" spellcheck="false">
        <small>Lowercase letters, digits and dashes. Two Sonarrs need two names, like <code>sonarr-anime</code>.</small></label>
      <label class="field"><span>Library <em>optional</em></span><input name="library" placeholder="Anime" maxlength="100">
        <small>For Sonarr or Radarr: the library its titles belong to, when it isn't Movies or TV Shows (an anime Sonarr).</small></label>
      <div class="form-error wide" id="hub-source-error" hidden></div>
      <div class="actions wide"><span class="spacer"></span><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Add</button></div>
    </form>`,
  );
  const f = $form('hub-source-form');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    try {
      const made = await api('/hub/sources', {
        method: 'POST',
        body: { ...v, instance: String(v.instance || v.type) },
      });
      hubState = await api('/hub');
      renderSources();
      showToken(made);
    } catch (err) {
      showError($('hub-source-error'), err.message);
    }
  });
});

$('hub-sources').addEventListener('click', async e => {
  const tok = closest(e, '[data-token]');
  const del = closest(e, '[data-del-source]');
  try {
    if (tok) {
      if (!confirm('Make a new token? The old one stops working at once, so the app needs the new address.')) return;
      const made = await api(`/hub/sources/${encodeURIComponent(tok.dataset.token || '')}/token`, { method: 'POST' });
      showToken(made);
    } else if (del) {
      if (!confirm('Delete this source? Its webhooks will be refused.')) return;
      await api(`/hub/sources/${encodeURIComponent(del.dataset.delSource || '')}`, { method: 'DELETE' });
    } else return;
    hubState = await api('/hub');
    renderSources();
  } catch (err) {
    alert(err.message);
  }
});

// --------------------------------------------------------------------- rules
/** @type {HubRule[]} */
let hubRules = [];
const SEVERITY = ['info', 'warning', 'error', 'critical'];
// A match value is one value or a list.
/** @param {unknown} v @returns {string[]} */
const asList = v => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** @param {HubRule} r */
function ruleSummary(r) {
  const m = r.match || {};
  const types = asList(m.type);
  const libs = asList(m['media.library']);
  const what = `${types.length ? types.join(', ') : 'any event'}${libs.length ? ` in ${libs.join(', ')}` : ''}${m.min_severity ? `, ${m.min_severity} or worse` : ''}${Object.keys(m).some(k => !['type', 'media.library', 'min_severity'].includes(k)) ? ' (and more)' : ''}`;
  const to =
    r.action === 'now'
      ? (r.destinations || []).length
        ? `send now to ${(r.destinations || []).map(targetName).join(', ')}`
        : 'send now (no destination picked)'
      : r.action === 'digest'
        ? `hold for “${hubState?.digests.find(d => d.id === r.digest)?.title || r.digest}”`
        : 'drop';
  return `${what} → ${to}`;
}

function renderRules() {
  const last = hubRules.length - 1;
  $('hub-rules').innerHTML = hubRules
    .map((r, i) => {
      const movable = !r.locked;
      return `<li class="hub-rule${r.enabled ? '' : ' off'}" data-rule="${i}">
        ${r.locked ? '<span class="hub-lock" title="Always last">🔒</span>' : `<input type="checkbox" data-enable aria-label="Enabled" ${r.enabled ? 'checked' : ''}>`}
        <span class="hub-rule-text"><b>${esc(r.name)}</b><span class="muted">${esc(ruleSummary(r))}</span></span>
        <span class="layout-move">${
          movable
            ? `<button class="icon-btn" type="button" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="icon-btn" type="button" data-move="1" ${i >= last - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button class="icon-btn" type="button" data-edit aria-label="Edit">✎</button>`
            : ''
        }</span></li>`;
    })
    .join('');
}

$('hub-rules').addEventListener('click', e => {
  const li = closest(e, '[data-rule]');
  if (!li) return;
  const i = Number(li.dataset.rule);
  const mv = closest(e, '[data-move]');
  if (mv) {
    const j = i + Number(mv.dataset.move);
    if (j < 0 || j >= hubRules.length - 1) return;
    [hubRules[i], hubRules[j]] = [hubRules[j], hubRules[i]];
    renderRules();
  } else if (closest(e, '[data-edit]')) editRule(i);
});
$('hub-rules').addEventListener('change', e => {
  const box = closest(e, '[data-enable]');
  const li = closest(e, '[data-rule]');
  if (!box || !li) return;
  hubRules[Number(li.dataset.rule)].enabled = /** @type {HTMLInputElement} */ (box).checked;
  renderRules();
});
$('hub-add-rule').addEventListener('click', () => editRule(-1));

// One rule in the modal. Only the fields the form shows change; anything else the rule matches
// on (set by hand in config.json) is kept.
/** @param {number} i -1 for a new rule */
function editRule(i) {
  if (!hubState) return;
  const st = hubState;
  /** @type {HubRule} */
  const r = i >= 0 ? hubRules[i] : { id: '', name: '', enabled: true, match: {}, action: 'now', destinations: [] };
  const types = new Set(asList(r.match.type));
  const known = new Set(st.eventTypes.map(t => t.type));
  const other = [...types].filter(t => !known.has(t));
  const checks = st.eventTypes
    .map(
      t =>
        `<label class="check"><input type="checkbox" name="type" value="${esc(t.type)}" ${types.has(t.type) ? 'checked' : ''}><span><code>${esc(t.type)}</code> ${esc(t.label)}</span></label>`,
    )
    .join('');
  const dests = S.notifications.targets
    .map(
      t =>
        `<label class="check"><input type="checkbox" name="dest" value="${esc(t.id)}" ${(r.destinations || []).includes(t.id) ? 'checked' : ''}><span>${esc(t.name)}</span></label>`,
    )
    .join('');
  openModal(
    i >= 0 ? `Edit rule` : 'Add rule',
    `<form class="form grid-form" id="hub-rule-form">
      <label class="field"><span>Name</span><input name="name" required maxlength="120" value="${esc(r.name)}"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}><span>Enabled</span></label>
      <fieldset class="field wide events hub-types"><legend>Events <em>none ticked = any event</em></legend>${checks}</fieldset>
      <label class="field"><span>Other event types <em>optional</em></span><input name="otherTypes" value="${esc(other.join(', '))}" placeholder="dcs.server_up, custom" spellcheck="false"></label>
      <label class="field"><span>Libraries <em>optional</em></span><input name="libraries" value="${esc(asList(r.match['media.library']).join(', '))}" placeholder="Movies, TV Shows, Anime"></label>
      <label class="field"><span>How serious</span><select name="minSeverity"><option value="">any</option>${SEVERITY.slice(
        1,
      )
        .map(v => `<option value="${v}" ${r.match.min_severity === v ? 'selected' : ''}>${v} or worse</option>`)
        .join('')}</select></label>
      <label class="field"><span>Then</span><select name="then">
        <option value="now" ${r.action === 'now' ? 'selected' : ''}>Send now</option>
        <option value="digest" ${r.action === 'digest' ? 'selected' : ''}>Hold for a digest</option>
        <option value="drop" ${r.action === 'drop' ? 'selected' : ''}>Drop</option></select></label>
      <fieldset class="field wide events" id="hub-rule-dests"><legend>Send to</legend>${dests || '<span class="muted">Add a destination under Notifications first.</span>'}</fieldset>
      <label class="field" id="hub-rule-digest"><span>Digest</span><select name="digest">${st.digests
        .map(d => `<option value="${esc(d.id)}" ${r.digest === d.id ? 'selected' : ''}>${esc(d.title)}</option>`)
        .join('')}</select></label>
      <div class="form-error wide" id="hub-rule-error" hidden></div>
      <div class="actions wide">${i >= 0 ? '<button class="btn danger ghost" type="button" id="hub-rule-del">Delete</button>' : ''}<span class="spacer"></span><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Done</button></div>
    </form>`,
  );
  const f = $form('hub-rule-form');
  // Not f.action: a form's own `action` property would win over a field of that name.
  const then = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (field(f, 'then')));
  const sync = () => {
    $('hub-rule-dests').hidden = then.value !== 'now';
    $('hub-rule-digest').hidden = then.value !== 'digest';
  };
  sync();
  then.addEventListener('change', sync);
  $('hub-rule-del')?.addEventListener('click', () => {
    hubRules.splice(i, 1);
    modal.close();
    renderRules();
  });
  f.addEventListener('submit', e => {
    e.preventDefault();
    /** @param {string} v */
    const list = v =>
      v
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);
    const fd = new FormData(f);
    const picked = [...fd.getAll('type').map(String), ...list(String(fd.get('otherTypes') || ''))];
    const libs = list(String(fd.get('libraries') || ''));
    const rest = { ...(r.match || {}) };
    for (const k of ['type', 'media.library', 'min_severity']) delete rest[k];
    /** @type {HubRule} */
    const next = {
      ...r,
      name: String(fd.get('name') || '').trim(),
      enabled: f.enabled.checked,
      action: /** @type {HubRule['action']} */ (String(fd.get('then'))),
      match: {
        ...rest,
        ...(picked.length ? { type: picked } : {}),
        ...(libs.length ? { 'media.library': libs } : {}),
        ...(fd.get('minSeverity') ? { min_severity: String(fd.get('minSeverity')) } : {}),
      },
    };
    delete next.destinations;
    delete next.digest;
    if (next.action === 'now') next.destinations = fd.getAll('dest').map(String);
    if (next.action === 'digest') next.digest = String(fd.get('digest') || '');
    if (!next.id) next.id = crypto.randomUUID();
    if (i >= 0) hubRules[i] = next;
    else hubRules.splice(hubRules.length - 1, 0, next); // above the catch-all
    modal.close();
    renderRules();
  });
}

$form('hub-rules-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('hub-rules-error'), '');
  try {
    hubState = await api('/hub/rules', {
      method: 'PUT',
      body: { rules: hubRules, flapMinutes: Number($form('hub-rules-form').flapMinutes.value) },
    });
    renderHub();
    flash($('hub-rules-saved'));
  } catch (err) {
    showError($('hub-rules-error'), err.message);
  }
});

// --------------------------------------------------------------------- digests
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** @param {string} cron @returns {{ kind: 'daily' | 'weekly' | 'custom', time: string, day: number }} */
function readCron(cron) {
  const m = String(cron).match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/);
  if (!m) return { kind: 'custom', time: '08:00', day: 6 };
  const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  return m[3] === '*' ? { kind: 'daily', time, day: 6 } : { kind: 'weekly', time, day: Number(m[3]) % 7 };
}
/** @param {string} cron @param {string} tz */
function cronWords(cron, tz) {
  const c = readCron(cron);
  const zone = tz ? ` (${tz})` : '';
  if (c.kind === 'daily') return `every day at ${c.time}${zone}`;
  if (c.kind === 'weekly') return `every ${WEEKDAYS[c.day]} at ${c.time}${zone}`;
  return `schedule ${cron}${zone}`;
}

function renderDigests() {
  if (!hubState) return;
  $('hub-digests').innerHTML = hubState.digests.length
    ? hubState.digests
        .map(
          d => `<li class="hub-item${d.enabled ? '' : ' off'}" data-digest="${esc(d.id)}">
        <div><b>${esc(d.title)}</b> <span class="chip">${d.enabled ? 'on' : 'off'}</span>
          <div class="muted">${esc(cronWords(d.cron, d.timezone))} · ${d.destinations.length ? esc(d.destinations.map(targetName).join(', ')) : 'no destination yet'}${d.recipients?.length ? ` · ${d.recipients.length} newsletter address${d.recipients.length === 1 ? '' : 'es'}` : ''}</div>
          <div class="muted">${d.last ? `Last ${esc(hubAgo(d.last.sentAt))}: ${esc(d.last.status === 'sent' ? `sent, ${d.last.items} new` : d.last.status === 'empty' ? 'nothing new, not sent' : d.last.status)}` : 'Not sent yet'}</div></div>
        <div class="hub-item-acts"><button class="btn small" type="button" data-preview>Preview</button><button class="btn small" type="button" data-send>Send now</button><button class="btn small" type="button" data-edit>Edit</button></div>
      </li>`,
        )
        .join('')
    : '<li class="hub-empty muted">No digests.</li>';
}

$('hub-digests').addEventListener('click', async e => {
  const li = closest(e, '[data-digest]');
  const d = hubState?.digests.find(x => x.id === li?.dataset.digest);
  if (!d) return;
  try {
    if (closest(e, '[data-preview]')) {
      const p = await api(`/hub/digests/${encodeURIComponent(d.id)}/preview`);
      openModal(
        `Preview: ${d.title}`,
        `<p class="hint">What it would send now${p.items ? '' : ': nothing new yet, so with “skip if empty” it sends nothing'}. Discord gets this as embeds with posters; email as HTML.</p>
         <pre class="digest-preview">${esc([p.text.title, '', ...p.text.lines].join('\n'))}</pre>
         <div class="actions"><span class="spacer"></span><button class="btn primary" type="button" data-close>Close</button></div>`,
      );
    } else if (closest(e, '[data-send]')) {
      if (!confirm(`Send “${d.title}” now? What it holds is used up, as on a scheduled day.`)) return;
      const r = await api(`/hub/digests/${encodeURIComponent(d.id)}/send`, { method: 'POST' });
      alert(
        r.status === 'sent'
          ? `Sent to ${r.sent} destination${r.sent === 1 ? '' : 's'} (${r.items} new).`
          : r.status === 'empty'
            ? 'Nothing new to send.'
            : r.status === 'no-destination'
              ? 'Pick where it goes first (Edit).'
              : 'It couldn’t be sent. Activity and the destination show why.',
      );
      hubState = await api('/hub');
      renderDigests();
    } else if (closest(e, '[data-edit]')) editDigest(d);
  } catch (err) {
    alert(err.message);
  }
});
$('hub-add-digest').addEventListener('click', () => editDigest(null));

/** @param {HubSettings['digests'][number] | null} d */
function editDigest(d) {
  if (!hubState) return;
  const c = readCron(d?.cron || '0 8 * * *');
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const dests = S.notifications.targets
    .map(
      t =>
        `<label class="check"><input type="checkbox" name="dest" value="${esc(t.id)}" ${d?.destinations.includes(t.id) ? 'checked' : ''}><span>${esc(t.name)}</span></label>`,
    )
    .join('');
  openModal(
    d ? `Edit ${d.title}` : 'Add digest',
    `<form class="form grid-form" id="hub-digest-form">
      <label class="field"><span>Title</span><input name="title" required maxlength="100" value="${esc(d?.title || '')}" placeholder="Added to Plex"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${d?.enabled ? 'checked' : ''}><span>Send on schedule</span></label>
      ${d ? '' : '<label class="field"><span>Id <em>rules refer to it</em></span><input name="id" required pattern="[a-z0-9][a-z0-9_\\-]{0,39}" placeholder="added_weekly" spellcheck="false"></label>'}
      <label class="field"><span>When</span><select name="kind">
        <option value="daily" ${c.kind === 'daily' ? 'selected' : ''}>Every day</option>
        <option value="weekly" ${c.kind === 'weekly' ? 'selected' : ''}>Every week</option>
        <option value="custom" ${c.kind === 'custom' ? 'selected' : ''}>Custom (cron)</option></select></label>
      <label class="field" data-when="weekly"><span>Day</span><select name="day">${WEEKDAYS.map((w, i) => `<option value="${i}" ${c.day === i ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
      <label class="field" data-when="daily weekly"><span>At</span><input type="time" name="time" value="${esc(c.time)}"></label>
      <label class="field" data-when="custom"><span>Cron</span><input name="cron" value="${esc(d?.cron || '0 8 * * *')}" spellcheck="false" placeholder="0 8 * * *">
        <small>minute hour day month weekday</small></label>
      <label class="field"><span>Time zone <em>blank = the container's</em></span><input name="timezone" list="hub-zones" value="${esc(d?.timezone || '')}" placeholder="America/Chicago" spellcheck="false">
        <datalist id="hub-zones">${zones.map(z => `<option value="${esc(z)}">`).join('')}</datalist></label>
      <fieldset class="field wide events"><legend>Send to</legend>${dests || '<span class="muted">Add a destination under Notifications first.</span>'}</fieldset>
      <label class="field wide"><span>Newsletter addresses <em>optional · for its email destinations</em></span><textarea name="recipients" rows="3" spellcheck="false" placeholder="one@example.com, two@example.com">${esc((d?.recipients || []).join(', '))}</textarea>
        <small>Each address gets its own copy with an unsubscribe link (set the public address above). Leave empty to send to the email destination's own address.</small></label>
      <label class="field"><span>Footer <em>optional</em></span><input name="footer" maxlength="200" value="${esc(d?.footer || '')}" placeholder="Request more at requests.example.com"></label>
      <label class="field"><span>Most titles per section</span><input type="number" name="max" min="1" max="100" value="${esc(String(d?.maxItemsPerSection ?? 25))}"></label>
      <label class="field toggle wide"><input type="checkbox" name="skipIfEmpty" ${d?.skipIfEmpty === false ? '' : 'checked'}><span>Send nothing on a day with nothing new</span></label>
      <div class="form-error wide" id="hub-digest-error" hidden></div>
      <div class="actions wide">${d ? '<button class="btn danger ghost" type="button" id="hub-digest-del">Delete</button>' : ''}<span class="spacer"></span><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`,
  );
  const f = $form('hub-digest-form');
  const sync = () => {
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (f.querySelectorAll('[data-when]')))
      el.hidden = !String(el.dataset.when).split(' ').includes(f.kind.value);
  };
  sync();
  f.kind.addEventListener('change', sync);
  /** @param {HubSettings['digests']} list */
  const save = async list => {
    try {
      hubState = await api('/hub/digests', { method: 'PUT', body: { digests: list } });
      modal.close();
      renderHub();
    } catch (err) {
      showError($('hub-digest-error'), err.message);
    }
  };
  $('hub-digest-del')?.addEventListener('click', () => {
    if (d && confirm(`Delete “${d.title}”?`)) save((hubState?.digests || []).filter(x => x.id !== d.id));
  });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(f);
    const [hh, mm] = String(fd.get('time') || '08:00')
      .split(':')
      .map(Number);
    const kind = String(fd.get('kind'));
    const cron =
      kind === 'daily'
        ? `${mm} ${hh} * * *`
        : kind === 'weekly'
          ? `${mm} ${hh} * * ${fd.get('day')}`
          : String(fd.get('cron') || '');
    const next = {
      id: d?.id || String(fd.get('id') || ''),
      title: String(fd.get('title') || ''),
      enabled: f.enabled.checked,
      cron,
      timezone: String(fd.get('timezone') || ''),
      destinations: fd.getAll('dest').map(String),
      recipients: String(fd.get('recipients') || ''),
      footer: String(fd.get('footer') || ''),
      maxItemsPerSection: Number(fd.get('max') || 25),
      skipIfEmpty: f.skipIfEmpty.checked,
    };
    const list = hubState?.digests || [];
    save(/** @type {any} */ (d ? list.map(x => (x.id === d.id ? next : x)) : [...list, next]));
  });
}

$('hub-filter').addEventListener('change', renderHubLog);
$('hub-refresh').addEventListener('click', loadHubActivity);
