'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const collectors = require('./lib/collectors');
const { join, unixGet, clearCache } = require('./lib/http');
const config = require('./lib/config');
const { KINDS } = require('./lib/kinds');
const demo = require('./lib/demo');

const PUBLIC = path.join(__dirname, 'public');
const DEMO = process.env.DEMO === '1';
const PORT = Number(process.env.PORT) || 8484;

// ------------------------------------------------------------- host stats
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i]?.times || c.times;
    for (const k of Object.keys(c.times)) total += c.times[k] - prev[k];
    idle += c.times.idle - prev.idle;
  });
  lastCpu = now;
  return total ? Math.round((1 - idle / total) * 100) : null;
}

function hostStats() {
  return {
    hostname: process.env.HOST_NAME || os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim(),
    cpu: cpuPercent(),
    load: os.loadavg(),
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    uptime: os.uptime(),
    node: process.version,
  };
}

async function localDisks(paths = []) {
  const out = [];
  for (const p of paths) {
    try {
      const s = await fs.promises.statfs(p);
      out.push({ path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch { /* path not mounted / not visible */ }
  }
  return out;
}

async function dockerContainers(cfg) {
  if (!cfg?.socket) return null;
  if (!fs.existsSync(cfg.socket)) return null; // socket not mounted — just hide the panel
  try {
    const list = await unixGet(cfg.socket, '/containers/json?all=1');
    return list
      .map(c => ({
        name: (c.Names?.[0] || c.Id).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return { error: e.message };
  }
}

// ------------------------------------------------------------- overview
function describeError(e) {
  // Node's fetch wraps the socket error, sometimes as an AggregateError (IPv4 + IPv6 attempts).
  const code = e.cause?.code || e.cause?.errors?.[0]?.code;
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  if (/HTTP 401|HTTP 403/.test(e.message)) return `${e.message} — check the API key`;
  if (e.name === 'TimeoutError') return 'Timed out';
  return code || (e.message === 'fetch failed' && e.cause?.message) || e.message;
}

async function runService(s) {
  const base = { id: s.id, kind: s.kind, name: s.name, link: s.link || s.url };
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out')), 15000));
    const r = await Promise.race([collectors[s.kind](s), timeout]);
    return { ...base, up: true, ...r };
  } catch (e) {
    return { ...base, up: false, error: describeError(e) };
  }
}

let cache = { at: 0, value: null, pending: null, gen: 0 };
function invalidate() {
  cache = { at: 0, value: null, pending: null, gen: cache.gen + 1 };
  clearCache();
}

async function overview() {
  const cfg = config.load();
  if (DEMO) return demo.overview(hostStats());
  if (cache.value && Date.now() - cache.at < 4000) return cache.value;
  if (cache.pending) return cache.pending;
  const gen = cache.gen;
  const p = (async () => {
    const services = cfg.services.filter(s => s.enabled !== false && collectors[s.kind]);
    const [results, docker, disks] = await Promise.all([
      Promise.all(services.map(runService)),
      dockerContainers(cfg.docker),
      localDisks(cfg.paths),
    ]);
    const value = {
      generatedAt: Date.now(), demo: false, refreshSeconds: cfg.refreshSeconds,
      configured: cfg.services.length > 0, host: hostStats(), services: results, docker, disks,
    };
    if (gen === cache.gen) cache = { ...cache, at: Date.now(), value, pending: null };
    return value;
  })();
  cache.pending = p;
  p.finally(() => { if (cache.pending === p) cache.pending = null; });
  return p;
}

// ------------------------------------------------------------- Plex poster proxy (keeps token server-side)
async function plexThumb(res, p) {
  const plex = config.load().services.find(s => s.kind === 'plex' && s.enabled !== false);
  if (!plex || !/^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/.test(p || '')) return send(res, 404);
  const url = join(plex.url, `/photo/:/transcode?width=240&height=360&minSize=1&upscale=1&url=${encodeURIComponent(p)}`);
  try {
    const r = await fetch(url, { headers: { 'X-Plex-Token': plex.token }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    send(res, 502);
  }
}

// ------------------------------------------------------------- settings: sessions & guards
const sessions = new Map(); // token -> expiry
const SESSION_DAYS = 30;

function cookie(req, name) {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
}
function loggedIn(req) {
  if (!config.load().auth) return true;
  const t = cookie(req, 'mo_session');
  const exp = t && sessions.get(t);
  return !!exp && exp > Date.now();
}
function startSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `mo_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

// Writes must come from this page (blocks other websites from silently changing your settings).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function readJson(req) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function settingsPayload(req) {
  const cfg = config.load();
  return {
    authEnabled: !!cfg.auth,
    loggedIn: loggedIn(req),
    demo: DEMO,
    configFile: config.FILE,
    general: { refreshSeconds: cfg.refreshSeconds, paths: cfg.paths, dockerSocket: cfg.docker?.socket || '' },
    services: cfg.services.map(config.publicService),
    kinds: KINDS,
  };
}

async function settingsApi(req, res, route) {
  const method = req.method;

  if (route === '/login' && method === 'POST') {
    const { password } = await readJson(req);
    if (!config.checkPassword(password)) {
      await new Promise(r => setTimeout(r, 800)); // slow down guessing
      return send(res, 401, { error: 'Wrong password' });
    }
    startSession(res);
    return send(res, 200, { ok: true });
  }
  if (route === '/logout' && method === 'POST') {
    sessions.delete(cookie(req, 'mo_session'));
    res.setHeader('Set-Cookie', 'mo_session=; Max-Age=0; Path=/');
    return send(res, 200, { ok: true });
  }

  if (!loggedIn(req)) return send(res, 401, { error: 'Log in to change settings', needLogin: true });
  if (method === 'GET' && route === '') return send(res, 200, settingsPayload(req));

  const svcMatch = /^\/services\/([\w-]+)$/.exec(route);

  if (method === 'POST' && route === '/test') {
    const input = await readJson(req);
    const existing = config.load().services.find(s => s.id === input.id);
    let svc;
    try { svc = config.mergeService(existing, input); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    const r = await runService(svc);
    return send(res, 200, r.up
      ? { ok: true, version: r.version, latency: r.latency, note: r.data?.note || null }
      : { ok: false, error: r.error });
  }

  if (method === 'POST' && route === '/services') {
    const input = await readJson(req);
    let svc;
    try { svc = config.mergeService(null, input); } catch (e) { return send(res, 400, { error: e.message }); }
    config.update(c => ({ ...c, services: [...c.services, svc] }));
    invalidate();
    return send(res, 201, config.publicService(svc));
  }

  if (svcMatch && method === 'PUT') {
    const input = await readJson(req);
    const id = svcMatch[1];
    const existing = config.load().services.find(s => s.id === id);
    if (!existing) return send(res, 404, { error: 'Not found' });
    let svc;
    try { svc = config.mergeService(existing, { ...input, kind: existing.kind }); } catch (e) { return send(res, 400, { error: e.message }); }
    config.update(c => ({ ...c, services: c.services.map(s => (s.id === id ? svc : s)) }));
    invalidate();
    return send(res, 200, config.publicService(svc));
  }

  if (svcMatch && method === 'DELETE') {
    config.update(c => ({ ...c, services: c.services.filter(s => s.id !== svcMatch[1]) }));
    invalidate();
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/order') {
    const { ids } = await readJson(req);
    config.update(c => {
      const pos = new Map((ids || []).map((id, i) => [id, i]));
      return { ...c, services: [...c.services].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)) };
    });
    invalidate();
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/general') {
    const g = await readJson(req);
    const refresh = Math.round(Number(g.refreshSeconds));
    if (!(refresh >= 3 && refresh <= 300)) return send(res, 400, { error: 'Refresh must be between 3 and 300 seconds' });
    const paths = (Array.isArray(g.paths) ? g.paths : String(g.paths || '').split(/[\n,]/))
      .map(p => String(p).trim()).filter(Boolean);
    if (paths.some(p => !p.startsWith('/'))) return send(res, 400, { error: 'Disk paths must be absolute, like /mnt/user' });
    config.update(c => ({ ...c, refreshSeconds: refresh, paths, docker: { socket: String(g.dockerSocket || '').trim() } }));
    invalidate();
    return send(res, 200, { ok: true });
  }

  if (method === 'PUT' && route === '/password') {
    const { current, next } = await readJson(req);
    const cfg = config.load();
    if (cfg.auth && !config.checkPassword(current)) return send(res, 401, { error: 'Current password is wrong' });
    if (next && String(next).length < 8) return send(res, 400, { error: 'Use at least 8 characters' });
    config.update(c => ({ ...c, auth: next ? config.hashPassword(String(next)) : null }));
    sessions.clear();
    if (next) startSession(res);
    return send(res, 200, { ok: true, authEnabled: !!next });
  }

  return send(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const PAGES = { '/': '/index.html', '/settings': '/settings.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/overview') return send(res, 200, await overview());
    if (url.pathname === '/api/plex/thumb') return plexThumb(res, url.searchParams.get('p'));
    if (url.pathname === '/healthz') return res.writeHead(200).end('ok');
    if (url.pathname === '/api/settings' || url.pathname.startsWith('/api/settings/')) {
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
      return await settingsApi(req, res, url.pathname.slice('/api/settings'.length));
    }

    const file = path.join(PUBLIC, path.normalize(PAGES[url.pathname] || url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403);
    const data = await fs.promises.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return res.writeHead(404).end('Not found');
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  const cfg = config.load();
  console.log(`Media Ops on http://localhost:${PORT}  (settings: http://localhost:${PORT}/settings)`);
  console.log(`Config file: ${config.FILE}`);
  if (DEMO) console.log('DEMO=1 — the dashboard shows fake data.');
  else if (!cfg.services.length) console.log('No apps connected yet — open /settings to add them.');
  else console.log(`Watching ${cfg.services.length} apps: ${cfg.services.map(s => s.name).join(', ')}`);
});
