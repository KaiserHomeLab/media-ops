// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings page: add, edit, reorder and test apps; general options; the settings password
// and its reset flow. Talks to /api/settings/*. Saved API keys never come back from the
// server; the form only learns whether one is saved.
'use strict';

// Elements by id. The ids are fixed in settings.html, so one that's missing is a bug, not a case
// to handle: typed as always there. $form() is the same for the page's <form>s.
/** @param {string} id */
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const $form = id => /** @type {HTMLFormElement} */ (document.getElementById(id));
/** @param {string} id */
const $input = id => /** @type {HTMLInputElement} */ (document.getElementById(id));
/** @param {string} id */
const $button = id => /** @type {HTMLButtonElement} */ (document.getElementById(id));
// A form's field by name. Needed for fields called `title` or `name`: in the browser they win
// over the form's own title/name properties, but the types only know the properties.
/** @param {HTMLFormElement} f @param {string} name */
const field = (f, name) => /** @type {HTMLInputElement} */ (f.elements.namedItem(name));
// The element matching `selector` that an event happened in (event delegation), or null.
/** @param {Event} e @param {string} selector @returns {HTMLElement | null} */
const closest = (e, selector) =>
  e.target instanceof Element ? /** @type {HTMLElement | null} */ (e.target.closest(selector)) : null;
/** @type {Record<string, string>} */
const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** @param {unknown} s */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ENTITY[c]);

/** @type {SettingsPayload} */
let S; // the settings payload from the server, set by load() before anything renders
/** @type {Record<string, any>} */
let appStatus = {}; // service id -> last test result
const modal = /** @type {HTMLDialogElement} */ ($('modal'));

/** @param {string} path @param {{ method?: string, body?: unknown }} [options] @returns {Promise<any>} */
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/settings${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.needLogin) {
    showLogin();
    throw new Error(data.error);
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** @param {HTMLElement} el @param {string} [msg] */
function showError(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}
/** @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
const flashTimers = new WeakMap();
/** @param {HTMLElement} el */
function flash(el) {
  el.hidden = false;
  clearTimeout(flashTimers.get(el));
  flashTimers.set(
    el,
    setTimeout(() => (el.hidden = true), 2500),
  );
}

// --------------------------------------------------------------------- load
async function load() {
  try {
    S = await api('');
  } catch {
    return;
  }
  $('login').hidden = true;
  $('settings-body').hidden = false;
  $('logout').hidden = !S.authEnabled;
  $('demo-banner').hidden = !S.demo;
  $('config-file').textContent = S.configFile;
  renderApps();
  loadFound();
  renderNotifs();
  renderGeneral();
  renderLayout(S.layout);
  renderAutoFix();
  renderAppearance();
  renderMetrics(null);
  renderSecurity();
  loadStatus();
  // The page fills in after loading, so jump to a #section (e.g. #security from the dashboard) now.
  if (location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

async function loadStatus() {
  if (S.demo || !S.services.length) return;
  try {
    const o = await (await fetch('/api/overview')).json();
    appStatus = Object.fromEntries(/** @type {ServiceState[]} */ (o.services).map(s => [s.id, s]));
    renderApps();
  } catch {
    /* the cards just show without a status dot */
  }
}

function showLogin() {
  $('settings-body').hidden = true;
  $('login').hidden = false;
  $form('login-form').password.focus();
}

// `next` comes from the address bar, so only follow it to a page on this site. Resolving it as a
// URL catches the tricks a prefix check misses ("/\evil.example" is "//evil.example" to a browser).
/** @param {string | null} raw */
function sameSitePath(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

$form('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('login-error'), '');
  try {
    await api('/login', { method: 'POST', body: { password: $form('login-form').password.value } });
    $form('login-form').reset();
    const next = sameSitePath(new URLSearchParams(location.search).get('next'));
    if (next) return (location.href = next);
    load();
  } catch (err) {
    showError($('login-error'), err.message);
  }
});
// Forgot password: one-time code from the server's log / config folder.
/** @param {boolean} on */
const showReset = on => {
  $form('login-form').hidden = on;
  $form('reset-form').hidden = !on;
  /** @type {HTMLElement} */ ($('login').querySelector('h2')).textContent = on
    ? 'Reset settings password'
    : 'Settings are locked';
  if (on) $('send-code').focus();
};
$('forgot').addEventListener('click', () => showReset(true));
$('back-to-login').addEventListener('click', () => showReset(false));
$('send-code').addEventListener('click', async e => {
  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
  showError($('reset-error'), '');
  btn.disabled = true;
  try {
    const r = await api('/forgot', { method: 'POST', body: {} });
    $('reset-file').textContent = r.file;
    $('reset-where').hidden = false;
    btn.textContent = 'Send a new code';
    $form('reset-form').code.focus();
  } catch (err) {
    showError($('reset-error'), err.message);
  }
  setTimeout(() => (btn.disabled = false), 30000); // server allows one new code per 30 s
});
$form('reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  showError($('reset-error'), '');
  try {
    await api('/reset', { method: 'POST', body: { code: f.code.value, next: f.next.value } });
    f.reset();
    showReset(false);
    load();
  } catch (err) {
    showError($('reset-error'), err.message);
  }
});

$('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.reload();
});

// --------------------------------------------------------------------- apps grid
/** @param {string} kind */
const kindDef = kind => S.kinds.find(k => k.kind === kind) || S.kinds.find(k => k.kind === 'seerr');
/** @param {string} name */
const abbrev = name =>
  esc(
    name
      .replace(/[^A-Za-z0-9 ]/g, '')
      .split(/\s+/)
      .map(w => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?',
  );

function renderApps() {
  $('apps-count').textContent = S.services.length ? `${S.services.length} connected` : '';
  const cards = S.services.map(s => {
    const st = appStatus[s.id];
    const dot =
      s.enabled === false
        ? ''
        : st
          ? `<span class="dot ${st.up ? 'up' : 'down'}" title="${esc(st.up ? 'Connected' : st.error)}"></span>`
          : '';
    return `<button type="button" class="app-card${s.enabled === false ? ' off' : ''}" draggable="true" data-id="${esc(s.id)}">
      <span class="app-icon k-${esc(s.kind)}" aria-hidden="true">${abbrev(kindDef(s.kind)?.label || s.kind)}</span>
      <span class="app-name">${esc(s.name)} ${dot}</span>
      <span class="app-kind">${esc(kindDef(s.kind)?.label || s.kind)}${s.enabled === false ? ' · disabled' : ''}</span>
      <span class="app-url">${esc(s.url)}</span>
      ${st && !st.up && s.enabled !== false ? `<span class="app-err">✕ ${esc(st.error)}</span>` : ''}
    </button>`;
  });
  cards.push(
    `<button type="button" class="app-card add" id="add-app"><span class="plus" aria-hidden="true">+</span><span>Add app</span></button>`,
  );
  $('apps').innerHTML = cards.join('');

  // Running on Unraid or TrueNAS and it isn't added yet: offer it.
  const os = S.hostOs && S.kinds.find(k => k.kind === S.hostOs);
  const offer = os && !S.services.some(s => s.kind === os.kind);
  $('detected').hidden = !offer;
  if (offer)
    $('detected').innerHTML =
      `<span>Media Ops is running on <b>${esc(os.label)}</b>. Add it to see ${os.kind === 'truenas' ? 'pools, disks, apps and alerts' : 'the array, parity checks and disks'} on the dashboard.</span>
    <button class="btn small primary" type="button" data-add-kind="${esc(os.kind)}">Add ${esc(os.label)}</button>`;
  renderStatusPage(); // its list of apps follows this one
  renderFound();
}
// --------------------------------------------------------------------- apps found in Docker
/** @type {{ kind: string, label: string, container: string, via: string, host: string | null, port: number }[]} */
let found = [];
async function loadFound() {
  try {
    found = (await api('/discover')).apps || [];
  } catch {
    found = [];
  }
  renderFound();
}
// Same kind at the same address (or, for a published port, the same port) is already added.
const SEERR = ['seerr', 'overseerr', 'jellyseerr'];
/** @param {string} a @param {string} b */
const kindMatches = (a, b) => a === b || (SEERR.includes(a) && SEERR.includes(b));
/** @param {(typeof found)[number]} app */
function alreadyAdded(app) {
  return S.services.some(s => {
    if (!kindMatches(s.kind, app.kind)) return false;
    try {
      const u = new URL(s.url);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      return port === app.port && (!app.host || u.hostname === app.host);
    } catch {
      return false;
    }
  });
}
/** @param {(typeof found)[number]} app */
function foundUrl(app) {
  const host = app.host || serverHost();
  return host ? `http://${host}:${app.port}` : '';
}
function renderFound() {
  const list = found.map((a, i) => ({ ...a, i })).filter(a => !alreadyAdded(a));
  $('found').hidden = !list.length;
  if (!list.length) return;
  $('found').innerHTML = `<span>Found in Docker. Click one to add it; you'll only need its API key.</span>
    <span class="found-apps">${list
      .map(
        a =>
          `<button class="btn small" type="button" data-found="${a.i}" title="Container ${esc(a.container)} · ${esc(foundUrl(a) || 'address unknown')}"><span class="app-icon k-${esc(a.kind)}" aria-hidden="true">${abbrev(a.label)}</span>${esc(a.label)}${found.filter(f => f.kind === a.kind).length > 1 ? ` <em>${esc(a.container)}</em>` : ''}</button>`,
      )
      .join('')}</span>`;
}
$('found').addEventListener('click', e => {
  const b = closest(e, '[data-found]');
  if (!b) return;
  const app = found[Number(b.dataset.found)];
  const twins = found.filter(f => f.kind === app.kind).length > 1;
  openForm(app.kind, null, { name: twins ? app.container : app.label, url: foundUrl(app) });
});

$('detected').addEventListener('click', e => {
  const b = closest(e, '[data-add-kind]');
  if (b?.dataset.addKind) openForm(b.dataset.addKind);
});

$('apps').addEventListener('click', e => {
  const card = closest(e, '.app-card');
  if (!card) return;
  if (card.id === 'add-app') return openPicker();
  const svc = S.services.find(s => s.id === card.dataset.id);
  if (svc) openForm(svc.kind, svc);
});

// Drag to reorder
/** @type {string | null} */
let dragId = null;
$('apps').addEventListener('dragstart', e => {
  const c = closest(e, '.app-card[data-id]');
  if (!c) return;
  dragId = c.dataset.id || null;
  c.classList.add('dragging');
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
});
$('apps').addEventListener('dragover', e => {
  const over = closest(e, '.app-card[data-id]');
  if (!dragId || !over || over.dataset.id === dragId) return;
  e.preventDefault();
  const dragged = $('apps').querySelector(`[data-id="${CSS.escape(dragId)}"]`);
  const r = over.getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2;
  if (dragged) over.parentNode?.insertBefore(dragged, after ? over.nextSibling : over);
});
$('apps').addEventListener('dragend', async () => {
  if (!dragId) return;
  dragId = null;
  const ids = [.../** @type {NodeListOf<HTMLElement>} */ ($('apps').querySelectorAll('.app-card[data-id]'))].map(
    c => c.dataset.id,
  );
  S.services.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  renderApps();
  await api('/order', { method: 'PUT', body: { ids } }).catch(err => alert(err.message));
});

// --------------------------------------------------------------------- modal: picker
/** @param {string} title @param {string} html */
function openModal(title, html) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  if (!modal.open) modal.showModal();
}
modal.addEventListener('click', e => {
  if (e.target === modal || closest(e, '[data-close]')) modal.close();
});

function openPicker() {
  const groups = [...new Set(S.kinds.map(k => k.group))];
  openModal(
    'Add app',
    groups
      .map(
        g => `
    <h3 class="pick-group">${esc(g)}</h3>
    <div class="pick-grid">${S.kinds
      .filter(k => k.group === g)
      .map(
        k => `
      <button type="button" class="pick" data-kind="${esc(k.kind)}">
        <span class="app-icon k-${esc(k.kind)}" aria-hidden="true">${abbrev(k.label)}</span>${esc(k.label)}${k.kind === S.hostOs ? ' <span class="tag">this server</span>' : ''}
      </button>`,
      )
      .join('')}
    </div>`,
      )
      .join(''),
  );
  /** @type {NodeListOf<HTMLElement>} */ ($('modal-body').querySelectorAll('.pick')).forEach(b =>
    b.addEventListener('click', () => openForm(b.dataset.kind || '')),
  );
}

// --------------------------------------------------------------------- modal: add / edit form
/** @param {string} h */
const isLoopback = h => /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(h);

/** @param {AppKind} def */
function suggestUrl(def) {
  const host = serverHost();
  if (!host) return '';
  if (def.kind === 'truenas') return `https://${host}`;
  return def.port ? `http://${host}:${def.port}` : `http://${host}`;
}

// The address of the server the apps run on, as Media Ops can reach it, or '' if unknown.
function serverHost() {
  // Most people run everything on one box, so reuse the host of an app already added (or this page's host).
  let host = location.hostname;
  const first = S.services[0];
  if (first)
    try {
      host = new URL(first.url).hostname;
    } catch {}
  // Opened as localhost: that address means the container itself. Docker Desktop has a name for
  // the computer it runs on; elsewhere leave it blank so the placeholder shows an IP to use.
  if (isLoopback(host)) {
    if (!S.platform?.vm) return '';
    host = 'host.docker.internal';
  }
  return host;
}

// Shared by the app and notification forms --------------------------------------------------

// One input from a field definition (lib/kinds.js for apps, lib/notify.js for notifications).
// Secrets are never filled in: a saved one shows as dots, and leaving the box blank keeps it.
/** @param {FormField} f @param {Record<string, any> | null | undefined} item @param {boolean} [required] */
function fieldHtml(f, item, required = !f.optional) {
  const saved = item?.[`${f.key}Saved`];
  const ph = f.type === 'secret' && saved ? '•••••••••••• saved — leave blank to keep' : f.placeholder || '';
  return `<label class="field wide"><span>${esc(f.label)}${f.optional ? ' <em>optional</em>' : ''}</span>
      <input name="${esc(f.key)}" type="${f.type === 'secret' ? 'password' : 'text'}" autocomplete="off" spellcheck="false"
        placeholder="${esc(ph)}" value="${f.type === 'secret' ? '' : esc(item?.[f.key] || '')}"
        ${required && !saved ? 'required' : ''}>
      ${f.help ? `<small>${esc(f.help)}${f.link ? ` <a href="${esc(f.link)}" target="_blank" rel="noopener">How?</a>` : ''}</small>` : ''}
    </label>`;
}

// Delete (when editing) or Back to the picker (when adding), then Test and Save.
/** @param {boolean} editing @param {{ del: string, back: string, test: string, save: string }} ids @param {string} testLabel */
function formActions(editing, ids, testLabel) {
  return `<div class="actions wide">
        ${editing ? `<button class="btn danger ghost" type="button" id="${ids.del}">Delete</button>` : `<button class="btn ghost" type="button" id="${ids.back}">← Back</button>`}
        <span class="spacer"></span>
        <button class="btn" type="button" id="${ids.test}">${testLabel}</button>
        <button class="btn primary" type="submit" id="${ids.save}">Save</button>
      </div>`;
}

/** @param {HTMLElement} btn @param {boolean} busy @param {string} label */
const setBusy = (btn, busy, label) => {
  /** @type {HTMLButtonElement} */ (btn).disabled = busy;
  btn.textContent = busy ? '…' : label;
};
/** @param {HTMLFormElement} form @param {HTMLElement} fallback */
const focusFirstEmpty = (form, fallback) =>
  (
    [.../** @type {NodeListOf<HTMLInputElement>} */ (form.querySelectorAll('input[required]'))].find(i => !i.value) ||
    fallback
  ).focus();

// Apps -----------------------------------------------------------------------------------------

// prefill: { name, url } for a new app found in Docker.
/** @param {AppKind} def @param {AppRow | null} svc @param {{ name: string, url: string } | null} [prefill] */
function appFormHtml(def, svc, prefill) {
  const sameKind = S.services.filter(s => s.kind === def.kind).length;
  const defaultName = prefill?.name || (!svc && sameKind ? `${def.label} ${sameKind + 1}` : def.label);
  const urlHelp = S.platform?.vm
    ? "Use the computer's network IP, or <code>host.docker.internal</code> for an app installed on this computer. Not <code>localhost</code>."
    : "Use the server's network IP, not <code>localhost</code>.";
  return `
    <form class="form grid-form" id="app-form" novalidate>
      ${def.note ? `<p class="hint wide">${esc(def.note)}</p>` : ''}
      <label class="field"><span>Name</span><input name="name" required value="${esc(svc?.name || defaultName)}" placeholder="${esc(def.label)}"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${svc?.enabled === false ? '' : 'checked'}><span>Enabled</span></label>
      <label class="field wide"><span>Address</span><input name="url" required spellcheck="false" inputmode="url"
        value="${esc(svc?.url || prefill?.url || suggestUrl(def))}" placeholder="http://192.168.1.10:${def.port || 80}">
        <small>${urlHelp}${def.port ? ` ${esc(def.label)}'s default port is ${def.port}.` : ''}</small></label>
      ${def.fields.map(f => fieldHtml(f, svc)).join('')}
      <details class="field wide more"${svc?.link ? ' open' : ''}><summary>Advanced</summary>
        <label class="field"><span>Link when clicked <em>optional</em></span><input name="link" spellcheck="false" value="${esc(svc?.link || '')}" placeholder="https://sonarr.example.com">
        <small>Where the dashboard tile opens, for example your reverse-proxy address. Defaults to the address above.</small></label>
      </details>
      <div class="test-result wide" id="test-result" hidden></div>
      ${formActions(!!svc, { del: 'del', back: 'back', test: 'test', save: 'save' }, 'Test')}
    </form>`;
}

/** @param {AppKind} def @param {{ ok: boolean, error?: string, version?: string, latency?: number, note?: string }} r */
function appTestResultHtml(def, r) {
  if (!r.ok) return `✕ ${esc(r.error)}`;
  const version = r.version ? ` — ${esc(def.label)} v${esc(String(r.version).replace(/^v/, ''))}` : '';
  const latency = r.latency != null ? ` · ${r.latency} ms` : '';
  return `✓ Connected${version}${latency}${r.note ? `<br><small>${esc(r.note)}</small>` : ''}`;
}

/** @param {AppRow | null} svc @param {Record<string, any>} body */
async function saveApp(svc, body) {
  const saved = svc
    ? await api(`/services/${encodeURIComponent(svc.id)}`, { method: 'PUT', body })
    : await api('/services', { method: 'POST', body });
  S.services = svc ? S.services.map(s => (s.id === saved.id ? saved : s)) : [...S.services, saved];
  delete appStatus[saved.id];
  modal.close();
  renderApps();
  loadStatus();
}

/** @param {AppRow} svc */
async function deleteApp(svc) {
  if (!confirm(`Remove ${svc.name} from the dashboard?`)) return;
  await api(`/services/${encodeURIComponent(svc.id)}`, { method: 'DELETE' });
  S.services = S.services.filter(s => s.id !== svc.id);
  modal.close();
  renderApps();
}

/** @param {string} kind @param {AppRow | null} [svc] @param {{ name: string, url: string } | null} [prefill] */
function openForm(kind, svc = null, prefill = null) {
  const def = kindDef(kind);
  if (!def) return;
  openModal(svc ? `Edit ${svc.name}` : `Add ${def.label}`, appFormHtml(def, svc, prefill));
  const form = $form('app-form'),
    result = $('test-result');

  const values = () => {
    const v = Object.fromEntries(new FormData(form));
    v.enabled = form.enabled.checked;
    v.kind = kind;
    if (svc) v.id = svc.id;
    return v;
  };
  /** @param {Parameters<typeof appTestResultHtml>[1]} r */
  const showResult = r => {
    result.hidden = false;
    result.className = `test-result wide ${r.ok ? 'ok' : 'bad'}`;
    result.innerHTML = appTestResultHtml(def, r);
  };
  const test = () => api('/test', { method: 'POST', body: values() }).catch(e => ({ ok: false, error: e.message }));

  $('test').addEventListener('click', async () => {
    setBusy($('test'), true, 'Test');
    showResult(await test());
    setBusy($('test'), false, 'Test');
  });

  // Like Prowlarr: test on save, and only save a failing connection if you insist.
  let forceSave = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    setBusy($('save'), true, 'Save');
    if (!forceSave && form.enabled.checked) {
      const r = await test();
      showResult(r);
      if (!r.ok) {
        forceSave = true;
        setBusy($('save'), false, 'Save anyway');
        return;
      }
    }
    try {
      await saveApp(svc, values());
    } catch (err) {
      showResult({ ok: false, error: err.message });
      setBusy($('save'), false, 'Save');
    }
  });
  form.addEventListener('input', () => {
    if (forceSave) {
      forceSave = false;
      $('save').textContent = 'Save';
    }
  });

  $('back')?.addEventListener('click', openPicker);
  $('del')?.addEventListener('click', () => svc && deleteApp(svc));
  focusFirstEmpty(form, form.url);
}

// --------------------------------------------------------------------- notifications
/** @type {Record<string, string>} */
const NOTIF_ICON = {
  discord: 'Di',
  telegram: 'Tg',
  ntfy: 'nt',
  pushover: 'Po',
  gotify: 'Go',
  email: '@',
  webhook: '{}',
};
/** @param {number} t */
const sinceText = t => {
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function renderNotifs() {
  const list = S.notifications.targets;
  $('notif-count').textContent = list.length ? `${list.length} set up` : '';
  const o = $form('notif-options'),
    n = S.notifications;
  o.diskThreshold.value = n.diskThreshold;
  o.quietEnabled.checked = n.quiet.enabled;
  o.quietFrom.value = n.quiet.from;
  o.quietTo.value = n.quiet.to;
  o.quietAllowDown.checked = n.quiet.allowDown;
  o.digestEnabled.checked = n.digest.enabled;
  o.digestTime.value = n.digest.time;
  /** @param {string} t */
  const type = t => S.notifyTypes.find(x => x.type === t);
  $('notifs').innerHTML =
    list
      .map(t => {
        const evs = S.notifyEvents.filter(e => t.events?.[e.key]).length;
        const last = t.last ? (t.last.ok ? `✓ last sent ${sinceText(t.last.at)}` : `✕ ${t.last.error}`) : '';
        return `<button type="button" class="app-card${t.enabled === false ? ' off' : ''}" data-notif="${esc(t.id)}">
      <span class="app-icon n-${esc(t.type)}" aria-hidden="true">${esc(NOTIF_ICON[t.type] || '?')}</span>
      <span class="app-name">${esc(t.name)}</span>
      <span class="app-kind">${esc(type(t.type)?.label || t.type)}${t.enabled === false ? ' · disabled' : ''}</span>
      <span class="app-url">${evs} event type${evs === 1 ? '' : 's'}</span>
      ${last ? `<span class="${t.last?.ok ? 'app-ok' : 'app-err'}">${esc(last)}</span>` : ''}
    </button>`;
      })
      .join('') +
    `<button type="button" class="app-card add" id="add-notif"><span class="plus" aria-hidden="true">+</span><span>Add notification</span></button>`;
}

$('notifs').addEventListener('click', e => {
  const card = closest(e, '.app-card');
  if (!card) return;
  if (card.id === 'add-notif') return openNotifPicker();
  const t = S.notifications.targets.find(x => x.id === card.dataset.notif);
  if (t) openNotifForm(t.type, t);
});

function openNotifPicker() {
  openModal(
    'Add notification',
    `<div class="pick-grid">${S.notifyTypes
      .map(
        t => `
    <button type="button" class="pick" data-type="${esc(t.type)}"><span class="app-icon n-${esc(t.type)}" aria-hidden="true">${esc(NOTIF_ICON[t.type])}</span>${esc(t.label)}</button>`,
      )
      .join('')}</div>`,
  );
  /** @type {NodeListOf<HTMLElement>} */ ($('modal-body').querySelectorAll('.pick')).forEach(b =>
    b.addEventListener('click', () => openNotifForm(b.dataset.type || '')),
  );
}

/** @param {NotifyType} def @param {NotifyTarget | null} target */
function notifFormHtml(def, target) {
  // The ntfy server defaults to ntfy.sh when left blank, so it's never required.
  const fields = def.fields.map(f => fieldHtml(f, target, !f.optional && f.key !== 'server')).join('');
  const events = S.notifyEvents
    .map(
      e =>
        `<label class="check"><input type="checkbox" name="ev-${esc(e.key)}" ${(target ? target.events?.[e.key] : e.def) ? 'checked' : ''}><span>${esc(e.label)}</span></label>`,
    )
    .join('');
  return `
    <form class="form grid-form" id="notif-form" novalidate>
      <label class="field"><span>Name</span><input name="name" required value="${esc(target?.name || def.label)}"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${target?.enabled === false ? '' : 'checked'}><span>Enabled</span></label>
      ${fields}
      <fieldset class="field wide events"><legend>Send me</legend>${events}</fieldset>
      <div class="test-result wide" id="notif-result" hidden></div>
      ${formActions(!!target, { del: 'ndel', back: 'nback', test: 'ntest', save: 'nsave' }, 'Send test')}
    </form>`;
}

// The form's values as the server expects them: the type's fields plus one flag per event.
/** @param {HTMLFormElement} form @param {NotifyType} def @param {NotifyTarget | null} target */
function notifValues(form, def, target) {
  const v = Object.fromEntries(new FormData(form));
  /** @type {Record<string, any>} */
  const out = { type: def.type, name: v.name, enabled: form.enabled.checked, events: {} };
  for (const f of def.fields) out[f.key] = v[f.key];
  for (const e of S.notifyEvents) out.events[e.key] = form[`ev-${e.key}`].checked;
  if (target) out.id = target.id;
  return out;
}

/** @param {NotifyTarget | null} target @param {Record<string, any>} body */
async function saveNotif(target, body) {
  const saved = target
    ? await api(`/notifications/${encodeURIComponent(target.id)}`, { method: 'PUT', body })
    : await api('/notifications', { method: 'POST', body });
  // Keep the "last sent" line: the server's reply doesn't carry it.
  S.notifications.targets = target
    ? S.notifications.targets.map(t => (t.id === saved.id ? { ...saved, last: t.last } : t))
    : [...S.notifications.targets, saved];
  modal.close();
  renderNotifs();
}

/** @param {NotifyTarget} target */
async function deleteNotif(target) {
  if (!confirm(`Delete ${target.name}?`)) return;
  await api(`/notifications/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
  S.notifications.targets = S.notifications.targets.filter(t => t.id !== target.id);
  modal.close();
  renderNotifs();
}

/** @param {string} type @param {NotifyTarget | null} [target] */
function openNotifForm(type, target = null) {
  const def = S.notifyTypes.find(t => t.type === type);
  if (!def) return;
  openModal(target ? `Edit ${target.name}` : `Add ${def.label}`, notifFormHtml(def, target));
  const form = $form('notif-form'),
    result = $('notif-result');
  const values = () => notifValues(form, def, target);
  /** @param {boolean} ok @param {string} msg */
  const show = (ok, msg) => {
    result.hidden = false;
    result.className = `test-result wide ${ok ? 'ok' : 'bad'}`;
    result.textContent = msg;
  };

  $('ntest').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    $button('ntest').disabled = true;
    try {
      const r = await api('/notifications/test', { method: 'POST', body: values() });
      show(r.ok, r.ok ? '✓ Test sent. Check your phone or channel.' : `✕ ${r.error}`);
    } catch (err) {
      show(false, `✕ ${err.message}`);
    }
    $button('ntest').disabled = false;
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    try {
      await saveNotif(target, values());
    } catch (err) {
      show(false, `✕ ${err.message}`);
    }
  });
  $('nback')?.addEventListener('click', openNotifPicker);
  $('ndel')?.addEventListener('click', () => target && deleteNotif(target));
  focusFirstEmpty(form, field(form, 'name'));
}

$('notif-options').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('notif-error'), '');
  try {
    const o = /** @type {HTMLFormElement} */ (e.target);
    const body = {
      diskThreshold: o.diskThreshold.value,
      quiet: {
        enabled: o.quietEnabled.checked,
        from: o.quietFrom.value,
        to: o.quietTo.value,
        allowDown: o.quietAllowDown.checked,
      },
      digest: { enabled: o.digestEnabled.checked, time: o.digestTime.value },
    };
    await api('/notification-options', { method: 'PUT', body });
    Object.assign(S.notifications, {
      diskThreshold: Number(body.diskThreshold),
      quiet: body.quiet,
      digest: body.digest,
    });
    flash($('notif-saved'));
  } catch (err) {
    showError($('notif-error'), err.message);
  }
});

$('digest-now').addEventListener('click', async e => {
  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
  btn.disabled = true;
  try {
    const r = await api('/digest-test', { method: 'POST', body: {} });
    const pre = $('digest-preview');
    pre.hidden = false;
    pre.textContent = `${r.preview.title}\n\n${r.preview.lines.join('\n')}\n\n${r.sent ? `✓ Sent to ${r.sent} destination${r.sent === 1 ? '' : 's'}.` : 'Not sent: no destination has “Daily digest” ticked. (This is a preview.)'}`;
  } catch (err) {
    showError($('notif-error'), err.message);
  }
  btn.disabled = false;
});

// --------------------------------------------------------------------- backup & restore
$('restore-file').addEventListener('change', async e => {
  const input = /** @type {HTMLInputElement} */ (e.currentTarget);
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  showError($('restore-error'), '');
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return showError($('restore-error'), "That file isn't valid JSON.");
  }
  const cfg = data?.config || data;
  const n = cfg?.services?.length ?? 0;
  if (
    !confirm(
      `Restore ${n} app${n === 1 ? '' : 's'} and their settings from ${file.name}?\n\nThis replaces everything currently set up here.`,
    )
  )
    return;
  try {
    const r = await api('/restore', { method: 'POST', body: data });
    $('restore-saved').textContent = `✓ Restored ${r.apps} apps`;
    flash($('restore-saved'));
    load();
  } catch (err) {
    showError($('restore-error'), err.message);
  }
});

// --------------------------------------------------------------------- diagnostics
/** @type {DiagReport | null} */
let diagReport = null;
$('diag-run').addEventListener('click', async e => {
  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
  btn.disabled = true;
  btn.textContent = 'Checking every app…';
  try {
    /** @type {DiagReport} */
    const report = await api('/diagnostics');
    diagReport = report;
    renderDiag(report);
    $('diag-copy').hidden = $('diag-download').hidden = false;
  } catch (err) {
    $('diag-results').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Run again';
});

/** @param {DiagReport} r */
function renderDiag(r) {
  const ok = r.apps.filter(a => a.ok).length;
  $('diag-results').innerHTML =
    `<p class="muted small-note">Media Ops ${esc(r.mediaOps)} · Node ${esc(r.node)} · ${esc(r.platform)} · ${ok}/${r.apps.length} apps OK</p>` +
    r.apps
      .map(
        a => `<details class="diag-app"${a.ok ? '' : ' open'}>
      <summary><span class="dot ${a.ok ? 'up' : 'down'}"></span><b>${esc(a.name)}</b>
        <span class="muted">${esc(a.kind)}${a.version ? ` · v${esc(String(a.version).replace(/^v/, ''))}` : ''} · ${a.ms} ms · ${a.calls.length} call${a.calls.length === 1 ? '' : 's'}</span>
        ${a.error ? `<span class="diag-err">✕ ${esc(a.error)}</span>` : ''}${a.note ? `<span class="muted"> · ${esc(a.note)}</span>` : ''}</summary>
      ${a.calls
        .map(
          c => `<details class="diag-call"><summary>
          <span class="mono">${esc(c.method)}</span> <span class="mono url">${esc(c.url)}</span>
          <span class="mono ${c.error || (c.status ?? 0) >= 400 ? 'diag-err' : 'muted'}">${c.status ?? '—'} · ${c.ms ?? '—'} ms${c.bytes != null ? ` · ${c.bytes.toLocaleString()} B` : ''}${c.error ? ` · ${esc(c.error)}` : ''}</span>
        </summary>${c.sample ? `<pre>${esc(c.sample)}</pre>` : ''}</details>`,
        )
        .join('')}
    </details>`,
      )
      .join('') +
    (r.recentLog.length
      ? `<details class="diag-app"><summary><b>Recent server warnings</b> <span class="muted">${r.recentLog.length}</span></summary><pre>${esc(r.recentLog.map(l => `${l.at} ${l.level.toUpperCase()} ${l.text}`).join('\n'))}</pre></details>`
      : '');
}

// The copied report is the short one, sized to paste into a chat or issue: every call's status
// and timing, but reply samples only where something went wrong. Download keeps everything.
/** @param {DiagReport} r */
const compactReport = r => ({
  ...r,
  apps: r.apps.map(a => ({
    ...a,
    calls: a.calls.map(({ sample, ...c }) =>
      c.error || (c.status ?? 0) >= 400 ? { ...c, sample: sample?.slice(0, 1200) } : c,
    ),
  })),
});
const reportText = () =>
  `Media Ops debug report\n\`\`\`json\n${diagReport ? JSON.stringify(compactReport(diagReport)) : '{}'}\n\`\`\`\n`;
$('diag-copy').addEventListener('click', async () => {
  const text = reportText();
  try {
    await navigator.clipboard.writeText(text); // only available on https:// or localhost
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash($('diag-copied'));
});
$('diag-download').addEventListener('click', () => {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(diagReport, null, 2)], { type: 'application/json' })),
    download: `media-ops-debug-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// --------------------------------------------------------------------- general
// Disk path examples for the platform Media Ops runs on (lib/platform.js). Static text only.
/** @type {Record<string, { example: string[], text: string }>} */
const PATH_TIPS = {
  unraid: {
    example: ['/mnt/user', '/mnt/cache'],
    text: 'Map <code>/mnt/user</code> (and <code>/mnt/cache</code>) into the container read-only, then list them here.',
  },
  truenas: {
    example: ['/mnt/tank'],
    text: 'Map your pool, for example <code>/mnt/tank</code>, into the container read-only, then list it here.',
  },
  synology: {
    example: ['/volume1'],
    text: 'Map <code>/volume1</code> into the container read-only, then list it here.',
  },
  qnap: {
    example: ['/share/CACHEDEV1_DATA'],
    text: 'Map your data volume, for example <code>/share/CACHEDEV1_DATA</code>, into the container read-only, then list it here.',
  },
  windows: {
    example: ['/mnt/media'],
    text: "Map a folder on each drive into the container first, for example <code>-v D:\\Media:/mnt/media:ro</code>, then enter <code>/mnt/media</code>. It shows the whole drive's free space.",
  },
  mac: {
    example: ['/mnt/media'],
    text: 'Map each drive into the container first, for example <code>-v /Volumes/Media:/mnt/media:ro</code>, then enter <code>/mnt/media</code>.',
  },
  linux: {
    example: ['/mnt/media'],
    text: 'Map each disk into the container read-only, for example <code>-v /mnt/media:/mnt/media:ro</code>, then list it here.',
  },
};
PATH_TIPS['docker-desktop'] = PATH_TIPS.mac;
PATH_TIPS.proxmox = PATH_TIPS.linux;

function renderGeneral() {
  const f = $form('general-form');
  f.refreshSeconds.value = S.general.refreshSeconds;
  f.dockerSocket.value = S.general.dockerSocket;
  f.paths.value = S.general.paths.join('\n');
  const tip = PATH_TIPS[S.platform?.id || 'linux'] || PATH_TIPS.linux;
  f.paths.placeholder = tip.example.join('\n');
  $('paths-tip').innerHTML =
    `Paths as seen inside this container. ${tip.text} The disk space your arrs report is shown too.`;
  f.uploadMbps.value = S.general.uploadMbps ?? '';
  f.mapEnabled.checked = S.general.mapEnabled;
  f.mapHome.value = S.general.mapHome;
  f.mapAsgard.checked = S.general.mapAsgard;
  f.cleanupDays.value = S.general.cleanupDays;
  f.checkUpdates.checked = S.general.checkUpdates;
}
$form('general-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  showError($('general-error'), '');
  try {
    await api('/general', {
      method: 'PUT',
      body: {
        refreshSeconds: f.refreshSeconds.value,
        dockerSocket: f.dockerSocket.value,
        paths: f.paths.value,
        mapEnabled: f.mapEnabled.checked,
        mapHome: f.mapHome.value,
        mapAsgard: f.mapAsgard.checked,
        uploadMbps: f.uploadMbps.value,
        cleanupDays: f.cleanupDays.value,
        checkUpdates: f.checkUpdates.checked,
      },
    });
    flash($('general-saved'));
  } catch (err) {
    showError($('general-error'), err.message);
  }
});

// --------------------------------------------------------------------- dashboard layout
// Rows in order, each with ↑ ↓ and a checkbox per card. Works on a copy until Save.
/** @type {{ order: string[], hidden: string[] }} */
let layoutDraft = { order: [], hidden: [] };
/** @param {{ order: string[], hidden: string[] }} layout */
function renderLayout(layout) {
  layoutDraft = { order: [...layout.order], hidden: [...layout.hidden] };
  drawLayout();
}
function drawLayout() {
  const byId = Object.fromEntries(S.layoutBlocks.map(b => [b.id, b]));
  const off = new Set(layoutDraft.hidden);
  const last = layoutDraft.order.length - 1;
  $('layout-list').innerHTML = layoutDraft.order
    .map((id, i) => {
      const cards = byId[id].cards
        .map(
          c =>
            `<label class="check"><input type="checkbox" data-card="${esc(c.id)}" ${off.has(c.id) ? '' : 'checked'}><span>${esc(c.label)}</span></label>`,
        )
        .join('');
      return `<li data-row="${esc(id)}"><span class="layout-cards">${cards}</span>
        <span class="layout-move"><button class="icon-btn" type="button" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="icon-btn" type="button" data-move="1" ${i === last ? 'disabled' : ''} aria-label="Move down">↓</button></span></li>`;
    })
    .join('');
}
$('layout-list').addEventListener('click', e => {
  const b = closest(e, '[data-move]');
  if (!b) return;
  const id = /** @type {HTMLElement} */ (b.closest('[data-row]')).dataset.row || '';
  const i = layoutDraft.order.indexOf(id);
  const j = i + Number(b.dataset.move);
  if (j < 0 || j >= layoutDraft.order.length) return;
  [layoutDraft.order[i], layoutDraft.order[j]] = [layoutDraft.order[j], layoutDraft.order[i]];
  drawLayout();
  /** @type {HTMLElement | null} */ (
    $('layout-list').querySelector(`[data-row="${CSS.escape(id)}"] [data-move="${b.dataset.move}"]`)
  )?.focus();
});
$('layout-list').addEventListener('change', e => {
  const box = closest(e, '[data-card]');
  if (!box) return;
  const set = new Set(layoutDraft.hidden);
  const card = box.dataset.card || '';
  /** @type {HTMLInputElement} */ (box).checked ? set.delete(card) : set.add(card);
  layoutDraft.hidden = [...set];
});
$('layout-reset').addEventListener('click', () => {
  renderLayout({ order: S.layoutBlocks.map(b => b.id), hidden: [] });
});
$('layout-save').addEventListener('click', async () => {
  showError($('layout-error'), '');
  try {
    S.layout = (await api('/layout', { method: 'PUT', body: layoutDraft })).layout;
    renderLayout(S.layout);
    flash($('layout-saved'));
  } catch (err) {
    showError($('layout-error'), err.message);
  }
});

// --------------------------------------------------------------------- appearance
// Theme and accent preview on this page as soon as they're picked (the server writes the saved
// ones into every page); Save keeps them.
/** @param {string} theme @param {string} accent */
function previewAppearance(theme, accent) {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (accent === 'amber') delete root.dataset.accent;
  else root.dataset.accent = accent;
}
function renderAppearance() {
  const a = S.appearance;
  const f = $form('appearance-form');
  /** @type {HTMLInputElement} */ (f.querySelector(`[name=theme][value="${a.theme}"]`)).checked = true;
  /** @type {HTMLInputElement} */ (f.querySelector(`[name=statusTheme][value="${a.statusTheme}"]`)).checked = true;
  field(f, 'title').value = a.title;
  f.liveStrip.checked = a.liveStrip;
  $('accent-swatches').innerHTML = S.accents
    .map(
      x =>
        `<label class="swatch" title="${esc(x.label)}"><input type="radio" name="accent" value="${esc(x.id)}" ${x.id === a.accent ? 'checked' : ''}><i style="--sw-dark:${esc(x.dark)};--sw-light:${esc(x.light)}" aria-hidden="true"></i><span>${esc(x.label)}</span></label>`,
    )
    .join('');
  renderLogo();
}
function renderLogo() {
  const logo = S.appearance.logo;
  $('logo-preview').innerHTML = logo ? `<img src="/branding/logo?v=${esc(logo.hash)}" alt="Current logo">` : '';
  $('logo-remove').hidden = !logo;
  // The header logo here too.
  const head = document.querySelector('header.top .logo');
  if (head) {
    const next = logo
      ? Object.assign(document.createElement('img'), {
          className: 'logo custom',
          alt: '',
          src: `/branding/logo?v=${logo.hash}`,
        })
      : Object.assign(document.createElement('span'), { className: 'logo' });
    if (!logo) next.setAttribute('aria-hidden', 'true');
    head.replaceWith(next);
  }
}
$form('appearance-form').addEventListener('change', e => {
  const changed = /** @type {HTMLInputElement} */ (e.target).name;
  if (changed === 'theme' || changed === 'accent') {
    const f = $form('appearance-form');
    previewAppearance(f.theme.value, f.accent.value);
  }
});
$form('appearance-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  showError($('appearance-error'), '');
  try {
    const r = await api('/appearance', {
      method: 'PUT',
      body: {
        theme: f.theme.value,
        accent: f.accent.value,
        title: field(f, 'title').value,
        statusTheme: f.statusTheme.value,
        liveStrip: f.liveStrip.checked,
      },
    });
    S.appearance = r.appearance;
    /** @type {HTMLElement} */ (document.querySelector('header.top .sub')).textContent =
      S.appearance.title || 'Media Ops';
    flash($('appearance-saved'));
  } catch (err) {
    showError($('appearance-error'), err.message);
  }
});
$('logo-file').addEventListener('change', async e => {
  const input = /** @type {HTMLInputElement} */ (e.currentTarget);
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  showError($('appearance-error'), '');
  if (file.size > 256 * 1024) return showError($('appearance-error'), 'The logo must be 256 KB or smaller');
  try {
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error("Couldn't read that file"));
      r.readAsDataURL(file);
    });
    S.appearance = (await api('/logo', { method: 'PUT', body: { data } })).appearance;
    renderLogo();
  } catch (err) {
    showError($('appearance-error'), err.message);
  }
});
$('logo-remove').addEventListener('click', async () => {
  try {
    S.appearance = (await api('/logo', { method: 'DELETE' })).appearance;
    renderLogo();
  } catch (err) {
    showError($('appearance-error'), err.message);
  }
});

// --------------------------------------------------------------------- Prometheus metrics
// The token is only in the reply that creates it, so it's shown once, right then.
/** @param {string | null} token shown once, right after it's made */
function renderMetrics(token) {
  const m = S.metrics;
  const f = $form('metrics-form');
  f.enabled.checked = m.enabled;
  $('metrics-regen').hidden = !m.tokenSet;
  const row = $('metrics-token-row');
  if (token) {
    row.innerHTML = `<span>Token <em>copy it now: it won't be shown again</em></span>
      <div class="logo-row"><input id="metrics-token" readonly spellcheck="false"><button class="btn small" type="button" id="metrics-copy">Copy</button></div>`;
    $input('metrics-token').value = token;
    $('metrics-copy').addEventListener('click', async () => {
      $input('metrics-token').select();
      try {
        await navigator.clipboard.writeText(token);
        $('metrics-copy').textContent = 'Copied';
      } catch {
        /* not https: the text is selected, so Ctrl+C works */
      }
    });
  } else {
    row.innerHTML = m.tokenSet
      ? '<small>A token is set. Lost it? Make a new one; the old one stops working.</small>'
      : '<small>Saving with this on creates the token Prometheus needs.</small>';
  }
  $('metrics-example').textContent = `scrape_configs:
  - job_name: media-ops
    metrics_path: /metrics
    authorization:
      credentials: ${token || '<the token>'}
    static_configs:
      - targets: ['${location.host}']`;
}
$form('metrics-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('metrics-error'), '');
  try {
    const r = await api('/metrics', { method: 'PUT', body: { enabled: $form('metrics-form').enabled.checked } });
    S.metrics = r.metrics;
    renderMetrics(r.token);
    flash($('metrics-saved'));
  } catch (err) {
    showError($('metrics-error'), err.message);
  }
});
$('metrics-regen').addEventListener('click', async () => {
  if (!confirm('Make a new token? Prometheus stops getting data until you give it the new one.')) return;
  try {
    const r = await api('/metrics/token', { method: 'POST' });
    S.metrics = r.metrics;
    renderMetrics(r.token);
  } catch (err) {
    showError($('metrics-error'), err.message);
  }
});

// --------------------------------------------------------------------- stuck downloads
function renderAutoFix() {
  const f = $form('autofix-form');
  f.enabled.checked = S.autoFix.enabled;
  f.minutes.value = S.autoFix.minutes;
  const list = S.autoFix.recent || [];
  $('autofix-recent').innerHTML = list.length
    ? `<h3 class="sub-h">Recent fixes</h3><ul class="fix-log">${list
        .map(
          x =>
            `<li class="${x.ok ? '' : 'bad'}"><span class="muted">${esc(new Date(x.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span> <b>${esc(x.app)}</b> ${x.ok ? 'replaced' : 'could not replace'} ${esc(x.title)}<span class="muted"> · ${esc(x.ok ? x.reason : x.error)}</span></li>`,
        )
        .join('')}</ul>`
    : '';
}
$form('autofix-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  showError($('autofix-error'), '');
  try {
    S.autoFix = (
      await api('/auto-fix', { method: 'PUT', body: { enabled: f.enabled.checked, minutes: f.minutes.value } })
    ).autoFix;
    renderAutoFix();
    flash($('autofix-saved'));
  } catch (err) {
    showError($('autofix-error'), err.message);
  }
});

// --------------------------------------------------------------------- public status page
function renderStatusPage() {
  const f = $form('status-form');
  const sp = S.statusPage;
  f.enabled.checked = sp.enabled;
  field(f, 'title').value = sp.title;
  f.notice.value = sp.notice;
  const chosen = new Set(sp.services);
  setStatusLink(sp.enabled);
  $('status-apps').innerHTML =
    '<legend>Apps to show</legend>' +
    (S.services.length
      ? S.services
          .map(
            s =>
              `<label class="check"><input type="checkbox" name="svc" value="${esc(s.id)}" ${chosen.has(s.id) ? 'checked' : ''}><span>${esc(s.name)}</span></label>`,
          )
          .join('')
      : '<p class="hint">Add your apps first.</p>');
}
/** @param {boolean} on */
function setStatusLink(on) {
  const link = `${location.origin}/status`;
  $('status-link').innerHTML = on
    ? `Share this link: <a href="/status" target="_blank" rel="noopener">${esc(link)}</a>`
    : 'Off: /status answers "not found".';
}
$form('status-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  showError($('status-error'), '');
  try {
    const r = await api('/status-page', {
      method: 'PUT',
      body: {
        enabled: f.enabled.checked,
        title: field(f, 'title').value,
        notice: f.notice.value,
        services: [
          .../** @type {NodeListOf<HTMLInputElement>} */ (f.querySelectorAll('input[name="svc"]:checked')),
        ].map(i => i.value),
      },
    });
    S.statusPage = r.statusPage;
    setStatusLink(r.statusPage.enabled);
    flash($('status-saved'));
  } catch (err) {
    showError($('status-error'), err.message);
  }
});

// --------------------------------------------------------------------- security
function renderSecurity() {
  const on = S.authEnabled;
  $('pw-status').innerHTML = on
    ? '🔒 Settings are protected by a password. The dashboard itself stays viewable by anyone on your network. If you forget it, use "Forgot password?" on the login screen; it gives you a reset code via the container log.'
    : 'Anyone who can open this page can change your apps and keys. Set a password to lock Settings. The dashboard stays viewable without it.';
  $('pw-current-wrap').hidden = !on;
  $('pw-remove').hidden = !on;
  $('pw-next-label').textContent = on ? 'New password' : 'Password';
  $('pw-submit').textContent = on ? 'Change password' : 'Set password';
  $input('dash-lock').checked = S.dashboardAuth;
  $input('dash-lock').disabled = !on;
  $('dash-lock-wrap').title = on ? '' : 'Set a password first';
}
/** @param {string} next */
async function setPassword(next) {
  const f = $form('pw-form');
  showError($('pw-error'), '');
  try {
    const r = await api('/password', { method: 'PUT', body: { current: f.current.value, next } });
    S.authEnabled = r.authEnabled;
    if (!r.authEnabled) S.dashboardAuth = false;
    f.reset();
    renderSecurity();
    $('logout').hidden = !S.authEnabled;
    flash($('pw-saved'));
  } catch (err) {
    showError($('pw-error'), err.message);
  }
}
$form('pw-form').addEventListener('submit', e => {
  e.preventDefault();
  const next = $form('pw-form').next.value;
  if (next.length < 8) return showError($('pw-error'), 'Use at least 8 characters');
  setPassword(next);
});
$('dash-lock').addEventListener('change', async e => {
  const box = /** @type {HTMLInputElement} */ (e.currentTarget);
  showError($('pw-error'), '');
  try {
    await api('/security', { method: 'PUT', body: { dashboardAuth: box.checked } });
    S.dashboardAuth = box.checked;
    flash($('pw-saved'));
  } catch (err) {
    box.checked = !box.checked;
    showError($('pw-error'), err.message);
  }
});
$('pw-remove').addEventListener('click', () => {
  if (confirm('Remove the settings password? Anyone on your network will be able to change settings.')) setPassword('');
});

load();
