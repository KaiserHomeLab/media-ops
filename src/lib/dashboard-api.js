// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// What the dashboard can do besides reading: dismiss errors, clear an app's log, re-check,
// stop a stream, retry or replace a download, approve requests, and the poster proxy.
'use strict';
const config = require('./config');
const feed = require('./events');
const actions = require('./actions');
const { join } = require('./http');
const { AUTH } = require('./collectors/jellyfin');
const { loggedIn } = require('./auth');
const { readJson, send } = require('./web');
const { DEMO, describeError, invalidate, overview } = require('./poll');

const lastRecheck = new Map(); // service id -> when it was last re-checked
async function eventsApi(req, res, route) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  const body = await readJson(req);

  if (route === '/dismiss') {
    const { events } = await overview();
    config.update(c => ({ ...c, dismissed: feed.dismiss(c.dismissed, events, body) }));
    return send(res, 200, { ok: true });
  }
  if (route === '/restore') {
    config.update(c => ({ ...c, dismissed: feed.emptyState() }));
    return send(res, 200, { ok: true });
  }

  // /services/:id/(clear|recheck|stop|queue-retry|queue-remove|request-approve|request-decline)
  const m =
    /^\/services\/([\w-]+)\/(clear|recheck|stop|queue-retry|queue-remove|request-approve|request-decline)$/.exec(route);
  if (!m) return send(res, 404, { error: 'Not found' });
  const [, id, action] = m;
  // Anything that changes or deletes something inside an app is behind the settings password
  // when one is set. Re-check only reads, so it's open.
  if (action !== 'recheck' && !loggedIn(req))
    return send(res, 401, { error: 'Log in under Settings to do this', needLogin: true });
  if (DEMO) return send(res, 200, { ok: true, message: 'Demo mode — nothing was changed' });
  const svc = config.load().services.find(s => s.id === id);
  if (!svc) return send(res, 404, { error: 'App not found' });
  if (action === 'recheck') {
    // Open without a login, so keep anyone from making an app run its checks nonstop.
    if (Date.now() - (lastRecheck.get(id) || 0) < 15e3)
      return send(res, 429, { error: `${svc.name} was re-checked a moment ago. Try again in a few seconds.` });
    lastRecheck.set(id, Date.now());
  }
  try {
    const run = {
      clear: () => actions.clear(svc),
      recheck: () => actions.recheck(svc),
      stop: () => actions.stopStream(svc, body.sessionId, body.reason),
      'queue-retry': () => actions.queueRetry(svc),
      'queue-remove': () => actions.queueRemove(svc, body.queueId),
      'request-approve': () => actions.seerrRequest(svc, body.requestId, 'approve'),
      'request-decline': () => actions.seerrRequest(svc, body.requestId, 'decline'),
    }[action];
    const message = await run();
    invalidate(); // re-fetch logs/health right away
    return send(res, 200, { ok: true, message });
  } catch (e) {
    return send(res, e.status || 502, { error: describeError(e) });
  }
}

// ------------------------------------------------------------- poster proxy (keeps tokens server-side)
// /api/media/thumb?s=<media server id>&p=<image path>. Only image paths of the shape each server
// uses are accepted, so the proxy can't be pointed at anything else on the server.
const THUMB_MAX = 5 * 1024 * 1024; // a 240×360 poster is ~30 KB
const THUMB = {
  plex: {
    path: /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/,
    url: (svc, p) =>
      join(svc.url, `/photo/:/transcode?width=240&height=360&minSize=1&upscale=1&url=${encodeURIComponent(p)}`),
    headers: svc => ({ 'X-Plex-Token': svc.token || '' }),
  },
  jellyfin: {
    path: /^\/Items\/[0-9a-f]{32}\/Images\/Primary$/,
    url: (svc, p) => join(svc.url, `${p}?maxHeight=360&quality=85`),
    headers: svc => AUTH.jellyfin(svc.apiKey || ''),
  },
  emby: {
    path: /^\/Items\/(\d{1,12}|[0-9a-f]{32})\/Images\/Primary$/,
    url: (svc, p) => join(svc.url, `${p}?maxHeight=360&quality=85`),
    headers: svc => AUTH.emby(svc.apiKey || ''),
  },
};
async function mediaThumb(res, serviceId, p) {
  const svc = config.load().services.find(s => s.id === serviceId && s.enabled !== false);
  const how = svc && THUMB[svc.kind];
  if (!how || !how.path.test(p || '')) return send(res, 404);
  try {
    // No redirects: fetch would carry the token header along to wherever it points.
    const r = await fetch(how.url(svc, p), {
      headers: how.headers(svc),
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (
      !r.ok ||
      !r.body ||
      !/^image\/(jpeg|png|webp|gif)/.test(type) ||
      Number(r.headers.get('content-length')) > THUMB_MAX
    )
      throw new Error();
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      if ((size += c.length) > THUMB_MAX) throw new Error();
      chunks.push(c);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    res.end(Buffer.concat(chunks, size));
  } catch {
    send(res, 502);
  }
}

module.exports = { eventsApi, mediaThumb };
