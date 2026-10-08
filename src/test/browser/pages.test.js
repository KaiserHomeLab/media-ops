// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// The pages in a real browser (headless Chromium via Playwright), against the server in demo
// mode: what unit tests can't see, like layout, scrolling, the live strip, TV mode and the
// Settings forms. Every test also fails on a script error or a Content Security Policy
// violation in the page. Run with `npm run test:browser` (CI runs it on every pull request);
// it needs `npx playwright install chromium` once.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ops-browser-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
/** @type {import('node:child_process').ChildProcess} */
let server;
/** @type {import('playwright').Browser} */
let browser;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CONFIG: path.join(dir, 'config.json'), DEMO: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

// A page that records script errors and CSP violations; each test asserts there were none.
async function open(url, { width = 1440, height = 900, colorScheme = 'dark', ...rest } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce', ...rest });
  const problems = [];
  page.on('pageerror', e => problems.push(`script error: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  await page.goto(base + url);
  return { page, problems };
}
const noProblems = problems => assert.deepEqual(problems, [], 'no script errors or CSP violations');

test('dashboard: every card fills in from the demo data', async () => {
  const { page, problems } = await open('/');
  await page.waitForSelector('#kpis .kpi');
  const filled = await page.evaluate(() => ({
    kpis: document.querySelectorAll('#kpis .kpi').length,
    streams: document.querySelectorAll('#streams .stream').length,
    services: document.querySelectorAll('#services .svc').length,
    events: document.querySelectorAll('#events .ev').length,
    hostline: document.getElementById('hostline')?.textContent,
  }));
  assert.equal(filled.kpis, 7);
  assert.ok(filled.streams >= 5, 'streams from Plex and Jellyfin');
  assert.ok(filled.services >= 12);
  assert.ok(filled.events > 0);
  assert.match(filled.hostline || '', /Tower/);
  noProblems(problems);
  await page.close();
});

test('stream map: a viewer without a location goes to Asgard, across the Bifröst', async () => {
  const { page, problems } = await open('/');
  await page.waitForSelector('#map svg .asgard');
  const m = await page.evaluate(() => ({
    beam: ['.bf-glow', '.bf-beam', '.bf-core', '.bf-spark', '.bf-runes'].every(c =>
      document.querySelector(`#map .bifrost ${c}`),
    ),
    label: [...document.querySelectorAll('#map .lbl.asgard')].map(e => e.textContent),
    row: [...document.querySelectorAll('#viewers li')].find(li => li.querySelector('.sw.asgard'))?.textContent,
  }));
  assert.ok(m.beam, 'the beam: glow, light, core, sparks and the landing mark');
  assert.deepEqual(m.label, ['Asgard']);
  assert.match(m.row || '', /Asgard · location unknown · Jellyfin\/Emby/, 'the list still says why');
  noProblems(problems);
  await page.close();
});

test('live strip: hidden at the top, shown after scrolling, and its links land on the card', async () => {
  const { page, problems } = await open('/');
  await page.waitForSelector('.strip-item', { state: 'attached' }); // exists, but hidden at first
  const visible = () => page.evaluate(() => getComputedStyle(document.getElementById('strip')).visibility);
  assert.equal(await visible(), 'hidden', 'the summary row is on screen, so no strip');
  await page.mouse.wheel(0, 1500);
  await page.waitForFunction(() => document.body.classList.contains('strip-on'));
  assert.equal(await visible(), 'visible');
  await page.click('.strip-item[href="#events-card"]');
  await page.waitForTimeout(200);
  const top = await page.evaluate(() => document.getElementById('events-card')?.getBoundingClientRect().top);
  assert.ok(top != null && top > 40 && top < 140, `events card lands below the sticky bar (top ${top})`);
  noProblems(problems);
  await page.close();
});

test('TV mode fits one screen without scrolling and hides the strip', async () => {
  const { page, problems } = await open('/?tv=1', { width: 1920, height: 1080 });
  await page.waitForSelector('#tv-cols');
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight - innerHeight,
    strip: getComputedStyle(document.getElementById('strip')).display,
  }));
  assert.ok(m.scroll <= 0, `no vertical scroll (overflow ${m.scroll}px)`);
  assert.equal(m.strip, 'none');
  noProblems(problems);
  await page.close();
});

test('phone: no sideways scrolling, and the title keeps its place', async () => {
  const { page, problems } = await open('/', { width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.waitForSelector('#kpis .kpi');
  const m = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    title: document.querySelector('header.top h1')?.getBoundingClientRect().width || 0,
  }));
  assert.ok(m.overflow <= 0, `no horizontal scroll (overflow ${m.overflow}px)`);
  assert.ok(m.title > 20, 'the title is visible');
  noProblems(problems);
  await page.close();
});

test('settings: add-app picker lists every kind, a form opens, appearance previews live', async () => {
  const { page, problems } = await open('/settings');
  await page.waitForSelector('#settings-body:not([hidden])');
  await page.click('text=/Add app/i');
  const kinds = await page.$$eval('.pick', els => els.map(e => e.textContent?.trim()));
  for (const k of ['Plex', 'Jellyfin', 'Emby', 'NZBGet', 'Transmission', 'Deluge'])
    assert.ok(
      kinds.some(t => t?.includes(k)),
      `${k} in the picker`,
    );
  await page.click('.pick:has-text("Sonarr")');
  await page.waitForSelector('#app-form [name=url]');
  await page.keyboard.press('Escape');

  await page.click('#accent-swatches label:has-text("Teal")');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), 'teal', 'accent previews at once');
  await page.click('#appearance-form label:has-text("Light") >> nth=0');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  noProblems(problems);
  await page.close();
});

test('status page: shows the media apps with uptime, nothing else', async () => {
  const { page, problems } = await open('/status', { colorScheme: 'light' });
  await page.waitForSelector('.stp-row');
  const rows = await page.$$eval('.stp-row .stp-name', els => els.map(e => e.textContent));
  assert.deepEqual(rows, ['Plex', 'Jellyfin', 'Seerr']);
  assert.match((await page.textContent('#stp-overall')) || '', /Everything is up/);
  noProblems(problems);
  await page.close();
});
