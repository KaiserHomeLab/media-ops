// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub storage: one SQLite file next to config.json (/config/hub.db), through
// node:sqlite so Media Ops still has no dependencies. Events, and when each source was last
// heard from. Raw payloads are kept 7 days (they can hold requesters' names), events 90.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const DAY = 864e5;
const RAW_DAYS = 7;
const EVENT_DAYS = 90;
// Changing the tables: add a step here; each runs once, in order (PRAGMA user_version counts them).
const MIGRATIONS = [
  `CREATE TABLE hub_events (
     id TEXT PRIMARY KEY,
     received_at INTEGER NOT NULL,
     source TEXT NOT NULL,
     source_instance TEXT NOT NULL,
     type TEXT NOT NULL,
     severity TEXT NOT NULL,
     summary TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     is_upgrade INTEGER NOT NULL DEFAULT 0,
     media_json TEXT,
     raw_json TEXT,
     rule_name TEXT,
     action TEXT NOT NULL DEFAULT 'logged',
     digest_id TEXT,
     status TEXT NOT NULL DEFAULT 'logged'
   );
   CREATE INDEX hub_events_received ON hub_events (received_at);
   CREATE INDEX hub_events_dedupe ON hub_events (dedupe_key, received_at);
   CREATE TABLE hub_sources (
     source_id TEXT PRIMARY KEY,
     last_seen INTEGER,
     last_type TEXT,
     received INTEGER NOT NULL DEFAULT 0
   );`,
];

const FILE = () => process.env.HUB_DB || path.join(path.dirname(config.FILE), 'hub.db');

/** @type {import('node:sqlite').DatabaseSync | null} */
let db = null;
function open() {
  if (db) return db;
  // Loaded only when the hub is first used, so Node's "SQLite is experimental" note (Node 22)
  // isn't printed by installs that never touch it.
  const { DatabaseSync } = require('node:sqlite');
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600); // raw payloads can name people
  } catch {
    /* a filesystem without modes */
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
  const at = Number(/** @type {any} */ (db.prepare('PRAGMA user_version').get()).user_version);
  for (let i = at; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

/** @param {import('./normalize').HubEvent} e @param {{ rule?: string | null, action?: string, digestId?: string | null, status?: string }} [outcome] */
function add(e, outcome = {}) {
  open()
    .prepare(
      `INSERT INTO hub_events (id, received_at, source, source_instance, type, severity, summary, dedupe_key,
         is_upgrade, media_json, raw_json, rule_name, action, digest_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      e.receivedAt,
      e.source,
      e.sourceInstance,
      e.type,
      e.severity,
      e.summary,
      e.dedupeKey,
      e.isUpgrade ? 1 : 0,
      e.media ? JSON.stringify(e.media) : null,
      e.raw == null ? null : JSON.stringify(e.raw),
      outcome.rule ?? null,
      outcome.action ?? 'logged',
      outcome.digestId ?? null,
      outcome.status ?? 'logged',
    );
}

/** @param {string} sourceId @param {string} type */
function sawSource(sourceId, type) {
  open()
    .prepare(
      `INSERT INTO hub_sources (source_id, last_seen, last_type, received) VALUES (?, ?, ?, 1)
       ON CONFLICT (source_id) DO UPDATE SET last_seen = excluded.last_seen, last_type = excluded.last_type,
         received = received + 1`,
    )
    .run(sourceId, Date.now(), type);
}

/** @returns {Record<string, { lastSeen: number | null, lastType: string | null, received: number }>} */
function sourceStats() {
  const rows = /** @type {any[]} */ (open().prepare('SELECT * FROM hub_sources').all());
  return Object.fromEntries(
    rows.map(r => [r.source_id, { lastSeen: r.last_seen, lastType: r.last_type, received: r.received }]),
  );
}
/** @param {string} sourceId */
function forgetSource(sourceId) {
  open().prepare('DELETE FROM hub_sources WHERE source_id = ?').run(sourceId);
}

// The newest events, for Activity. Never the raw payload: that stays on the server.
/** @param {number} [limit] */
function recent(limit = 200) {
  const rows = /** @type {any[]} */ (
    open()
      .prepare(
        `SELECT id, received_at, source, source_instance, type, severity, summary, dedupe_key, is_upgrade,
           media_json, rule_name, action, digest_id, status
         FROM hub_events ORDER BY received_at DESC, rowid DESC LIMIT ?`,
      )
      .all(Math.min(1000, Math.max(1, limit)))
  );
  return rows.map(r => ({
    id: r.id,
    receivedAt: r.received_at,
    source: r.source,
    sourceInstance: r.source_instance,
    type: r.type,
    severity: r.severity,
    summary: r.summary,
    dedupeKey: r.dedupe_key,
    isUpgrade: !!r.is_upgrade,
    media: r.media_json ? JSON.parse(r.media_json) : null,
    rule: r.rule_name,
    action: r.action,
    digestId: r.digest_id,
    status: r.status,
  }));
}

// Drop raw payloads after 7 days and events after 90.
/** @param {number} [now] */
function prune(now = Date.now()) {
  const d = open();
  d.prepare('UPDATE hub_events SET raw_json = NULL WHERE raw_json IS NOT NULL AND received_at < ?').run(
    now - RAW_DAYS * DAY,
  );
  d.prepare('DELETE FROM hub_events WHERE received_at < ?').run(now - EVENT_DAYS * DAY);
}

function close() {
  db?.close();
  db = null;
}

module.exports = { FILE, add, sawSource, sourceStats, forgetSource, recent, prune, close, RAW_DAYS, EVENT_DAYS };
