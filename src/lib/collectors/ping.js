// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Any other web app: is it answering?
'use strict';
const { req, timed } = require('../http');

async function ping(cfg) {
  const [res, latency] = await timed(() => req(cfg.url, { as: 'response', timeout: 5000 }));
  // Any non-5xx answer (incl. 401 / redirect to login) means the service is alive.
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  return { version: null, latency, data: { status: res.status } };
}

module.exports = { ping };
