// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// SABnzbd: queue, speed, warnings and failed downloads.
'use strict';
const { join, req, timed, cached } = require('../http');
const { normLevel, list } = require('./shared');

/** @param {import('../types').Service} cfg */
async function sabnzbd(cfg) {
  /** @param {string} mode */
  const api = mode =>
    req(join(cfg.url, `/api?mode=${mode}&output=json&apikey=${encodeURIComponent(cfg.apiKey || '')}`));
  const [q, latency] = await timed(() => api('queue'));
  const [totals, warnings, failed] = await Promise.all([
    cached(`sab-stats:${cfg.url}`, 60e3, () => api('server_stats').catch(() => null)),
    cached(`sab-warn:${cfg.url}`, 60e3, () => api('warnings').catch(() => null)),
    cached(`sab-failed:${cfg.url}`, 60e3, () => api('history&failed_only=1&limit=15').catch(() => null)),
  ]);
  const queue = q.queue;
  const events = [
    // SAB 4.x returns {text,type,time}; 3.x returned "timestamp\nLEVEL\nmessage" strings.
    ...list(warnings?.warnings).map(w => {
      if (typeof w === 'string') {
        const [time, type, ...msg] = w.split('\n');
        return {
          time: time.replace(',', '.').replace(' ', 'T'),
          level: normLevel(type) || 'warn',
          source: 'Warnings',
          message: msg.join(' '),
        };
      }
      return { time: w.time * 1000, level: normLevel(w.type) || 'warn', source: 'Warnings', message: w.text };
    }),
    ...list(failed?.history?.slots).map(h => ({
      time: h.completed * 1000,
      level: 'error',
      source: 'Failed download',
      message: `${h.name}: ${h.fail_message || 'failed'}`,
      detail:
        [h.category && `Category: ${h.category}`, h.storage && `Path: ${h.storage}`].filter(Boolean).join('\n') || null,
    })),
  ];
  return {
    version: queue.version,
    latency,
    data: {
      client: 'usenet',
      paused: queue.paused,
      status: queue.status,
      downBps: Number(queue.kbpersec || 0) * 1024,
      upBps: 0,
      items: list(queue.slots).map(s => ({
        title: s.filename,
        progress: Number(s.percentage || 0) / 100,
        size: Number(s.mb || 0) * 1048576,
        eta: s.timeleft,
        status: s.status,
      })),
      totals: totals && { day: totals.day, week: totals.week, month: totals.month, all: totals.total },
      events,
    },
  };
}

module.exports = { sabnzbd };
