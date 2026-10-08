// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// A small JSON-RPC 2.0 client over WebSocket, for TrueNAS (its REST API was removed in
// TrueNAS 26; everything goes through wss://<host>/api/current now). Written on the standard
// library: Node's built-in WebSocket can't accept the self-signed certificate every TrueNAS
// box ships with, and Media Ops has no npm dependencies.
//
// Only what a client needs from RFC 6455: the upgrade handshake, masked text frames out,
// unmasked text frames in (with fragmentation), ping → pong, and close.
//
// Connections are kept open and reused between polls (one per TrueNAS), so the server doesn't
// log a fresh login every few seconds. A broken connection is dropped and redialled next poll.
'use strict';
const https = require('node:https');
const crypto = require('node:crypto');
const { trace, sampleOf } = require('./http');

/** @param {number} opcode @param {Buffer | string} payload */
function frame(opcode, payload) {
  // The length is in bytes: a string's .length counts characters, which differs for anything
  // outside ASCII (an "é" in a name would have produced a malformed frame).
  const body = Buffer.from(payload);
  const len = body.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 0x80 | 127]),
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64BE(BigInt(len));
              return b;
            })(),
          ]);
  const mask = crypto.randomBytes(4);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// One reply bigger than this means something is wrong; drop the connection rather than buffer it.
const MAX_MESSAGE = 64 * 1024 * 1024;

class Connection {
  /** @param {import('node:tls').TLSSocket} socket @param {string} label */
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.fingerprint = socket.getPeerCertificate?.()?.fingerprint256 || null;
    /** @type {Buffer[]} */
    this.chunks = []; // received bytes not yet parsed, concatenated only when a frame is complete
    this.buffered = 0;
    /** @type {Buffer[]} */
    this.parts = [];
    this.partsLength = 0;
    this.nextId = 1;
    /** @type {Map<number, { timer: NodeJS.Timeout, reject: (e: Error) => void, done: (msg: any, bytes: number) => void }>} */
    this.pending = new Map();
    this.closed = false;
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.fail(new Error('TrueNAS closed the connection')));
    socket.on('error', e => this.fail(e));
  }

  /** @param {Buffer} d */
  onData(d) {
    this.chunks.push(d);
    this.buffered += d.length;
    if (this.buffered > MAX_MESSAGE + 16) return this.fail(new Error('TrueNAS sent a reply that is too large'));
    // Only join the chunks once there's enough for the frame we're waiting for (big replies
    // arrive in many chunks; joining on every chunk would copy the data over and over).
    if (this.need && this.buffered < this.need) return;
    this.buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.need = 0;
    for (;;) {
      if (this.buf.length < 2) return this.keep();
      const fin = this.buf[0] & 0x80,
        opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f,
        off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return this.keep();
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return this.keep();
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_MESSAGE || this.partsLength + len > MAX_MESSAGE)
        return this.fail(new Error('TrueNAS sent a reply that is too large'));
      const masked = this.buf[1] & 0x80;
      const maskKey = masked ? this.buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (this.buf.length < off + len) {
        this.need = off + len;
        return this.keep();
      }
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
        continue;
      } // ping → pong
      if (opcode === 0xa) continue;
      if (opcode === 0x8) {
        this.close();
        continue;
      }
      this.parts.push(payload);
      this.partsLength += payload.length;
      if (!fin) continue;
      const text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this.partsLength = 0;
      this.onMessage(text);
    }
  }

  // Put back what's left of the buffer until more data arrives.
  keep() {
    const buf = this.buf;
    if (buf?.length) {
      this.chunks.unshift(buf);
      this.buffered = buf.length;
    } else this.buffered = 0;
    this.buf = null;
  }

  /** @param {string} text */
  onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const p = msg.id != null && this.pending.get(msg.id);
    if (!p) return; // notifications (collection updates etc.) aren't used
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.done(msg, text.length);
  }

  // call(method, params, { record: false }) keeps the call out of diagnostics (used for login).
  /** @param {string} method @param {any[]} [params] @param {{ timeout?: number, record?: boolean }} [options] @returns {Promise<any>} */
  call(method, params = [], { timeout = 10000, record = true } = {}) {
    if (this.closed) return Promise.reject(new Error('Not connected to TrueNAS'));
    const store = record && trace.getStore();
    const t0 = performance.now();
    const rec = store && { method: 'RPC', url: `${this.label} · ${method}` };
    if (rec) store.calls.push(rec);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (rec) Object.assign(rec, { ms: Math.round(performance.now() - t0), error: 'timeout' });
        reject(new Error(`TrueNAS didn't answer ${method} in ${timeout / 1000} s`));
      }, timeout);
      this.pending.set(id, {
        timer,
        reject,
        done: (msg, bytes) => {
          if (rec)
            Object.assign(rec, {
              ms: Math.round(performance.now() - t0),
              bytes,
              status: msg.error ? 'error' : 'ok',
              sample: sampleOf(JSON.stringify(msg.error || msg.result)),
            });
          if (!msg.error) return resolve(msg.result);
          const why = msg.error.data?.reason || msg.error.message || 'error';
          if (rec) rec.error = why;
          reject(new Error(`${method}: ${String(why).split('\n')[0]}`));
        },
      });
      this.socket.write(frame(0x1, JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  /** @param {Error} err */
  fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.socket.destroy();
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(frame(0x8, Buffer.alloc(0)));
    } catch {
      /* already gone */
    }
    this.fail(new Error('Connection closed'));
  }
}

// Open a wss:// connection. TrueNAS uses a self-signed certificate out of the box, so it isn't
// verified: this talks to a box on your own LAN, and what matters is that the key is never sent
// over plain http (TrueNAS revokes API keys that are).
/** @param {string} host @param {number} port @param {string} [path] @param {number} [timeout] @returns {Promise<Connection>} */
function connect(host, port, path = '/api/current', timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      port,
      path,
      rejectUnauthorized: false,
      agent: false, // no TLS session reuse: a resumed session doesn't present the certificate to check
      timeout,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (res, socket, head) => {
      socket.setTimeout(0);
      socket.setNoDelay(true);
      const c = new Connection(
        /** @type {import('node:tls').TLSSocket} */ (socket),
        `wss://${host}${port === 443 ? '' : `:${port}`}${path}`,
      );
      if (head?.length) c.onData(head);
      resolve(c);
    });
    req.on('response', res => {
      res.resume();
      reject(
        new Error(
          res.statusCode === 404
            ? 'HTTP 404 on /api/current: is this TrueNAS 25.04 or newer?'
            : `HTTP ${res.statusCode} instead of a WebSocket upgrade`,
        ),
      );
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { connect };
