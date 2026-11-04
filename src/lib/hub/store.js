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
  // Rules: where a "now" event goes, when it went, and each send attempt.
  `ALTER TABLE hub_events ADD COLUMN destinations TEXT;
   ALTER TABLE hub_events ADD COLUMN sent_at INTEGER;
   CREATE INDEX hub_events_status ON hub_events (status, received_at);
   CREATE TABLE hub_deliveries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT,
     digest_run_id TEXT,
     destination TEXT NOT NULL,
     ok INTEGER NOT NULL,
     error TEXT,
     sent_at INTEGER NOT NULL
   );
   CREATE INDEX hub_deliveries_event ON hub_deliveries (event_id);`,
  // Digests: one row per run, and which run took each event.
  `CREATE TABLE hub_digest_runs (
     id TEXT PRIMARY KEY,
     digest_id TEXT NOT NULL,
     window_start INTEGER,
     window_end INTEGER NOT NULL,
     item_count INTEGER NOT NULL,
     upgrade_count INTEGER NOT NULL DEFAULT 0,
     sent_at INTEGER NOT NULL,
     status TEXT NOT NULL
   );
   CREATE INDEX hub_digest_runs_digest ON hub_digest_runs (digest_id, sent_at);
   ALTER TABLE hub_events ADD COLUMN digest_run_id TEXT;
   CREATE INDEX hub_events_digest ON hub_events (digest_id, status);`,
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
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK'); // all of a step or none of it
      db.close();
      db = null;
      throw e;
    }
  }
  return db;
}

/**
 * What a rule decided for an event. Statuses: pending (to send at the next tick), held (quiet
 * hours), sent, failed, suppressed (the same thing sent moments ago), queued (for a digest),
 * dropped, unrouted (a "now" rule with no destinations).
 * @typedef {{ rule?: string | null, action?: string, digestId?: string | null, status?: string, destinations?: string[] }} Outcome
 */
/** @param {import('./normalize').HubEvent} e @param {Outcome} [outcome] */
function add(e, outcome = {}) {
  open()
    .prepare(
      `INSERT INTO hub_events (id, received_at, source, source_instance, type, severity, summary, dedupe_key,
         is_upgrade, media_json, raw_json, rule_name, action, digest_id, status, destinations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      outcome.destinations ? JSON.stringify(outcome.destinations) : null,
    );
}

// Sent (or about to be) within the last `ms`: the same thing again is suppressed, not re-sent.
/** @param {string} dedupeKey @param {string} type @param {number} ms */
function recentlySent(dedupeKey, type, ms) {
  return !!open()
    .prepare(
      `SELECT 1 FROM hub_events WHERE dedupe_key = ? AND type = ? AND received_at >= ?
         AND status IN ('pending', 'held', 'sent') LIMIT 1`,
    )
    .get(dedupeKey, type, Date.now() - ms);
}

// "Now" events waiting to go out (and those held for quiet hours), oldest first.
/** @param {string[]} statuses */
function waiting(statuses) {
  const rows = /** @type {any[]} */ (
    open()
      .prepare(
        `SELECT id, type, severity, summary, destinations, status FROM hub_events
         WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY received_at, rowid LIMIT 500`,
      )
      .all(...statuses)
  );
  return rows.map(r => ({
    id: String(r.id),
    type: String(r.type),
    severity: /** @type {import('./normalize').Severity} */ (r.severity),
    summary: String(r.summary),
    destinations: /** @type {string[]} */ (r.destinations ? JSON.parse(r.destinations) : []),
    status: String(r.status),
  }));
}

// Everything waiting for a digest, oldest first, with its title details.
/** @param {string} digestId @returns {(import('./normalize').HubEvent & { status: string })[]} */
function queuedFor(digestId) {
  const rows = /** @type {any[]} */ (
    open()
      .prepare(
        `SELECT id, received_at, source, source_instance, type, severity, summary, dedupe_key, is_upgrade, media_json, status
         FROM hub_events WHERE digest_id = ? AND status = 'queued' ORDER BY received_at, rowid`,
      )
      .all(digestId)
  );
  return rows.map(r => ({
    id: String(r.id),
    receivedAt: Number(r.received_at),
    source: String(r.source),
    sourceInstance: String(r.source_instance),
    type: String(r.type),
    severity: r.severity,
    summary: String(r.summary),
    dedupeKey: String(r.dedupe_key),
    isUpgrade: !!r.is_upgrade,
    media: r.media_json ? JSON.parse(r.media_json) : null,
    raw: null,
    status: String(r.status),
  }));
}

/** @param {{ id: string, digestId: string, windowStart: number | null, windowEnd: number, items: number, upgrades: number, status: string }} run @param {string[]} eventIds */
function digestRun(run, eventIds) {
  const d = open();
  d.exec('BEGIN');
  try {
    d.prepare(
      `INSERT INTO hub_digest_runs (id, digest_id, window_start, window_end, item_count, upgrade_count, sent_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(run.id, run.digestId, run.windowStart, run.windowEnd, run.items, run.upgrades, Date.now(), run.status);
    const stmt = d.prepare(`UPDATE hub_events SET status = 'digested', digest_run_id = ?, sent_at = ? WHERE id = ?`);
    for (const id of eventIds) stmt.run(run.id, run.status === 'sent' ? Date.now() : null, id);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** @param {string} digestId */
function lastRun(digestId) {
  const r = /** @type {any} */ (
    open().prepare('SELECT * FROM hub_digest_runs WHERE digest_id = ? ORDER BY sent_at DESC LIMIT 1').get(digestId)
  );
  return r ? { id: r.id, sentAt: r.sent_at, status: r.status, items: r.item_count, upgrades: r.upgrade_count } : null;
}

/** @param {string[]} ids @param {string} status */
function mark(ids, status) {
  const stmt = open().prepare(`UPDATE hub_events SET status = ?, sent_at = ? WHERE id = ?`);
  const at = status === 'sent' ? Date.now() : null;
  for (const id of ids) stmt.run(status, at, id);
}

/** @param {{ eventIds?: string[], digestRunId?: string, destination: string, ok: boolean, error?: string | null }} d */
function delivered({ eventIds = [], digestRunId, destination, ok, error }) {
  const stmt = open().prepare(
    'INSERT INTO hub_deliveries (event_id, digest_run_id, destination, ok, error, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const at = Date.now();
  for (const id of eventIds.length ? eventIds : [null])
    stmt.run(id, digestRunId ?? null, destination, ok ? 1 : 0, error ? String(error).slice(0, 500) : null, at);
}
/** @param {string[]} eventIds */
function deliveriesOf(eventIds) {
  if (!eventIds.length) return {};
  const rows = /** @type {any[]} */ (
    open()
      .prepare(
        `SELECT event_id, destination, ok, error, sent_at FROM hub_deliveries
         WHERE event_id IN (${eventIds.map(() => '?').join(', ')}) ORDER BY id`,
      )
      .all(...eventIds)
  );
  /** @type {Record<string, { destination: string, ok: boolean, error: string | null, at: number }[]>} */
  const out = {};
  for (const r of rows)
    (out[r.event_id] ||= []).push({ destination: r.destination, ok: !!r.ok, error: r.error, at: r.sent_at });
  return out;
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
           media_json, rule_name, action, digest_id, status, destinations, sent_at
         FROM hub_events ORDER BY received_at DESC, rowid DESC LIMIT ?`,
      )
      .all(Math.min(1000, Math.max(1, limit)))
  );
  const sends = deliveriesOf(rows.map(r => r.id));
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
    destinations: r.destinations ? JSON.parse(r.destinations) : [],
    sentAt: r.sent_at,
    deliveries: sends[r.id] || [],
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
  d.prepare('DELETE FROM hub_deliveries WHERE sent_at < ?').run(now - EVENT_DAYS * DAY);
  d.prepare('DELETE FROM hub_digest_runs WHERE sent_at < ?').run(now - EVENT_DAYS * DAY);
}

function close() {
  db?.close();
  db = null;
}

module.exports = {
  FILE,
  add,
  recentlySent,
  waiting,
  mark,
  delivered,
  queuedFor,
  digestRun,
  lastRun,
  sawSource,
  sourceStats,
  forgetSource,
  recent,
  prune,
  close,
};
