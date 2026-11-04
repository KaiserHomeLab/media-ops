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
  $form('hub-form').enabled.checked = hubState.enabled;
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
  try {
    hubState = await api('/hub', { method: 'PUT', body: { enabled: $form('hub-form').enabled.checked } });
    renderHub();
    flash($('hub-saved'));
  } catch (err) {
    showError($('hub-error'), err.message);
  }
});
$('hub-filter').addEventListener('change', renderHubLog);
$('hub-refresh').addEventListener('click', loadHubActivity);
