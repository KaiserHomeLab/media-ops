// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Settings page: add, edit, reorder and test apps; general options; the settings password
// and its reset flow. Talks to /api/settings/*. Saved API keys never come back from the
// server; the form only learns whether one is saved.
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = null;          // settings payload from the server
let status = {};       // service id -> { up, error, version }
const modal = $('modal');

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/settings${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.needLogin) { showLogin(); throw new Error(data.error); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function showError(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}
function flash(el) {
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2500);
}

// --------------------------------------------------------------------- load
async function load() {
  try {
    S = await api('');
  } catch { return; }
  $('login').hidden = true;
  $('settings-body').hidden = false;
  $('logout').hidden = !S.authEnabled;
  $('demo-banner').hidden = !S.demo;
  $('config-file').textContent = S.configFile;
  renderApps();
  renderGeneral();
  renderSecurity();
  loadStatus();
}

async function loadStatus() {
  if (S.demo || !S.services.length) return;
  try {
    const o = await (await fetch('/api/overview')).json();
    status = Object.fromEntries(o.services.map(s => [s.id, s]));
    renderApps();
  } catch { /* the cards just show without a status dot */ }
}

function showLogin() {
  $('settings-body').hidden = true;
  $('login').hidden = false;
  $('login-form').password.focus();
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  showError($('login-error'), '');
  try {
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    load();
  } catch (err) { showError($('login-error'), err.message); }
});
// Forgot password: one-time code from the server's log / config folder.
const showReset = on => {
  $('login-form').hidden = on;
  $('reset-form').hidden = !on;
  $('login').querySelector('h2').textContent = on ? 'Reset settings password' : 'Settings are locked';
  if (on) $('send-code').focus();
};
$('forgot').addEventListener('click', () => showReset(true));
$('back-to-login').addEventListener('click', () => showReset(false));
$('send-code').addEventListener('click', async e => {
  showError($('reset-error'), '');
  e.target.disabled = true;
  try {
    const r = await api('/forgot', { method: 'POST', body: {} });
    $('reset-file').textContent = r.file;
    $('reset-where').hidden = false;
    e.target.textContent = 'Send a new code';
    $('reset-form').code.focus();
  } catch (err) { showError($('reset-error'), err.message); }
  setTimeout(() => (e.target.disabled = false), 30000); // server allows one new code per 30 s
});
$('reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  showError($('reset-error'), '');
  try {
    await api('/reset', { method: 'POST', body: { code: f.code.value, next: f.next.value } });
    f.reset();
    showReset(false);
    load();
  } catch (err) { showError($('reset-error'), err.message); }
});

$('logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }); location.reload(); });

// --------------------------------------------------------------------- apps grid
const kindDef = kind => S.kinds.find(k => k.kind === kind) || S.kinds.find(k => k.kind === 'seerr');
const abbrev = name => esc(name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?');

function renderApps() {
  $('apps-count').textContent = S.services.length ? `${S.services.length} connected` : '';
  const cards = S.services.map(s => {
    const st = status[s.id];
    const dot = s.enabled === false ? '' : st ? `<span class="dot ${st.up ? 'up' : 'down'}" title="${esc(st.up ? 'Connected' : st.error)}"></span>` : '';
    return `<button type="button" class="app-card${s.enabled === false ? ' off' : ''}" draggable="true" data-id="${esc(s.id)}">
      <span class="app-icon k-${esc(s.kind)}" aria-hidden="true">${abbrev(kindDef(s.kind).label)}</span>
      <span class="app-name">${esc(s.name)} ${dot}</span>
      <span class="app-kind">${esc(kindDef(s.kind).label)}${s.enabled === false ? ' · disabled' : ''}</span>
      <span class="app-url">${esc(s.url)}</span>
      ${st && !st.up && s.enabled !== false ? `<span class="app-err">✕ ${esc(st.error)}</span>` : ''}
    </button>`;
  });
  cards.push(`<button type="button" class="app-card add" id="add-app"><span class="plus" aria-hidden="true">+</span><span>Add app</span></button>`);
  $('apps').innerHTML = cards.join('');
}

$('apps').addEventListener('click', e => {
  const card = e.target.closest('.app-card');
  if (!card) return;
  if (card.id === 'add-app') return openPicker();
  const svc = S.services.find(s => s.id === card.dataset.id);
  if (svc) openForm(svc.kind, svc);
});

// Drag to reorder
let dragId = null;
$('apps').addEventListener('dragstart', e => {
  const c = e.target.closest('.app-card[data-id]');
  if (!c) return;
  dragId = c.dataset.id;
  c.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
$('apps').addEventListener('dragover', e => {
  const over = e.target.closest('.app-card[data-id]');
  if (!dragId || !over || over.dataset.id === dragId) return;
  e.preventDefault();
  const dragged = $('apps').querySelector(`[data-id="${CSS.escape(dragId)}"]`);
  const r = over.getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2;
  over.parentNode.insertBefore(dragged, after ? over.nextSibling : over);
});
$('apps').addEventListener('dragend', async () => {
  if (!dragId) return;
  dragId = null;
  const ids = [...$('apps').querySelectorAll('.app-card[data-id]')].map(c => c.dataset.id);
  S.services.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  renderApps();
  await api('/order', { method: 'PUT', body: { ids } }).catch(err => alert(err.message));
});

// --------------------------------------------------------------------- modal: picker
function openModal(title, html) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  if (!modal.open) modal.showModal();
}
modal.addEventListener('click', e => {
  if (e.target === modal || e.target.closest('[data-close]')) modal.close();
});

function openPicker() {
  const groups = [...new Set(S.kinds.map(k => k.group))];
  openModal('Add app', groups.map(g => `
    <h3 class="pick-group">${esc(g)}</h3>
    <div class="pick-grid">${S.kinds.filter(k => k.group === g).map(k => `
      <button type="button" class="pick" data-kind="${esc(k.kind)}">
        <span class="app-icon k-${esc(k.kind)}" aria-hidden="true">${abbrev(k.label)}</span>${esc(k.label)}
      </button>`).join('')}
    </div>`).join(''));
  $('modal-body').querySelectorAll('.pick').forEach(b => b.addEventListener('click', () => openForm(b.dataset.kind)));
}

// --------------------------------------------------------------------- modal: add / edit form
function suggestUrl(def) {
  // Most people run everything on one box, so reuse the host of an app already added (or this page's host).
  let host = location.hostname;
  const first = S.services[0];
  if (first) try { host = new URL(first.url).hostname; } catch {}
  return def.port ? `http://${host}:${def.port}` : `http://${host}`;
}

function openForm(kind, svc = null) {
  const def = kindDef(kind);
  const sameKind = S.services.filter(s => s.kind === kind).length;
  const defaultName = !svc && sameKind ? `${def.label} ${sameKind + 1}` : def.label;

  const fieldHtml = def.fields.map(f => {
    const saved = svc?.[`${f.key}Saved`];
    const ph = f.type === 'secret' && saved ? '•••••••••••• saved — leave blank to keep' : '';
    return `<label class="field wide"><span>${esc(f.label)}${f.optional ? ' <em>optional</em>' : ''}</span>
      <input name="${esc(f.key)}" type="${f.type === 'secret' ? 'password' : 'text'}" autocomplete="off" spellcheck="false"
        placeholder="${esc(ph)}" value="${f.type === 'secret' ? '' : esc(svc?.[f.key] || '')}"
        ${!f.optional && !saved ? 'required' : ''}>
      ${f.help ? `<small>${esc(f.help)}${f.link ? ` <a href="${esc(f.link)}" target="_blank" rel="noopener">How?</a>` : ''}</small>` : ''}
    </label>`;
  }).join('');

  openModal(svc ? `Edit ${svc.name}` : `Add ${def.label}`, `
    <form class="form grid-form" id="app-form" novalidate>
      ${def.note ? `<p class="hint wide">${esc(def.note)}</p>` : ''}
      <label class="field"><span>Name</span><input name="name" required value="${esc(svc?.name || defaultName)}" placeholder="${esc(def.label)}"></label>
      <label class="field toggle"><input type="checkbox" name="enabled" ${svc?.enabled === false ? '' : 'checked'}><span>Enabled</span></label>
      <label class="field wide"><span>Address</span><input name="url" required spellcheck="false" inputmode="url"
        value="${esc(svc?.url || suggestUrl(def))}" placeholder="http://192.168.1.10:${def.port || 80}">
        <small>Use the server's network IP, not <code>localhost</code>.${def.port ? ` ${esc(def.label)}'s default port is ${def.port}.` : ''}</small></label>
      ${fieldHtml}
      <details class="field wide more"${svc?.link ? ' open' : ''}><summary>Advanced</summary>
        <label class="field"><span>Link when clicked <em>optional</em></span><input name="link" spellcheck="false" value="${esc(svc?.link || '')}" placeholder="https://sonarr.example.com">
        <small>Where the dashboard tile opens, for example your reverse-proxy address. Defaults to the address above.</small></label>
      </details>
      <div class="test-result wide" id="test-result" hidden></div>
      <div class="actions wide">
        ${svc ? '<button class="btn danger ghost" type="button" id="del">Delete</button>' : '<button class="btn ghost" type="button" id="back">← Back</button>'}
        <span class="spacer"></span>
        <button class="btn" type="button" id="test">Test</button>
        <button class="btn primary" type="submit" id="save">Save</button>
      </div>
    </form>`);

  const form = $('app-form');
  const result = $('test-result');
  const values = () => {
    const v = Object.fromEntries(new FormData(form));
    v.enabled = form.enabled.checked;
    v.kind = kind;
    if (svc) v.id = svc.id;
    return v;
  };
  const setBusy = (btn, busy, label) => { btn.disabled = busy; btn.textContent = busy ? '…' : label; };
  const showResult = r => {
    result.hidden = false;
    result.className = `test-result wide ${r.ok ? 'ok' : 'bad'}`;
    result.innerHTML = r.ok
      ? `✓ Connected${r.version ? ` — ${esc(def.label)} v${esc(String(r.version).replace(/^v/, ''))}` : ''}${r.latency != null ? ` · ${r.latency} ms` : ''}${r.note ? `<br><small>${esc(r.note)}</small>` : ''}`
      : `✕ ${esc(r.error)}`;
  };
  const test = async () => {
    try { return await api('/test', { method: 'POST', body: values() }); }
    catch (e) { return { ok: false, error: e.message }; }
  };

  $('test').addEventListener('click', async () => {
    setBusy($('test'), true, 'Test');
    showResult(await test());
    setBusy($('test'), false, 'Test');
  });

  let forceSave = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    setBusy($('save'), true, 'Save');
    // Like Prowlarr: test on save, and only save a failing connection if you insist.
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
      const body = values();
      const saved = svc
        ? await api(`/services/${encodeURIComponent(svc.id)}`, { method: 'PUT', body })
        : await api('/services', { method: 'POST', body });
      S.services = svc ? S.services.map(s => (s.id === saved.id ? saved : s)) : [...S.services, saved];
      delete status[saved.id];
      modal.close();
      renderApps();
      loadStatus();
    } catch (err) {
      showResult({ ok: false, error: err.message });
      setBusy($('save'), false, 'Save');
    }
  });
  form.addEventListener('input', () => { if (forceSave) { forceSave = false; $('save').textContent = 'Save'; } });

  $('back')?.addEventListener('click', openPicker);
  $('del')?.addEventListener('click', async () => {
    if (!confirm(`Remove ${svc.name} from the dashboard?`)) return;
    await api(`/services/${encodeURIComponent(svc.id)}`, { method: 'DELETE' });
    S.services = S.services.filter(s => s.id !== svc.id);
    modal.close();
    renderApps();
  });

  ([...form.querySelectorAll('input[required]')].find(i => !i.value) || form.url).focus();
}

// --------------------------------------------------------------------- general
function renderGeneral() {
  const f = $('general-form');
  f.refreshSeconds.value = S.general.refreshSeconds;
  f.dockerSocket.value = S.general.dockerSocket;
  f.paths.value = S.general.paths.join('\n');
}
$('general-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  showError($('general-error'), '');
  try {
    await api('/general', { method: 'PUT', body: { refreshSeconds: f.refreshSeconds.value, dockerSocket: f.dockerSocket.value, paths: f.paths.value } });
    flash($('general-saved'));
  } catch (err) { showError($('general-error'), err.message); }
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
}
async function setPassword(next) {
  const f = $('pw-form');
  showError($('pw-error'), '');
  try {
    const r = await api('/password', { method: 'PUT', body: { current: f.current.value, next } });
    S.authEnabled = r.authEnabled;
    f.reset();
    renderSecurity();
    $('logout').hidden = !S.authEnabled;
    flash($('pw-saved'));
  } catch (err) { showError($('pw-error'), err.message); }
}
$('pw-form').addEventListener('submit', e => {
  e.preventDefault();
  const next = e.target.next.value;
  if (next.length < 8) return showError($('pw-error'), 'Use at least 8 characters');
  setPassword(next);
});
$('pw-remove').addEventListener('click', () => {
  if (confirm('Remove the settings password? Anyone on your network will be able to change settings.')) setPassword('');
});

load();
