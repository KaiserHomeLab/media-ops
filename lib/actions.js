// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Actions the dashboard can run inside an app: clear its log, or re-run its health checks.
const { join, req } = require('./http');

const ARR_API = { sonarr: 'v3', radarr: 'v3', lidarr: 'v1', readarr: 'v1', prowlarr: 'v1' };
const FINISHED_BAD = ['failed', 'aborted', 'cancelled', 'orphaned'];
// IDs from the browser go into an app's URL: whole numbers only ("", "-1" or "1e21" aren't).
const isId = v => /^\d{1,12}$/.test(String(v ?? ''));

// What each app supports, with the exact wording shown in the confirm dialog.
function capabilities(kind, name) {
  if (ARR_API[kind])
    return {
      clear: `This empties System → Logs in ${name}. Log files on disk are kept. This can't be undone.`,
      recheck: 'health',
    };
  if (kind === 'sabnzbd')
    return {
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
    if (!isId(cmd?.id)) return 'running';
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
    return r === 'done'
      ? `${svc.name} re-ran its health checks`
      : `${svc.name} is still checking — results will appear shortly`;
  }
  return `Re-checked ${svc.name}`;
}

// Stop a Plex stream; the viewer sees `reason` on screen. (Plex Pass feature on the server.)
async function stopStream(svc, sessionId, reason) {
  if (svc.kind !== 'plex') throw Object.assign(new Error('Only Plex streams can be stopped'), { status: 400 });
  if (!sessionId || !/^[\w-]{1,128}$/.test(String(sessionId)))
    throw Object.assign(new Error('This stream has no valid session id'), { status: 400 });
  const msg =
    String(reason || '')
      .trim()
      .slice(0, 200) || 'The server owner stopped this stream.';
  await req(
    join(
      svc.url,
      `/status/sessions/terminate?sessionId=${encodeURIComponent(sessionId)}&reason=${encodeURIComponent(msg)}`,
    ),
    { headers: { 'X-Plex-Token': svc.token }, as: 'text' },
  );
  return 'Stream stopped';
}

// Stuck download in an *arr queue: re-check it (same as the refresh button on the Queue page)...
async function queueRetry(svc) {
  if (!ARR_API[svc.kind]) throw Object.assign(new Error(`${svc.name} has no download queue`), { status: 400 });
  await arrCommand(svc, 'RefreshMonitoredDownloads');
  return `${svc.name} re-checked its downloads`;
}

// ...or give up on this release: remove it from the downloader, blocklist it, and search again.
async function queueRemove(svc, queueId) {
  if (!ARR_API[svc.kind]) throw Object.assign(new Error(`${svc.name} has no download queue`), { status: 400 });
  if (!isId(queueId)) throw Object.assign(new Error('Bad queue item'), { status: 400 });
  const q = 'removeFromClient=true&blocklist=true&skipRedownload=false';
  await req(join(svc.url, `/api/${ARR_API[svc.kind]}/queue/${Number(queueId)}?${q}`), {
    method: 'DELETE',
    headers: { 'X-Api-Key': svc.apiKey },
    as: 'text',
  });
  return `Removed and blocklisted; ${svc.name} is searching for another release`;
}

// Approve or decline a Seerr/Overseerr/Jellyseerr request (needs a key with Manage Requests;
// the main key under Settings → General has it).
async function seerrRequest(svc, requestId, decision) {
  if (!['seerr', 'overseerr', 'jellyseerr'].includes(svc.kind))
    throw Object.assign(new Error('Not a requests app'), { status: 400 });
  if (!['approve', 'decline'].includes(decision) || !isId(requestId))
    throw Object.assign(new Error('Bad request'), { status: 400 });
  await req(join(svc.url, `/api/v1/request/${Number(requestId)}/${decision}`), {
    method: 'POST',
    headers: { 'X-Api-Key': svc.apiKey },
  });
  return decision === 'approve' ? 'Request approved' : 'Request declined';
}

module.exports = { capabilities, clear, recheck, stopStream, queueRetry, queueRemove, seerrRequest };
