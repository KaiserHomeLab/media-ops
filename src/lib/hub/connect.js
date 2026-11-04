// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub: helping an app reach Media Ops, for Settings → Notification Hub → Connect apps.
//   suggest(): how the app should reach Media Ops. A plain name in the app's saved address
//     (http://radarr:7878) means a Docker network, where Media Ops is http://<its container>:<port
//     inside the container>. With the Docker container list (lib/host.js), it also checks the two
//     really share a network, and finds Media Ops' own container name.
//   setUp(): "Set it up for me": adds the webhook to Sonarr/Radarr (a "Media Ops" Connect entry,
//     updated if it's there) or Seerr (its one webhook; asks before replacing someone else's),
//     then has the app send a test. Only ever when the person presses the button.
'use strict';
const { join, req } = require('../http');

// ------------------------------------------------------------------ how the app reaches Media Ops
// A name Docker's DNS would answer (radarr, sonarr-anime), not an IP, a domain or localhost.
/** @param {string} host */
const looksDocker = host =>
  /^[a-z0-9][a-z0-9_-]*$/i.test(host) && !/^\d+$/.test(host) && host.toLowerCase() !== 'localhost';

/** @param {any} c a container from Docker's list */
const nameOf = c => String(c?.Names?.[0] || '').replace(/^\//, '');
// Networks a container can look others up by name on. Docker's default "bridge" network has no
// name lookup, and "host"/"none" aren't networks to share.
/** @param {any} c */
const netsOf = c =>
  Object.keys(c?.NetworkSettings?.Networks || {}).filter(n => !['bridge', 'host', 'none'].includes(n));

/**
 * @param {{ service?: { name: string, url: string } | null, containers?: any[] | null, hostname: string, port: number }} o
 * @returns {{ app: { name: string, url: string, host: string, looksDocker: boolean } | null, docker: boolean,
 *   self: string | null, appContainer: string | null, shared: string[], recommend: 'docker' | 'host',
 *   dockerBase: string, warning: string | null, note: string | null }}
 */
function suggest({ service, containers, hostname, port }) {
  let host = '';
  try {
    host = service ? new URL(service.url).hostname : '';
  } catch {
    /* a saved address that doesn't parse: no guess from it */
  }
  const app = service ? { name: service.name, url: service.url, host, looksDocker: looksDocker(host) } : null;
  const list = Array.isArray(containers) ? containers : null;
  // Docker sets a container's hostname to the start of its id, unless the compose file sets one.
  const self =
    list?.find(c => hostname && String(c.Id || '').startsWith(hostname)) ||
    list?.find(c => nameOf(c) === hostname) ||
    null;
  const appC =
    list && host
      ? list.find(c => (c.Names || []).some((/** @type {string} */ n) => n.replace(/^\//, '') === host)) || null
      : null;
  const shared = self && appC ? netsOf(self).filter(n => netsOf(appC).includes(n)) : [];
  const selfName = self ? nameOf(self) : null;
  const dockerBase = `http://${selfName || 'media-ops'}:${port}`;

  /** @type {'docker' | 'host'} */
  let recommend = 'host';
  let warning = null;
  let note = null;
  if (self && Object.keys(self.NetworkSettings?.Networks || {}).includes('host')) {
    note = 'Media Ops uses the host network, so apps reach it at this computer’s address.';
  } else if (shared.length) {
    recommend = 'docker';
    note = `${app?.name || 'The app'} and Media Ops share the Docker network “${shared[0]}”.`;
  } else if (self && appC) {
    warning = `${app?.name || 'The app'} and Media Ops aren’t on the same Docker network, so ${app?.name || 'it'} can’t find Media Ops by name. Use this computer’s address, or put both on one network: docker network connect ${netsOf(appC)[0] || '<network>'} ${selfName}`;
  } else if (app?.looksDocker) {
    recommend = 'docker';
    note = `${app.name} is at ${app.url} under Apps, so it runs in Docker; on the same network it finds Media Ops by name.`;
  }
  return {
    app,
    docker: !!list,
    self: selfName,
    appContainer: appC ? nameOf(appC) : null,
    shared,
    recommend,
    dockerBase,
    warning,
    note,
  };
}

// ------------------------------------------------------------------ "Set it up for me"
// The app's reply, read even when it's an error: Sonarr and Radarr say why a webhook failed its
// test ("Unable to send test message"), which is the most useful thing to show.
/** @param {string} url @param {{ method?: string, apiKey: string, body?: unknown }} o */
async function call(url, { method = 'GET', apiKey, body }) {
  /** @type {Response} */
  const res = await req(url, {
    method,
    as: 'response',
    timeout: 20000,
    headers: { 'X-Api-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => '');
  /** @type {any} */
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, data };
}
// What an app said went wrong, in a line: Sonarr/Radarr send [{ errorMessage }], Seerr { message }.
/** @param {any} data @param {number} status */
const why = (data, status) =>
  String(
    (Array.isArray(data)
      ? data
          .map(e => e?.errorMessage)
          .filter(Boolean)
          .join(' ')
      : data?.message || data?.title) || `HTTP ${status}`,
  ).slice(0, 300);

const NAME = 'Media Ops';
// Sonarr and Radarr name some events differently; each ignores the other's names.
const ARR_EVENTS = {
  onGrab: false,
  onDownload: true, // "On Import"
  onUpgrade: true,
  onImportComplete: false,
  onRename: false,
  onSeriesAdd: false,
  onMovieAdded: false,
  onSeriesDelete: true,
  onMovieDelete: true,
  onEpisodeFileDelete: true,
  onMovieFileDelete: true,
  onEpisodeFileDeleteForUpgrade: false, // an upgrade replacing a file isn't a removal
  onMovieFileDeleteForUpgrade: false,
  onHealthIssue: true,
  includeHealthWarnings: true,
  onHealthRestored: true,
  onApplicationUpdate: false,
  onManualInteractionRequired: true,
};

/** @param {{ name: string, url: string, apiKey?: string }} svc @param {string} hookUrl */
async function setUpArr(svc, hookUrl) {
  /** @param {string} p */
  const at = p => join(svc.url, `/api/v3${p}`);
  const apiKey = svc.apiKey || '';
  const list = await call(at('/notification'), { apiKey });
  if (!list.ok) throw new Error(`${svc.name} didn't answer: ${why(list.data, list.status)}`);
  const existing = (Array.isArray(list.data) ? list.data : []).find(
    n => n?.name === NAME && n?.implementation === 'Webhook',
  );
  const fields = existing?.fields?.length
    ? existing.fields.map((/** @type {any} */ f) =>
        f.name === 'url' ? { ...f, value: hookUrl } : f.name === 'method' ? { ...f, value: 1 } : f,
      )
    : [
        { name: 'url', value: hookUrl },
        { name: 'method', value: 1 }, // POST
      ];
  const body = {
    ...(existing || {}),
    name: NAME,
    implementation: 'Webhook',
    implementationName: 'Webhook',
    configContract: 'WebhookSettings',
    tags: existing?.tags || [],
    ...ARR_EVENTS,
    fields,
  };
  // The test first: it's where a wrong address shows up, before anything is saved.
  const test = await call(at('/notification/test'), { method: 'POST', apiKey, body });
  if (!test.ok) throw new Error(`${svc.name} couldn't reach Media Ops at that address: ${why(test.data, test.status)}`);
  const saved = existing
    ? await call(at(`/notification/${existing.id}`), { method: 'PUT', apiKey, body })
    : await call(at('/notification'), { method: 'POST', apiKey, body });
  if (!saved.ok) throw new Error(`${svc.name} refused the webhook: ${why(saved.data, saved.status)}`);
  return { updated: !!existing };
}

// Seerr's webhook "types" are a bit mask: every request and issue event, not the test one.
const SEERR_TYPES = 2 | 4 | 8 | 16 | 64 | 128 | 256 | 512 | 1024 | 2048 | 4096;
// Seerr's default JSON payload (what lib/hub/parsers.js reads), for one that has none saved.
const SEERR_PAYLOAD = Buffer.from(
  JSON.stringify(
    {
      notification_type: '{{notification_type}}',
      event: '{{event}}',
      subject: '{{subject}}',
      message: '{{message}}',
      image: '{{image}}',
      '{{media}}': {
        media_type: '{{media_type}}',
        tmdbId: '{{media_tmdbid}}',
        tvdbId: '{{media_tvdbid}}',
        status: '{{media_status}}',
        status4k: '{{media_status4k}}',
      },
      '{{request}}': {
        request_id: '{{request_id}}',
        requestedBy_email: '{{requestedBy_email}}',
        requestedBy_username: '{{requestedBy_username}}',
      },
      '{{issue}}': {
        issue_id: '{{issue_id}}',
        issue_type: '{{issue_type}}',
        issue_status: '{{issue_status}}',
      },
      '{{comment}}': { comment_message: '{{comment_message}}' },
      '{{extra}}': [],
    },
    null,
    2,
  ),
).toString('base64');

/** @param {{ name: string, url: string, apiKey?: string }} svc @param {string} hookUrl @param {boolean} replace */
async function setUpSeerr(svc, hookUrl, replace) {
  /** @param {string} p */
  const at = p => join(svc.url, `/api/v1${p}`);
  const apiKey = svc.apiKey || '';
  const cur = await call(at('/settings/notifications/webhook'), { apiKey });
  if (!cur.ok) throw new Error(`${svc.name} didn't answer: ${why(cur.data, cur.status)}`);
  const current = String(cur.data?.options?.webhookUrl || '');
  const ours = current.split('?')[0] === hookUrl.split('?')[0];
  // Seerr has exactly one webhook: never take over one that's in use without asking.
  if (cur.data?.enabled && current && !ours && !replace) {
    let where = 'another address';
    try {
      where = new URL(current).host;
    } catch {
      /* keep the vague wording */
    }
    return { needsConfirm: true, current: where };
  }
  const body = {
    enabled: true,
    types: SEERR_TYPES,
    options: {
      ...(cur.data?.options || {}),
      webhookUrl: hookUrl,
      jsonPayload: cur.data?.options?.jsonPayload || SEERR_PAYLOAD,
    },
  };
  const test = await call(at('/settings/notifications/webhook/test'), { method: 'POST', apiKey, body });
  if (!test.ok) throw new Error(`${svc.name} couldn't reach Media Ops at that address: ${why(test.data, test.status)}`);
  const saved = await call(at('/settings/notifications/webhook'), { method: 'POST', apiKey, body });
  if (!saved.ok) throw new Error(`${svc.name} refused the webhook: ${why(saved.data, saved.status)}`);
  return { updated: ours || !!current };
}

/** @type {Record<string, string[]>} source type -> app kinds it can set up */
const KINDS = { sonarr: ['sonarr'], radarr: ['radarr'], seerr: ['seerr', 'overseerr', 'jellyseerr'] };

// Add the webhook to the app. `token` is blanked out of anything the app says back.
/** @param {{ kind: string, name: string, url: string, apiKey?: string }} svc @param {string} hookUrl @param {string} token @param {{ replace?: boolean }} [o] */
async function setUp(svc, hookUrl, token, { replace = false } = {}) {
  try {
    return svc.kind === 'sonarr' || svc.kind === 'radarr'
      ? await setUpArr(svc, hookUrl)
      : await setUpSeerr(svc, hookUrl, replace);
  } catch (e) {
    e.message = String(e.message).split(token).join('•••');
    throw e;
  }
}

module.exports = { looksDocker, suggest, setUp, KINDS, SEERR_TYPES };
