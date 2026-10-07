// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Trust-on-first-use certificate pins for servers with self-signed certificates (TrueNAS).
// The first successful connection records the certificate's SHA-256 fingerprint; afterwards a
// different certificate is refused, so someone on the network can't impersonate the server and
// collect the API key. Testing or saving the app in Settings trusts the current certificate
// again (for when it was really replaced). Stored next to config.json as known-certs.json.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const FILE = path.join(path.dirname(config.FILE), 'known-certs.json');
let pins = null;

function all() {
  if (!pins) {
    try { pins = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { pins = {}; }
  }
  return pins;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(pins, null, 2), { mode: 0o600 });
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    console.error(`Could not save ${FILE}: ${e.message}`);
  }
}

// Same host:port the TrueNAS collector connects to (always wss, port 443 unless an https:// address names one).
const keyOf = url => {
  try { const u = new URL(url); return `${u.hostname}:${u.protocol === 'https:' && u.port ? u.port : 443}`; } catch { return String(url); }
};

// Returns null if the fingerprint is trusted (recording it the first time), else an error message.
function check(hostPort, fingerprint) {
  if (!fingerprint) return 'The server sent no certificate.';
  const known = all()[hostPort];
  if (!known) {
    pins[hostPort] = fingerprint;
    save();
    return null;
  }
  return known === fingerprint ? null
    : "TrueNAS's certificate has changed since Media Ops first connected, so the connection was refused. If you replaced the certificate, open TrueNAS in Settings and click Test or Save to trust the new one. If you didn't, something on your network may be impersonating it.";
}

function forget(url) {
  const k = keyOf(url);
  if (all()[k]) { delete pins[k]; save(); }
}

module.exports = { check, forget, keyOf };
