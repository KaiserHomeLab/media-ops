// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Test helpers: a throwaway config folder and a fake app server that answers from fixtures.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Must run before anything requires lib/config.js.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-test-'));
process.env.CONFIG = path.join(dir, 'config.json');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

// routes: { 'GET /api/v3/series': body | (req, url, body) => body }. A body of
// { status, body?, headers? } sets the response exactly. Records every request.
function fakeServer(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const route = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname];
      if (route === undefined) {
        res.statusCode = 404;
        return res.end('{}');
      }
      const out = typeof route === 'function' ? route(req, url, body) : route;
      if (out && out.status) {
        for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
        res.statusCode = out.status;
        return res.end(out.body ?? '');
      }
      res.setHeader('Content-Type', typeof out === 'string' ? 'text/plain' : 'application/json');
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() });
    }),
  );
}

// A fake TrueNAS: JSON-RPC 2.0 over wss:// with a self-signed certificate, like the real one.
// methods: { 'pool.query': result | (params, conn) => result }. A thrown Error becomes a
// JSON-RPC error. `logins` counts auth.login_ex calls; `close()` stops it.
function fakeTrueNAS(methods) {
  const https = require('node:https');
  const crypto = require('node:crypto');
  const tls = p => fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', p));
  const state = { logins: 0, connections: 0, calls: [] };
  const server = https.createServer({ key: tls('key.pem'), cert: tls('cert.pem') });
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (req.url !== '/api/current') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = obj => {
      const data = Buffer.from(JSON.stringify(obj));
      const len = data.length;
      const head =
        len < 126
          ? Buffer.from([0x81, len])
          : len < 65536
            ? Buffer.from([0x81, 126, len >> 8, len & 255])
            : (() => {
                const h = Buffer.alloc(10);
                h[0] = 0x81;
                h[1] = 127;
                h.writeBigUInt64BE(BigInt(len), 2);
                return h;
              })();
      socket.write(Buffer.concat([head, data]));
    };
    let buf = Buffer.alloc(0),
      authed = false;
    socket.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        let len = buf[1] & 0x7f,
          off = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + 4 + len) return;
        const opcode = buf[0] & 0x0f;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i & 3]);
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode !== 0x1) continue;
        const msg = JSON.parse(Buffer.from(payload).toString());
        state.calls.push(msg.method);
        if (msg.method === 'auth.login_ex') {
          state.logins++;
          const p = msg.params[0];
          authed = p.mechanism === 'API_KEY_PLAIN' && methods.__users?.[p.username] === p.api_key;
          send({ jsonrpc: '2.0', id: msg.id, result: { response_type: authed ? 'SUCCESS' : 'AUTH_ERR' } });
          continue;
        }
        if (!authed) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Not authenticated' } });
          continue;
        }
        const m = methods[msg.method];
        if (m === undefined) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
          continue;
        }
        try {
          send({ jsonrpc: '2.0', id: msg.id, result: typeof m === 'function' ? m(msg.params) : m });
        } catch (e) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Method call error', data: { reason: e.message } },
          });
        }
      }
    });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `https://127.0.0.1:${server.address().port}`,
        state,
        dropConnections: () => sockets.forEach(s => s.destroy()),
        close: () => {
          sockets.forEach(s => s.destroy());
          server.close();
        },
      }),
    ),
  );
}

// A fake mail server. { starttls, tls (encrypted from the start), auth: login methods offered }
// choose what it offers;
// `sessions` records what each client did: { encrypted, auth, from, to, data }.
function fakeSmtp({ starttls = false, tls: implicit = false, auth = 'PLAIN LOGIN' } = {}) {
  const net = require('node:net');
  const tlsMod = require('node:tls');
  const cert = { key: fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'key.pem')), cert: tlsCert() };
  const sessions = [];
  const handle = (socket, encrypted) => {
    const sess = { encrypted, auth: null, from: null, to: [], data: null };
    sessions.push(sess);
    let buf = '',
      inData = false,
      authStep = null;
    const say = l => socket.write(`${l}\r\n`);
    const caps = () => [
      '250-media-ops-test',
      ...(auth ? [`250-AUTH ${auth}`] : []),
      ...(starttls && !sess.encrypted ? ['250-STARTTLS'] : []),
      '250 8BITMIME',
    ];
    socket.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            say('250 queued');
          } else sess.data += `${line}\n`;
          continue;
        }
        if (authStep === 'user') {
          sess.auth = { user: Buffer.from(line, 'base64').toString() };
          authStep = 'pass';
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (authStep === 'pass') {
          sess.auth.pass = Buffer.from(line, 'base64').toString();
          authStep = null;
          say('235 ok');
          continue;
        }
        const [verb] = line.split(' ');
        if (verb === 'EHLO') caps().forEach(say);
        else if (verb === 'STARTTLS') {
          say('220 go ahead');
          socket.removeAllListeners('data');
          const secure = new tlsMod.TLSSocket(socket, {
            isServer: true,
            secureContext: tlsMod.createSecureContext(cert),
          });
          handle(secure, true);
          sessions.splice(sessions.indexOf(sess), 1);
          return;
        } else if (line.startsWith('AUTH PLAIN ')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          sess.auth = { user, pass };
          say('235 ok');
        } else if (line === 'AUTH LOGIN') {
          authStep = 'user';
          say('334 VXNlcm5hbWU6');
        } else if (line.startsWith('MAIL FROM:')) {
          sess.from = line.slice(10);
          say('250 ok');
        } else if (line.startsWith('RCPT TO:')) {
          sess.to.push(line.slice(8));
          say('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          sess.data = '';
          say('354 go');
        } else if (verb === 'QUIT') {
          say('221 bye');
          socket.end();
        } else say('500 what');
      }
    });
    socket.on('error', () => {});
  };
  const server = implicit
    ? tlsMod.createServer(cert, s => {
        s.write('220 media-ops-test ESMTP\r\n');
        handle(s, true);
      })
    : net.createServer(s => {
        s.write('220 media-ops-test ESMTP\r\n');
        handle(s, false);
      });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        sessions,
        close: () => server.close(),
        // Lets the client trust the test certificate (CN media-ops-test).
        tlsOptions: { ca: tlsCert(), servername: 'media-ops-test' },
      }),
    ),
  );
}
const tlsCert = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'cert.pem'));

module.exports = { dir, fixture, fakeServer, fakeTrueNAS, fakeSmtp };
