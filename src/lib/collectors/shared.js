// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Small helpers shared by several collectors.
'use strict';

const DAY = 864e5;
// Disk space, missing counts and the indexer list barely change between polls; ask once a minute.
const MINUTE = 60e3;
/** @param {string | number | Date} d */
const isoDate = d => new Date(d).toISOString().slice(0, 10);
/** @param {unknown} n */
const pad = n => String(n ?? 0).padStart(2, '0');
/** @template T @param {T[]} arr @param {(x: T) => number | null | undefined} f */
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
// A list from an app's reply: the array if it is one, otherwise empty (a missing field, or an
// object where a list belongs, reads as nothing instead of throwing).
/** @param {unknown} v @returns {any[]} */
const list = v => (Array.isArray(v) ? v : []);

// Log levels from any app, normalised to warn / error (anything else is ignored).
/** @type {Record<string, string>} */
const LEVELS = { warn: 'warn', warning: 'warn', error: 'error', fatal: 'error', critical: 'error' };
/** @param {unknown} l */
const normLevel = l => LEVELS[String(l || '').toLowerCase()];

// Update checks ("is a newer version out?") run every 6 hours.
const UPDATE_TTL = 6 * 60 * 60e3;

module.exports = { DAY, MINUTE, isoDate, pad, sum, list, normLevel, UPDATE_TTL };
