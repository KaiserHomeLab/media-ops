// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings → Notification Hub, as four steps: 1. connect apps (webhook sources), 2. where things
// go (one row per kind of notification: right away to chosen destinations, in a summary, or not
// at all), 3. summaries (digests), 4. activity. Talks to /api/settings/hub (lib/hub).
//
// Under the hood "where things go" is rules (lib/hub/rules.js): each row is a rule matching
// exactly that one type. Rules matching anything more (libraries, severity, several types) are
// the "custom rules" under Advanced, kept ahead of the rows. A classic script loaded after
// settings.js, whose helpers ($, api, esc, field, closest, showError, flash, openModal, modal,
// renderNotifs, S) it uses; settings.js calls loadHub() once the page has loaded.
'use strict';
/* exported loadHub */

/** @type {HubSettings | null} */
let hubState = null;
/** @type {HubEvent[]} */
let hubEvents = [];
/** @type {HubRule[]} custom rules being edited under Advanced (saved with "Save custom rules") */
let hubCustom = [];
/** @type {string | null} the row whose editor is open in "Where things go" */
let openRoute = null;

// --------------------------------------------------------------------- small helpers
/** @param {unknown} v @returns {string[]} a rule match value is one value or a list */
const asList = v => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
/** @param {string} id */
const targetName = id => S.notifications.targets.find(t => t.id === id)?.name || 'a removed destination';
/** @param {string} type */
const typeLabel = type => hubState?.eventTypes.find(t => t.type === type)?.label || type;
/** @param {string | null | undefined} id */
const digestTitle = id => hubState?.digests.find(d => d.id === id)?.title || id || 'a summary';
/** @param {number} t */
const hubWhen = t =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** @param {number | null | undefined} t */
const hubAgo = t => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : hubWhen(t);
};
/** @param {string} label @param {string} value */
const copyRow = (label, value) =>
  `<label class="field wide"><span>${esc(label)}</span><div class="logo-row"><input readonly spellcheck="false" value="${esc(value)}"><button class="btn small" type="button" data-copy>Copy</button></div></label>`;

// A "row" rule: exactly one type and nothing else to match on. Anything else is a custom rule.
/** @param {HubRule} r */
const isRow = r => !r.locked && Object.keys(r.match || {}).join() === 'type' && asList(r.match.type).length === 1;
const rowRules = () => (hubState?.rules || []).filter(isRow);
const customRules = () => (hubState?.rules || []).filter(r => !r.locked && !isRow(r));
/** @param {string} type the rule deciding this row: the first switched-on one for it */
const ruleFor = type => rowRules().find(r => r.enabled && asList(r.match.type)[0] === type) || null;
// Would a switched-on custom rule look at this type before its row does?
/** @param {string} type */
const customFirst = type =>
  customRules().some(r => {
    if (!r.enabled) return false;
    const types = asList(r.match.type);
    return !types.length || types.some(t => t === type || (t.endsWith('.*') && type.startsWith(t.slice(0, -1))));
  });

// Save the whole rule list: custom rules first, then one per row; the server adds the catch-all.
/** @param {HubRule[]} custom @param {HubRule[]} rows */
async function saveRules(custom, rows) {
  hubState = await api('/hub/rules', {
    method: 'PUT',
    body: { rules: [...custom, ...rows], flapMinutes: Number(hubState?.flapMinutes ?? 10) },
  });
}

// Copy buttons in the modal copy the input beside them.
modal.addEventListener('click', async e => {
  const b = closest(e, '[data-copy]');
  const input = /** @type {HTMLInputElement | null} */ (b?.parentElement?.querySelector('input') || null);
  if (!b || !input) return;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    b.textContent = 'Copied';
  } catch {
    document.execCommand('copy');
  }
});

// --------------------------------------------------------------------- the card and its steps
function renderHub() {
  if (!hubState) return;
  $form('hub-form').enabled.checked = hubState.enabled;
  // Demo mode shows Activity (sample events) even with the hub off.
  const show = hubState.enabled || S.demo;
  $('hub-config').hidden = !show;
  $('hub-steps').hidden = !hubState.enabled;
  if (hubState.enabled) {
    renderSources();
    renderRoutes();
    hubCustom = structuredClone(customRules());
    $form('hub-rules-form').flapMinutes.value = String(hubState.flapMinutes);
    renderCustom();
    renderDigests();
    field($form('hub-public-form'), 'publicUrl').value = hubState.publicUrl || '';
  }
  showStep(hubState.enabled ? lastStep() : 4);
}

const lastStep = () => {
  try {
    return Number(localStorage.getItem('mo-hub-step')) || 1;
  } catch {
    return 1;
  }
};
/** @param {number} n */
function showStep(n) {
  for (const p of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#hub [data-panel]')))
    p.hidden = Number(p.dataset.panel) !== n;
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#hub-steps [data-step]')))
    b.setAttribute('aria-current', Number(b.dataset.step) === n ? 'step' : 'false');
  try {
    if (hubState?.enabled) localStorage.setItem('mo-hub-step', String(n));
  } catch {
    /* private window: start at step 1 next time */
  }
  if (n === 4 && hubState) loadHubActivity();
}
$('hub').addEventListener('click', e => {
  const b = closest(e, '[data-step], [data-go]');
  if (!b) return;
  showStep(Number(b.dataset.step || b.dataset.go));
  $('hub-steps').scrollIntoView({ block: 'nearest' });
});

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
    /** @type {HubSettings} */
    const st = await api('/hub', { method: 'PUT', body: { enabled: $form('hub-form').enabled.checked } });
    hubState = st;
    S.hubEnabled = st.enabled;
    renderHub();
    renderNotifs(); // destinations' "what it gets" moves to the hub (or back)
    flash($('hub-saved'));
  } catch (err) {
    showError($('hub-error'), err.message);
  }
});

// --------------------------------------------------------------------- 1. connect apps
function renderSources() {
  if (!hubState) return;
  const st = hubState;
  $('hub-sources').innerHTML = st.sources.length
    ? st.sources
        .map(
          s => `<li class="hub-item">
        <div><b>${esc(s.name)}</b> <span class="chip">${esc(st.types.find(t => t.type === s.type)?.label || s.type)}</span>
          <div class="muted">Last heard from ${esc(hubAgo(s.lastSeen))}${s.received ? ` · ${esc(String(s.received))} received` : ''}${s.lastType ? ` · last: ${esc(typeLabel(s.lastType))}` : ''}</div></div>
        <div class="hub-item-acts"><button class="btn small" type="button" data-token="${esc(s.id)}">New address</button><button class="btn small danger ghost" type="button" data-del-source="${esc(s.id)}">Remove</button></div>
      </li>`,
        )
        .join('')
    : '<li class="hub-empty muted">No apps connected yet.</li>';
  const rej = $('hub-rejected');
  rej.hidden = !st.rejected.count;
  rej.textContent = st.rejected.count
    ? `${st.rejected.count} message${st.rejected.count === 1 ? '' : 's'} came with an old or wrong address since Media Ops started (last ${hubAgo(st.rejected.lastAt)}). If an app stopped getting through, give it a new address.`
    : '';
}

// Which saved apps (Settings → Apps) a source can be set up in.
/** @type {Record<string, string[]>} */
const SETUP_KINDS = { sonarr: ['sonarr'], radarr: ['radarr'], seerr: ['seerr', 'overseerr', 'jellyseerr'] };

// Connecting an app, right after its address (with the token, shown only now) was made: how the
// app reaches Media Ops (a question with the likely answer picked), then "Set it up for me" (when
// the app is under Apps) or the address to copy, with numbered steps.
/** @param {{ source: HubSettings['sources'][number], token: string }} made */
function showToken({ source, token }) {
  if (!hubState) return;
  const type = hubState.types.find(t => t.type === source.type);
  const label = type?.label || source.type;
  const apps = S.services.filter(s => (SETUP_KINDS[source.type] || []).includes(s.kind));
  // The app this source is probably for: same name or instance, else the first of its kind.
  const guess =
    apps.find(a => a.name.toLowerCase() === source.name.toLowerCase()) ||
    apps.find(a => a.name.toLowerCase().replace(/\s+/g, '-') === source.instance) ||
    apps[0] ||
    null;
  const here = location.origin;
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  openModal(
    `Connect ${source.name}`,
    `<div class="form" id="hub-connect" data-source="${esc(source.id)}">
      <p class="hint hub-once"><b>Keep this window open until you're done:</b> the address below contains a password that's only shown now. (Lost it? “New address” makes another.)</p>
      ${
        apps.length > 1
          ? `<label class="field"><span>Which ${esc(label)}?</span><select name="app">${apps
              .map(
                a =>
                  `<option value="${esc(a.id)}" ${a.id === guess?.id ? 'selected' : ''}>${esc(a.name)} (${esc(a.url)})</option>`,
              )
              .join('')}</select></label>`
          : ''
      }
      <fieldset class="field hub-reach"><legend>How does ${esc(apps.length === 1 ? apps[0].name : label)} reach Media Ops?</legend>
        <label class="hub-reach-opt"><input type="radio" name="reach" value="docker">
          <span><span class="hub-reach-title"><b>On the same Docker network</b> <em class="hub-reco" data-reco="docker" hidden>recommended</em></span>
          <small>When ${esc(label)} and Media Ops both run in Docker and share a network (for example, the same docker-compose file, or one Unraid custom network). Apps there find each other by container name.</small>
          <code data-base="docker"></code><small data-self-note hidden>That's Media Ops' port inside its container: use it even if you mapped a different one outside. Named the container something other than media-ops? Use “Something else”.</small></span></label>
        <label class="hub-reach-opt"><input type="radio" name="reach" value="host" checked>
          <span><span class="hub-reach-title"><b>Through this computer's address</b> <em class="hub-reco" data-reco="host" hidden>recommended</em></span>
          <small>When ${esc(label)} runs on another computer, or isn't in Docker.${local ? " You opened this page as localhost, which only works on this computer: type the server's network address under “Something else” instead." : ''}</small>
          <code data-base="host">${esc(here)}</code></span></label>
        <label class="hub-reach-opt"><input type="radio" name="reach" value="custom">
          <span><b>Something else</b>
          <small>Any address ${esc(label)} can open Media Ops at, like http://192.168.1.10:8484 or http://mediaops:8484.</small>
          <input name="custom" type="url" placeholder="http://192.168.1.10:8484" spellcheck="false"></span></label>
      </fieldset>
      <p class="hint hub-detect" id="hub-detect" hidden></p>

      ${
        apps.length
          ? `<div class="hub-setup"><button class="btn primary" type="button" id="hub-setup-btn">Set it up in ${esc(guess?.name || label)} for me</button>
              <small>Adds a “Media Ops” webhook in ${esc(guess?.name || label)} with the right events, using the API key saved under Apps, then sends a test message (you'll see it in step 4).</small>
              <div class="test-result" id="hub-setup-result" hidden></div></div>
             <details class="more"><summary>Or add it in ${esc(label)} yourself</summary><div class="form" id="hub-manual"></div></details>`
          : `<p class="hint">Add ${esc(label)} under <b>Apps</b> (top of this page) and Media Ops can set this up for you. Or add it yourself:</p><div class="form" id="hub-manual"></div>`
      }
      <div class="actions"><span class="spacer"></span><button class="btn" type="button" data-close>Done</button></div>
    </div>`,
  );
  const box = $('hub-connect');
  const appSel = /** @type {HTMLSelectElement | null} */ (box.querySelector('select[name=app]'));
  const customIn = /** @type {HTMLInputElement} */ (box.querySelector('input[name=custom]'));
  /** @type {Record<string, string>} */
  const bases = { host: here, docker: 'http://media-ops:8484' };
  const chosen = () =>
    /** @type {HTMLInputElement | null} */ (box.querySelector('input[name=reach]:checked'))?.value || 'host';
  const base = () => (chosen() === 'custom' ? customIn.value.trim().replace(/\/+$/, '') : bases[chosen()]);
  const appNow = () => apps.find(a => a.id === (appSel?.value || guess?.id)) || null;
  // The address to copy and the numbered steps follow the choice above.
  const renderManual = () => {
    const url = `${base() || 'http://…'}${source.path}`;
    $('hub-manual').innerHTML = `
      ${copyRow(`Address for ${label}`, `${url}?token=${token}`)}
      <ol class="hint hub-howto">${String(type?.how || '')
        .split('\n')
        .map(l => `<li>${esc(l)}</li>`)
        .join('')}</ol>
      <details class="more"><summary>The app wants the password separately?</summary>
        <p class="hint">Use the address without <code>?token=…</code> and send the password as an <code>X-Hub-Token</code> header, or as the password of Basic auth.</p>
        ${copyRow('Address without the password', url)}
        ${copyRow('Password (token)', token)}
      </details>`;
  };
  // Ask the server what it can tell: the app's saved address, and Docker's networks.
  const detect = async () => {
    /** @type {any} */
    let r = null;
    try {
      r = await api(`/hub/reach/${encodeURIComponent(appNow()?.id || 'none')}`);
    } catch {
      /* keep the plain choices */
    }
    if (r) bases.docker = r.dockerBase;
    /** @type {HTMLElement} */ (box.querySelector('[data-base=docker]')).textContent = bases.docker;
    /** @type {HTMLElement} */ (box.querySelector('[data-self-note]')).hidden = false;
    const pick = r?.recommend || 'host';
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (box.querySelectorAll('[data-reco]')))
      el.hidden = el.dataset.reco !== pick;
    // The likely answer, unless the person already chose one while this was being worked out.
    if (!box.dataset.picked)
      /** @type {HTMLInputElement} */ (box.querySelector(`input[name=reach][value=${pick}]`)).checked = true;
    const msg = $('hub-detect');
    msg.hidden = !(r?.warning || r?.note);
    msg.className = `hint hub-detect${r?.warning ? ' warn' : ' ok'}`;
    msg.textContent = r?.warning ? `⚠ ${r.warning}` : r?.note ? `✓ ${r.note}` : '';
    const btn = $('hub-setup-btn');
    if (btn) btn.textContent = `Set it up in ${appNow()?.name || label} for me`;
    renderManual();
  };
  box.addEventListener('change', e => {
    if (e.target === appSel) return detect();
    if (/** @type {HTMLInputElement} */ (e.target).name === 'reach') box.dataset.picked = '1';
    renderManual();
  });
  customIn.addEventListener('input', () => {
    /** @type {HTMLInputElement} */ (box.querySelector('input[name=reach][value=custom]')).checked = true;
    box.dataset.picked = '1';
    renderManual();
  });
  $('hub-setup-btn')?.addEventListener('click', async e => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const out = $('hub-setup-result');
    const app = appNow();
    if (!app) return;
    if (!/^https?:\/\/[^\s/?#@]+$/i.test(base())) {
      out.hidden = false;
      out.className = 'test-result bad';
      out.textContent = 'Type the address first, like http://192.168.1.10:8484 (no path).';
      return;
    }
    /** @param {boolean} replace */
    const send = async replace => {
      const r = await fetch(`/api/settings/hub/sources/${encodeURIComponent(source.id)}/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: app.id, base: base(), token, replace }),
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    btn.disabled = true;
    out.hidden = false;
    out.className = 'test-result';
    out.textContent = `Setting it up in ${app.name}…`;
    try {
      let r = await send(false);
      if (r.status === 409 && r.data.needsConfirm) {
        // Seerr has one webhook: only take it over when told to.
        if (
          !confirm(
            `${app.name}'s webhook already sends to ${r.data.current}. Seerr has only one webhook: replace it with Media Ops?`,
          )
        ) {
          out.textContent = 'Left as it was. You can still add the address yourself below.';
          btn.disabled = false;
          return;
        }
        r = await send(true);
      }
      if (r.status !== 200) throw new Error(r.data.error || `HTTP ${r.status}`);
      out.className = 'test-result ok';
      out.textContent = `✓ Done: ${app.name} now tells Media Ops as things happen${r.data.updated ? ' (its existing Media Ops webhook was updated)' : ''}. It sent a test message: step 4 (Activity) shows it.`;
      btn.textContent = 'Set up again';
    } catch (err) {
      out.className = 'test-result bad';
      out.textContent = `✕ ${err.message}${chosen() === 'docker' ? ' Try “Through this computer’s address” instead.' : ''}`;
    }
    btn.disabled = false;
  });
  renderManual();
  detect();
}

$('hub-add-source').addEventListener('click', () => {
  if (!hubState) return;
  openModal(
    'Connect an app',
    `<form class="form grid-form" id="hub-source-form">
      <label class="field"><span>Which app</span><select name="type">${hubState.types.map(t => `<option value="${esc(t.type)}">${esc(t.label)}</option>`).join('')}</select></label>
      <label class="field"><span>Name it <em>optional</em></span><input name="name" placeholder="Sonarr" maxlength="100"></label>
      <details class="more wide"><summary>More options (two of the same app, an anime library)</summary>
        <div class="form grid-form">
          <label class="field"><span>Short name for its address</span><input name="instance" placeholder="sonarr-anime" pattern="[a-z0-9][a-z0-9\\-]{0,39}" spellcheck="false">
            <small>Needed only for a second Sonarr or Radarr: lowercase letters, digits and dashes.</small></label>
          <label class="field"><span>Library its titles belong to</span><input name="library" placeholder="Anime" maxlength="100">
            <small>When it isn't Movies or TV Shows, like an anime Sonarr.</small></label>
        </div>
      </details>
      <div class="form-error wide" id="hub-source-error" hidden></div>
      <div class="actions wide"><span class="spacer"></span><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Connect</button></div>
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
      if (!confirm('Make a new address? The old one stops working at once, so the app needs the new one.')) return;
      showToken(await api(`/hub/sources/${encodeURIComponent(tok.dataset.token || '')}/token`, { method: 'POST' }));
    } else if (del) {
      if (!confirm('Disconnect this app? What it sends will be refused.')) return;
      await api(`/hub/sources/${encodeURIComponent(del.dataset.delSource || '')}`, { method: 'DELETE' });
    } else return;
    hubState = await api('/hub');
    renderSources();
  } catch (err) {
    alert(err.message);
  }
});

// --------------------------------------------------------------------- 2. where things go
/** @param {string} type */
function routeSummary(type) {
  const r = ruleFor(type);
  if (!r || r.action === 'drop') return `<span class="hub-to off">Don't tell me</span>`;
  if (r.action === 'digest') return `<span class="hub-to digest">In “${esc(digestTitle(r.digest))}”</span>`;
  const d = r.destinations || [];
  return d.length
    ? d.map(id => `<span class="hub-to now">${esc(targetName(id))}</span>`).join('')
    : `<span class="hub-to warn">Right away, but no destination picked</span>`;
}

function renderRoutes() {
  if (!hubState) return;
  const groups = [...new Set(hubState.eventTypes.map(t => t.group))];
  $('hub-routes').innerHTML = groups
    .map(
      g =>
        `<h4 class="hub-group">${esc(g)}</h4><ul class="hub-list hub-routes">${(hubState?.eventTypes || [])
          .filter(t => t.group === g)
          .map(
            t => `<li class="hub-route" data-route="${esc(t.type)}">
            <div class="hub-route-what"><b>${esc(t.label)}</b><span class="muted">${esc(t.from)}${customFirst(t.type) ? ' · a custom rule may take some of these first' : ''}</span></div>
            <div class="hub-route-to">${routeSummary(t.type)}</div>
            <button class="btn small" type="button" data-change aria-expanded="${openRoute === t.type}">${openRoute === t.type ? 'Close' : 'Change'}</button>
            ${openRoute === t.type ? routeEditor(t.type) : ''}
          </li>`,
          )
          .join('')}</ul>`,
    )
    .join('');
}

// The inline editor under a row: right away (to which destinations), in a summary, or nowhere.
/** @param {string} type */
function routeEditor(type) {
  const r = ruleFor(type);
  const mode = !r || r.action === 'drop' ? 'drop' : r.action;
  const picked = new Set(r?.action === 'now' ? r.destinations || [] : []);
  const dests = S.notifications.targets
    .map(
      t =>
        `<label class="check"><input type="checkbox" name="dest" value="${esc(t.id)}" ${picked.has(t.id) ? 'checked' : ''}><span>${esc(t.name)} <span class="muted">${esc(S.notifyTypes.find(x => x.type === t.type)?.label || t.type)}</span></span></label>`,
    )
    .join('');
  const digests = (hubState?.digests || [])
    .map(
      d =>
        `<option value="${esc(d.id)}" ${r?.digest === d.id ? 'selected' : ''}>${esc(d.title)}${d.enabled ? '' : ' (off: turn it on in step 3)'}</option>`,
    )
    .join('');
  return `<form class="hub-route-edit" data-route-form="${esc(type)}">
    <label class="check"><input type="radio" name="mode" value="now" ${mode === 'now' ? 'checked' : ''}><span><b>Right away</b>, to:</span></label>
    <div class="hub-route-dests">${dests || '<span class="muted">No destinations yet.</span>'}
      <button class="linkish" type="button" data-add-discord>+ Add a Discord channel</button>
      <div class="hub-add-discord" hidden>
        <label class="field"><span>Channel name</span><input name="dname" placeholder="#new-on-plex" maxlength="100"></label>
        <label class="field"><span>Webhook URL <em>Discord channel → Edit → Integrations → Webhooks</em></span><input name="dhook" type="url" placeholder="https://discord.com/api/webhooks/…" spellcheck="false"></label>
        <button class="btn small" type="button" data-save-discord>Add channel</button>
      </div>
    </div>
    <label class="check"><input type="radio" name="mode" value="digest" ${mode === 'digest' ? 'checked' : ''} ${digests ? '' : 'disabled'}><span><b>In a summary</b>:</span></label>
    <div class="hub-route-dests"><select name="digest" aria-label="Summary">${digests}</select></div>
    <label class="check"><input type="radio" name="mode" value="drop" ${mode === 'drop' ? 'checked' : ''}><span><b>Don't tell me</b></span></label>
    <div class="form-error" data-route-error hidden></div>
    <div class="actions"><span class="spacer"></span><button class="btn ghost small" type="button" data-change>Cancel</button><button class="btn primary small" type="submit">Save</button></div>
  </form>`;
}

$('hub-routes').addEventListener('click', async e => {
  const li = closest(e, '[data-route]');
  if (!li) return;
  const type = li.dataset.route || '';
  if (closest(e, '[data-change]')) {
    openRoute = openRoute === type ? null : type;
    renderRoutes();
    return;
  }
  if (closest(e, '[data-add-discord]')) {
    const box = /** @type {HTMLElement} */ (li.querySelector('.hub-add-discord'));
    box.hidden = !box.hidden;
    if (!box.hidden) /** @type {HTMLInputElement} */ (box.querySelector('input')).focus();
    return;
  }
  if (closest(e, '[data-save-discord]')) {
    const f = /** @type {HTMLFormElement} */ (li.querySelector('form'));
    const err = /** @type {HTMLElement} */ (f.querySelector('[data-route-error]'));
    showError(err, '');
    try {
      // A Discord channel is a destination like any other (Settings → Notifications lists it too).
      const t = await api('/notifications', {
        method: 'POST',
        body: {
          type: 'discord',
          name: field(f, 'dname').value || 'Discord',
          webhookUrl: field(f, 'dhook').value,
          events: {},
        },
      });
      S.notifications.targets = [...S.notifications.targets, t];
      renderNotifs();
      // Keep what was ticked, add the new channel ticked, and pick "right away".
      const ticked = new Set(
        [...f.querySelectorAll('input[name=dest]:checked')].map(x => /** @type {HTMLInputElement} */ (x).value),
      );
      renderRoutes();
      const nf = /** @type {HTMLFormElement} */ (document.querySelector(`[data-route-form="${CSS.escape(type)}"]`));
      for (const x of /** @type {NodeListOf<HTMLInputElement>} */ (nf.querySelectorAll('input[name=dest]')))
        x.checked = ticked.has(x.value) || x.value === t.id;
      /** @type {HTMLInputElement} */ (nf.querySelector('input[name=mode][value=now]')).checked = true;
    } catch (ex) {
      showError(err, ex.message);
    }
  }
});

$('hub-routes').addEventListener('submit', async e => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  const type = f.dataset.routeForm || '';
  const fd = new FormData(f);
  const mode = String(fd.get('mode') || 'drop');
  const err = /** @type {HTMLElement} */ (f.querySelector('[data-route-error]'));
  showError(err, '');
  const old = rowRules().find(r => asList(r.match.type)[0] === type);
  /** @type {HubRule} */
  const rule = {
    id: old?.id || `row-${type.replace(/[^\w-]/g, '-')}`,
    name: typeLabel(type),
    enabled: true,
    match: { type: [type] },
    action: /** @type {HubRule['action']} */ (mode),
  };
  if (mode === 'now') {
    rule.destinations = fd.getAll('dest').map(String);
    if (!rule.destinations.length) return showError(err, 'Tick at least one destination, or choose "Don\'t tell me".');
  }
  if (mode === 'digest') rule.digest = String(fd.get('digest') || '');
  // This row's rule replaces any earlier one for the same type (switched off or not).
  const rows = rowRules().filter(r => asList(r.match.type)[0] !== type);
  try {
    await saveRules(customRules(), [...rows, rule]);
    // Close this row's editor, not one opened meanwhile (the save takes a moment).
    if (openRoute === type) openRoute = null;
    renderRoutes();
    renderDigests(); // "Gathers:" may have changed
  } catch (ex) {
    showError(err, ex.message);
  }
});

// --------------------------------------------------------------------- 2b. custom rules (advanced)
const SEVERITY = ['info', 'warning', 'error', 'critical'];

/** @param {HubRule} r */
function ruleSummary(r) {
  const m = r.match || {};
  const types = asList(m.type).map(typeLabel);
  const libs = asList(m['media.library']);
  const what = `${types.length ? types.join(', ') : 'anything'}${libs.length ? ` in ${libs.join(', ')}` : ''}${m.min_severity ? `, ${m.min_severity} or worse` : ''}${Object.keys(m).some(k => !['type', 'media.library', 'min_severity'].includes(k)) ? ' (and more)' : ''}`;
  const to =
    r.action === 'now'
      ? (r.destinations || []).length
        ? `right away to ${(r.destinations || []).map(targetName).join(', ')}`
        : 'right away (no destination picked)'
      : r.action === 'digest'
        ? `in “${digestTitle(r.digest)}”`
        : "don't tell me";
  return `${what} → ${to}`;
}

function renderCustom() {
  $('hub-adv-count').textContent = hubCustom.length ? String(hubCustom.length) : '';
  const last = hubCustom.length - 1;
  $('hub-rules').innerHTML = hubCustom.length
    ? hubCustom
        .map(
          (r, i) => `<li class="hub-rule${r.enabled ? '' : ' off'}" data-rule="${i}">
        <input type="checkbox" data-enable aria-label="On" ${r.enabled ? 'checked' : ''}>
        <span class="hub-rule-text"><b>${esc(r.name)}</b><span class="muted">${esc(ruleSummary(r))}</span></span>
        <span class="layout-move"><button class="icon-btn" type="button" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="icon-btn" type="button" data-move="1" ${i === last ? 'disabled' : ''} aria-label="Move down">↓</button><button class="icon-btn" type="button" data-edit aria-label="Edit">✎</button></span></li>`,
        )
        .join('')
    : '<li class="hub-empty muted">No custom rules. The list above decides everything.</li>';
}

$('hub-rules').addEventListener('click', e => {
  const li = closest(e, '[data-rule]');
  if (!li) return;
  const i = Number(li.dataset.rule);
  const mv = closest(e, '[data-move]');
  if (mv) {
    const j = i + Number(mv.dataset.move);
    if (j < 0 || j >= hubCustom.length) return;
    [hubCustom[i], hubCustom[j]] = [hubCustom[j], hubCustom[i]];
    renderCustom();
  } else if (closest(e, '[data-edit]')) editRule(i);
});
$('hub-rules').addEventListener('change', e => {
  const box = closest(e, '[data-enable]');
  const li = closest(e, '[data-rule]');
  if (!box || !li) return;
  hubCustom[Number(li.dataset.rule)].enabled = /** @type {HTMLInputElement} */ (box).checked;
  renderCustom();
});
$('hub-add-rule').addEventListener('click', () => editRule(-1));

// One custom rule in the modal. Only the fields the form shows change; anything else the rule
// matches on (set by hand in config.json) is kept.
/** @param {number} i -1 for a new rule */
function editRule(i) {
  if (!hubState) return;
  const st = hubState;
  /** @type {HubRule} */
  const r = i >= 0 ? hubCustom[i] : { id: '', name: '', enabled: true, match: {}, action: 'now', destinations: [] };
  const types = new Set(asList(r.match.type));
  const known = new Set(st.eventTypes.map(t => t.type));
  const other = [...types].filter(t => !known.has(t));
  const checks = st.eventTypes
    .map(
      t =>
        `<label class="check"><input type="checkbox" name="type" value="${esc(t.type)}" ${types.has(t.type) ? 'checked' : ''}><span>${esc(t.label)}</span></label>`,
    )
    .join('');
  const dests = S.notifications.targets
    .map(
      t =>
        `<label class="check"><input type="checkbox" name="dest" value="${esc(t.id)}" ${(r.destinations || []).includes(t.id) ? 'checked' : ''}><span>${esc(t.name)}</span></label>`,
    )
    .join('');
  openModal(
    i >= 0 ? 'Edit custom rule' : 'New custom rule',
    `<form class="form grid-form" id="hub-rule-form">
      <label class="field"><span>Name</span><input name="name" required maxlength="120" value="${esc(r.name)}" placeholder="New anime goes to #anime"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}><span>On</span></label>
      <fieldset class="field wide events hub-types"><legend>When <em>none ticked = anything</em></legend>${checks}</fieldset>
      <label class="field"><span>Only in these libraries <em>optional</em></span><input name="libraries" value="${esc(asList(r.match['media.library']).join(', '))}" placeholder="Anime"></label>
      <label class="field"><span>Only when at least this serious</span><select name="minSeverity"><option value="">any</option>${SEVERITY.slice(
        1,
      )
        .map(v => `<option value="${v}" ${r.match.min_severity === v ? 'selected' : ''}>${v}</option>`)
        .join('')}</select></label>
      <label class="field"><span>Other kinds <em>from your own scripts</em></span><input name="otherTypes" value="${esc(other.join(', '))}" placeholder="backup.finished" spellcheck="false"></label>
      <label class="field"><span>Then</span><select name="then">
        <option value="now" ${r.action === 'now' ? 'selected' : ''}>Right away</option>
        <option value="digest" ${r.action === 'digest' ? 'selected' : ''}>In a summary</option>
        <option value="drop" ${r.action === 'drop' ? 'selected' : ''}>Don't tell me</option></select></label>
      <fieldset class="field wide events" id="hub-rule-dests"><legend>Send to</legend>${dests || '<span class="muted">Add a destination first (a row\'s “+ Add a Discord channel”, or under Notifications).</span>'}</fieldset>
      <label class="field" id="hub-rule-digest"><span>Summary</span><select name="digest">${st.digests
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
    hubCustom.splice(i, 1);
    modal.close();
    renderCustom();
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
    // A rule for one kind only, with nothing else to it, is just that kind's row: say so.
    if (isRow(next))
      return showError(
        $('hub-rule-error'),
        `For one kind on its own, use its row in the list (“${typeLabel(asList(next.match.type)[0])}”). Add a library or how serious, or pick several kinds, for a custom rule.`,
      );
    if (i >= 0) hubCustom[i] = next;
    else hubCustom.push(next);
    modal.close();
    renderCustom();
  });
}

$form('hub-rules-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('hub-rules-error'), '');
  try {
    if (hubState) hubState.flapMinutes = Number($form('hub-rules-form').flapMinutes.value);
    await saveRules(hubCustom, rowRules());
    renderHub();
    flash($('hub-rules-saved'));
  } catch (err) {
    showError($('hub-rules-error'), err.message);
  }
});

// --------------------------------------------------------------------- 3. summaries
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
  return `on the schedule ${cron}${zone}`;
}

function renderDigests() {
  if (!hubState) return;
  const st = hubState;
  // What goes into each summary: the rows (and custom rules) that send to it.
  /** @param {string} id */
  const feeds = id =>
    st.rules
      .filter(r => r.enabled && r.action === 'digest' && r.digest === id)
      .map(r => (isRow(r) ? typeLabel(asList(r.match.type)[0]) : r.name));
  $('hub-digests').innerHTML = st.digests.length
    ? st.digests
        .map(d => {
          const what = feeds(d.id);
          return `<li class="hub-item${d.enabled ? '' : ' off'}" data-digest="${esc(d.id)}">
        <div><b>${esc(d.title)}</b> <span class="chip">${d.enabled ? 'on' : 'off'}</span>
          <div class="muted">${esc(cronWords(d.cron, d.timezone))} · to ${d.destinations.length ? esc(d.destinations.map(targetName).join(', ')) : 'nowhere yet'}${d.recipients?.length ? ` · ${d.recipients.length} email address${d.recipients.length === 1 ? '' : 'es'}` : ''}</div>
          <div class="muted">Gathers: ${what.length ? esc(what.join(', ')) : 'nothing yet (choose “In a summary” for a kind in step 2)'}</div>
          <div class="muted">${d.last ? `Last ${esc(hubAgo(d.last.sentAt))}: ${esc(d.last.status === 'sent' ? `sent, ${d.last.items} new` : d.last.status === 'empty' ? 'nothing new, so nothing sent' : d.last.status)}` : 'Not sent yet'}</div></div>
        <div class="hub-item-acts"><button class="btn small" type="button" data-preview>Preview</button><button class="btn small" type="button" data-send>Send now</button><button class="btn small" type="button" data-edit>Edit</button></div>
      </li>`;
        })
        .join('')
    : '<li class="hub-empty muted">No summaries.</li>';
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
        `<p class="hint">What it would send right now${p.items ? '' : ': nothing new yet, so it would send nothing'}. Discord shows it as cards with posters, email with pictures.</p>
         <pre class="digest-preview">${esc([p.text.title, '', ...p.text.lines].join('\n'))}</pre>
         <div class="actions"><span class="spacer"></span><button class="btn primary" type="button" data-close>Close</button></div>`,
      );
    } else if (closest(e, '[data-send]')) {
      if (!confirm(`Send “${d.title}” now? What it has gathered is sent and starts over, as on a scheduled day.`))
        return;
      const r = await api(`/hub/digests/${encodeURIComponent(d.id)}/send`, { method: 'POST' });
      alert(
        r.status === 'started'
          ? `Sending now (${r.items} new). Activity (step 4) shows when it has gone.`
          : r.status === 'sent'
            ? `Sent to ${r.sent} destination${r.sent === 1 ? '' : 's'} (${r.items} new).`
            : r.status === 'empty'
              ? 'Nothing new to send.'
              : r.status === 'no-destination'
                ? 'Pick where it goes first (Edit).'
                : r.status === 'busy'
                  ? 'It’s being sent right now.'
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
  const slug = (/** @type {string} */ t) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 36) || 'summary';
  openModal(
    d ? `Edit “${d.title}”` : 'New summary',
    `<form class="form grid-form" id="hub-digest-form">
      <label class="field"><span>Title <em>shown at the top of each one</em></span><input name="title" required maxlength="100" value="${esc(d?.title || '')}" placeholder="Added to Plex"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${d?.enabled ? 'checked' : ''}><span>On</span></label>
      <label class="field"><span>How often</span><select name="kind">
        <option value="daily" ${c.kind === 'daily' ? 'selected' : ''}>Every day</option>
        <option value="weekly" ${c.kind === 'weekly' ? 'selected' : ''}>Every week</option>
        <option value="custom" ${c.kind === 'custom' ? 'selected' : ''}>Custom (cron)</option></select></label>
      <label class="field" data-when="weekly"><span>On</span><select name="day">${WEEKDAYS.map((w, i) => `<option value="${i}" ${c.day === i ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
      <label class="field" data-when="daily weekly"><span>At</span><input type="time" name="time" value="${esc(c.time)}"></label>
      <label class="field" data-when="custom"><span>Cron</span><input name="cron" value="${esc(d?.cron || '0 8 * * *')}" spellcheck="false" placeholder="0 8 * * *">
        <small>minute hour day month weekday</small></label>
      <label class="field"><span>Time zone <em>blank = the server's</em></span><input name="timezone" list="hub-zones" value="${esc(d?.timezone || '')}" placeholder="America/Chicago" spellcheck="false">
        <datalist id="hub-zones">${zones.map(z => `<option value="${esc(z)}">`).join('')}</datalist></label>
      <fieldset class="field wide events"><legend>Send it to</legend>${dests || '<span class="muted">Add a Discord channel in step 2 first (or a destination under Notifications).</span>'}</fieldset>
      <label class="field toggle wide"><input type="checkbox" name="skipIfEmpty" ${d?.skipIfEmpty === false ? '' : 'checked'}><span>Send nothing on a day with nothing new</span></label>
      <details class="more wide"><summary>More: email list, footer, size</summary>
        <div class="form grid-form">
          <label class="field wide"><span>Email it to these people <em>optional · needs an email destination ticked above</em></span><textarea name="recipients" rows="3" spellcheck="false" placeholder="one@example.com, two@example.com">${esc((d?.recipients || []).join(', '))}</textarea>
            <small>Each address gets its own copy with an unsubscribe link (set the public address in step 3 first). Empty: the email destination's own address.</small></label>
          <label class="field"><span>Footer <em>optional</em></span><input name="footer" maxlength="200" value="${esc(d?.footer || '')}" placeholder="Request more at requests.example.com"></label>
          <label class="field"><span>Most titles per section</span><input type="number" name="max" min="1" max="100" value="${esc(String(d?.maxItemsPerSection ?? 25))}"></label>
        </div>
      </details>
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
    const list = hubState?.digests || [];
    // A new summary's id (what rules point at) comes from its title, made unique.
    const base = slug(String(fd.get('title') || ''));
    let id = d?.id || base;
    if (!d) for (let n = 2; list.some(x => x.id === id); n++) id = `${base}_${n}`;
    const next = {
      id,
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
    save(/** @type {any} */ (d ? list.map(x => (x.id === d.id ? next : x)) : [...list, next]));
  });
}

$form('hub-public-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('hub-public-error'), '');
  try {
    hubState = await api('/hub', {
      method: 'PUT',
      body: { enabled: true, publicUrl: field($form('hub-public-form'), 'publicUrl').value },
    });
    flash($('hub-public-saved'));
  } catch (err) {
    showError($('hub-public-error'), err.message);
  }
});

// --------------------------------------------------------------------- 4. activity
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
      return `Sending to ${names} in a moment`;
    case 'held':
      return `Held for quiet hours, then to ${names}`;
    case 'suppressed':
      return 'Not sent again: the same thing went out moments ago';
    case 'queued':
      return `Waiting for “${digestTitle(e.digestId)}”`;
    case 'digested':
      return e.sentAt
        ? `In “${digestTitle(e.digestId)}”, sent ${hubWhen(e.sentAt)}`
        : `Gathered for “${digestTitle(e.digestId)}” (nothing else new, so not posted)`;
    case 'dropped':
      return 'Not sent (set to “Don’t tell me”)';
    case 'unrouted':
      return 'Not sent: no destination picked';
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
                <span class="hub-what"><span class="chip" title="${esc(e.type)}">${esc(typeLabel(e.type))}</span> ${esc(hubOutcome(e))}</span></summary>
              <dl class="kv hub-detail">
                <dt>Decided by</dt><dd>${esc(e.rule === 'Everything else' ? 'Nothing set for this kind (“Don’t tell me”)' : e.rule || '—')}</dd>
                <dt>From</dt><dd>${esc(e.source === 'media-ops' ? 'Media Ops itself' : e.source)}${e.sourceInstance && e.sourceInstance !== e.source && e.source !== 'media-ops' ? ` · ${esc(e.sourceInstance)}` : ''}</dd>
                ${e.media?.library ? `<dt>Library</dt><dd>${esc(e.media.library)}</dd>` : ''}
                ${e.media?.quality ? `<dt>Quality</dt><dd>${esc(e.media.quality)}</dd>` : ''}
              </dl>
              ${sends ? `<ul class="fix-log hub-sends">${sends}</ul>` : ''}
            </details>
          </li>`;
        })
        .join('')
    : `<li class="hub-empty muted">${hubEvents.length ? 'Nothing matches that filter.' : 'Nothing yet. Things show up here as they happen.'}</li>`;
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
$('hub-filter').addEventListener('change', renderHubLog);
$('hub-refresh').addEventListener('click', loadHubActivity);
