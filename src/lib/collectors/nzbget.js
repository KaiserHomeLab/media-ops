// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// NZBGet: queue, speed, failed downloads and log warnings, over its JSON-RPC API.
'use strict';
const { basicAuth, join, req, timed, cached } = require('../http');
const { list } = require('./shared');

const MB = 1048576;
// History status is "RESULT/DETAIL", e.g. "FAILURE/UNPACK". Plain words for the failures.
/** @type {Record<string, string>} */
const FAILURES = {
  PAR: 'repair failed',
  UNPACK: 'unpack failed',
  HEALTH: 'too many missing articles',
  MOVE: 'could not move the files',
  SCAN: 'could not read the NZB',
  BAD: 'bad download',
  FETCH: 'could not fetch the NZB',
};

/** @param {import('../types').Service} cfg */
async function nzbget(cfg) {
  /** @param {string} method @param {unknown[]} [params] */
  const rpc = (method, params = []) =>
    req(join(cfg.url, '/jsonrpc'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...basicAuth(cfg.username, cfg.password) },
      body: JSON.stringify({ method, params, id: 1 }),
    }).then(r => {
      if (r?.error) throw new Error(`NZBGet: ${r.error.message || r.error}`);
      return r?.result;
    });

  const [version, latency] = await timed(() => rpc('version'));
  const [status, groups, history, log] = await Promise.all([
    rpc('status'),
    rpc('listgroups'),
    cached(`nzbget-history:${cfg.url}`, 60e3, () => rpc('history', [false]).catch(() => null)),
    cached(`nzbget-log:${cfg.url}`, 60e3, () => rpc('log', [0, 100]).catch(() => null)),
  ]);

  const rate = Number(status.DownloadRate) || 0;
  const paused = !!(status.DownloadPaused || status.Download2Paused);
  const items = list(groups).map(g => {
    const size = (g.FileSizeMB || 0) * MB;
    const left = (g.RemainingSizeMB || 0) * MB;
    return {
      title: g.NZBName,
      progress: size ? Math.min(1, Math.max(0, 1 - left / size)) : 0,
      size,
      eta: g.Status === 'DOWNLOADING' && rate ? Math.round(left / rate) : null,
      status: String(g.Status || '').toLowerCase(),
    };
  });

  const failed = list(history)
    .filter(h => String(h.Status).startsWith('FAILURE'))
    .sort((a, b) => b.HistoryTime - a.HistoryTime)
    .slice(0, 15)
    .map(h => {
      const why = String(h.Status).split('/')[1];
      return {
        time: h.HistoryTime * 1000,
        level: 'error',
        source: 'Failed download',
        message: `${h.Name}: ${FAILURES[why] || why?.toLowerCase() || 'failed'}`,
        detail:
          [h.Category && `Category: ${h.Category}`, h.DestDir && `Path: ${h.DestDir}`].filter(Boolean).join('\n') ||
          null,
      };
    });
  const warnings = list(log)
    .filter(l => l.Kind === 'ERROR' || l.Kind === 'WARNING')
    .map(l => ({
      time: l.Time * 1000,
      level: l.Kind === 'ERROR' ? 'error' : 'warn',
      source: 'Log',
      message: l.Text,
    }));

  return {
    version,
    latency,
    data: {
      client: 'usenet',
      paused,
      status: paused ? 'Paused' : items.length ? 'Downloading' : 'Idle',
      downBps: rate,
      upBps: 0,
      items,
      events: [...warnings, ...failed],
    },
  };
}

module.exports = { nzbget };
