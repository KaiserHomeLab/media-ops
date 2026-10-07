// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Actions the dashboard can run inside an app: clear its log, or re-run its health checks.
const { join, req } = require('./http');

const ARR_API = { sonarr: 'v3', radarr: 'v3', lidarr: 'v1', readarr: 'v1', prowlarr: 'v1' };
const FINISHED_BAD = ['failed', 'aborted', 'cancelled', 'orphaned'];

// What each app supports, with the exact wording shown in the confirm dialog.
function capabilities(kind, name) {
  if (ARR_API[kind]) return {
    clear: `This empties System → Logs in ${name}. Log files on disk are kept. This can't be undone.`,
    recheck: 'health',
  };
  if (kind === 'sabnzbd') return {
    clear: `This clears ${name}'s warnings and removes failed downloads from its history. Downloaded files are kept. This can't be undone.`,
    recheck: 'poll',
  };
  return { clear: null, recheck: 'poll' };
}

// Run an *arr command (same as the buttons in its UI) and wait for it to finish.
async function arrCommand(svc, name) {
  const base = join(svc.url, `/api/${ARR_API[svc.kind]}/command`);
  const headers = { 'X-Api-Key': svc.apiKey, 'Content-Type': 'application/json' };
  const cmd = await req(base, { method: 'POST', headers, body: JSON.stringify({ name }) });
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const c = await req(`${base}/${cmd.id}`, { headers });
    if (c.status === 'completed') return 'done';
    if (FINISHED_BAD.includes(c.status)) throw new Error(`${name} ${c.status}${c.message ? `: ${c.message}` : ''}`);
    await new Promise(r => setTimeout(r, 750));
  }
  return 'running'; // still going in the app; the next refresh will pick up the result
}

async function clear(svc) {
  if (ARR_API[svc.kind]) {
    await arrCommand(svc, 'ClearLog');
    return `Cleared ${svc.name}'s log`;
  }
  if (svc.kind === 'sabnzbd') {
    const api = q => req(join(svc.url, `/api?output=json&apikey=${encodeURIComponent(svc.apiKey)}&${q}`));
    await api('mode=warnings&name=clear');
    await api('mode=history&name=delete&value=failed&del_files=0');
    return `Cleared ${svc.name}'s warnings and failed history`;
  }
  throw Object.assign(new Error(`${svc.name} has no API for clearing its log — use Dismiss instead`), { status: 400 });
}

async function recheck(svc) {
  if (ARR_API[svc.kind]) {
    const r = await arrCommand(svc, 'CheckHealth');
    return r === 'done' ? `${svc.name} re-ran its health checks` : `${svc.name} is still checking — results will appear shortly`;
  }
  return `Re-checked ${svc.name}`;
}

module.exports = { capabilities, clear, recheck };
