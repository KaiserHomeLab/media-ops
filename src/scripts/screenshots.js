// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Retakes the README screenshots (docs/screenshots) from demo mode: `npm run screenshots`.
// Starts its own server with DEMO=1 on a spare port, so nothing else needs to be running.
// Needs Playwright's Chromium once: `npx playwright install chromium`.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const out = path.join(__dirname, '..', '..', 'docs', 'screenshots');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-shots-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CONFIG: path.join(dir, 'config.json'), DEMO: '1' },
    stdio: 'ignore',
  });
  for (
    let i = 0;
    i < 50 &&
    !(await fetch(`${base}/healthz`).then(
      r => r.ok,
      () => false,
    ));
    i++
  )
    await new Promise(r => setTimeout(r, 100));
  const browser = await chromium.launch();
  /** @param {number} width @param {number} height @param {object} [opts] */
  const page = (width, height, opts = {}) =>
    browser.newPage({ viewport: { width, height }, colorScheme: 'dark', reducedMotion: 'reduce', ...opts });
  /** @param {import('playwright').Page | import('playwright').ElementHandle | null} what @param {string} name */
  const shot = async (what, name) => {
    if (!what) throw new Error(`Nothing to capture for ${name}`);
    await what.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`docs/screenshots/${name}.png`);
  };
  try {
    let p = await page(1440, 900);
    await p.goto(`${base}/`);
    await p.waitForTimeout(3000);
    await shot(p, 'dashboard');
    for (const [id, name] of [
      ['map-card', 'stream-map'],
      ['events-card', 'errors'],
      ['space-card', 'space'],
      ['unraid-card', 'unraid'],
    ]) {
      await p.evaluate(i => document.getElementById(i)?.scrollIntoView({ block: 'center' }), id);
      await p.waitForTimeout(300);
      await shot(await p.$(`#${id}`), name);
    }
    p = await page(1920, 1080);
    await p.goto(`${base}/?tv=1`);
    await p.waitForTimeout(3000);
    await shot(p, 'tv-mode');
    p = await page(390, 844, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(`${base}/`);
    await p.waitForTimeout(3000);
    await shot(p, 'phone');
    p = await page(1200, 1000);
    await p.goto(`${base}/settings`);
    await p.waitForTimeout(1500);
    await p.click('text=/Add app/i');
    await p.waitForTimeout(500);
    await shot(p, 'settings');
    p = await page(1200, 1400);
    await p.goto(`${base}/settings`);
    await p.waitForTimeout(1500);
    await p.click('#accent-swatches label:has-text("Jellyfin purple")');
    await p.waitForTimeout(300);
    await shot(await p.$('#appearance'), 'appearance');
    p = await page(900, 700, { colorScheme: 'light' });
    await p.goto(`${base}/status`);
    await p.waitForTimeout(1500);
    await shot(p, 'status-page');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
