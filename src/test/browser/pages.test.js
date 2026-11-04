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

test('settings: Notification Hub Activity lists what happened, filters, and opens a row', async () => {
  const { page, problems } = await open('/settings#hub');
  await page.waitForSelector('#hub-log .hub-row');
  const rows = await page.$$eval('#hub-log .hub-row', els => els.length);
  assert.ok(rows >= 5, 'the demo events');
  assert.match((await page.textContent('#hub-log')) || '', /Waiting for “Added to Plex”/);
  await page.selectOption('#hub-filter', 'failed');
  const failed = await page.$$eval('#hub-log .hub-row', els =>
    els.map(e => e.querySelector('.hub-summary')?.textContent),
  );
  assert.deepEqual(failed, ['🔴 Prowlarr is down: Connection refused'], 'a send that failed for one destination');
  await page.click('#hub-log .hub-row summary');
  assert.match((await page.textContent('#hub-log .hub-sends')) || '', /Phone \(ntfy\): HTTP 502/);
  await page.selectOption('#hub-filter', '');
  noProblems(problems);
  await page.close();
});

test('settings: Notification Hub in steps: connect an app (address once), send new movies to a Discord channel added on the spot', async () => {
  const { page, problems } = await open('/settings#hub');
  /** @type {string[]} */
  const asked = [];
  page.on('dialog', d => {
    asked.push(d.message());
    d.accept();
  });
  await page.waitForSelector('#hub-form');
  await page.check('#hub-form [name=enabled]');
  await page.click('#hub-form button[type=submit]');
  await page.waitForSelector('#hub-steps:not([hidden])');

  // 1. Connect apps
  await page.click('#hub-steps [data-step="1"]');
  await page.click('#hub-add-source');
  await page.selectOption('#hub-source-form [name=type]', 'radarr');
  await page.click('#hub-source-form button[type=submit]');
  await page.waitForSelector('#hub-connect');
  // No Radarr under Apps: no "Set it up for me", so the address and steps are shown right away.
  assert.equal(await page.$('#hub-setup-btn'), null);
  const address = () => page.inputValue('#hub-manual input >> nth=0');
  assert.match(
    await address(),
    /^http:\/\/127\.0\.0\.1:\d+\/api\/hub\/in\/radarr\/radarr\?token=mohub_/,
    "this computer's address by default",
  );
  await page.check('#hub-connect input[name=reach][value=docker]');
  assert.match(
    await address(),
    /^http:\/\/media-ops:\d+\/api\/hub\/in\/radarr\/radarr\?token=mohub_/,
    'the Docker network address',
  );
  await page.fill('#hub-connect input[name=custom]', 'http://192.168.1.10:8484');
  assert.match(
    await address(),
    /^http:\/\/192\.168\.1\.10:8484\/api\/hub\/in\/radarr\/radarr\?token=/,
    'typing picks "Something else"',
  );
  assert.match((await page.textContent('#hub-manual ol')) || '', /Settings → Connect/, 'numbered steps for Radarr');
  await page.click('#modal [data-close]');
  assert.doesNotMatch((await page.textContent('#hub-sources')) || '', /mohub_/, 'the address is not shown again');

  // 2. Where things go: a Discord channel added from the row, then picked
  await page.click('#hub-steps [data-step="2"]');
  await page.click('[data-route="media.added"] [data-change]');
  await page.click('[data-route="media.added"] [data-add-discord]');
  await page.waitForSelector('#notif-form');
  await page.fill('#notif-form [name=name]', '#new-on-plex');
  await page.fill('#notif-form [name=webhookUrl]', 'https://discord.com/api/webhooks/2/y');
  await page.click('#nsave');
  await page.waitForSelector('[data-route="media.added"] input[name=dest]:checked');
  await page.click('[data-route="media.added"] button[type=submit]');
  await page.waitForSelector('[data-route="media.added"] .hub-route-edit', { state: 'detached' });
  await page.waitForSelector('[data-route="media.added"] .hub-to.now');
  assert.equal((await page.textContent('[data-route="media.added"] .hub-route-to'))?.trim(), '#new-on-plex');
  const chan = '#hub-channels li:has-text("#new-on-plex")';
  assert.match(
    (await page.textContent(chan)) || '',
    /gets New movies and episodes/,
    'the channel list says what it gets',
  );
  await page.click('[data-route="media.upgraded"] [data-change]');
  await page.check('[data-route="media.upgraded"] input[name=mode][value=drop]');
  await page.click('[data-route="media.upgraded"] button[type=submit]');
  // It showed "Don't tell me" before saving too: wait for the save itself (the editor closes).
  await page.waitForSelector('[data-route="media.upgraded"] .hub-route-edit', { state: 'detached' });
  await page.waitForSelector('[data-route="media.upgraded"] .hub-to.off');

  // 3. Summaries say what they gather; choosing "In a summary" shows up there
  await page.click('[data-route="media.leaving_soon"] [data-change]');
  await page.check('[data-route="media.leaving_soon"] input[name=mode][value=digest]');
  await page.selectOption('[data-route="media.leaving_soon"] select[name=digest]', 'leaving_weekly');
  await page.click('[data-route="media.leaving_soon"] button[type=submit]');
  await page.waitForSelector('[data-route="media.leaving_soon"] .hub-to.digest');
  await page.click('#hub-steps [data-step="3"]');
  assert.match((await page.textContent('[data-digest="leaving_weekly"]')) || '', /Gathers: Titles leaving soon/);

  // The destination's own form no longer has "Send me": the hub decides.
  await page.click('#notifs .app-card:has-text("#new-on-plex")');
  await page.waitForSelector('#notif-form');
  assert.equal(await page.$('#notif-form fieldset.events'), null);
  assert.ok(await page.isVisible('#notif-form >> text=Where things go'));
  await page.keyboard.press('Escape');

  // Channels: add one from the list, then remove both; a row left with none says so.
  await page.click('#hub-steps [data-step="2"]');
  await page.click('#hub-add-channel');
  await page.fill('#notif-form [name=name]', '#spare');
  await page.fill('#notif-form [name=webhookUrl]', 'https://discord.com/api/webhooks/3/z');
  await page.click('#nsave');
  await page.waitForSelector('#hub-channels li:has-text("#spare") >> text=nothing goes here yet');
  await page.click('#hub-channels li:has-text("#spare") [data-del-chan]');
  await page.waitForSelector('#hub-channels li:has-text("#spare")', { state: 'detached' });
  await page.click(`${chan} [data-del-chan]`);
  await page.waitForSelector(chan, { state: 'detached' });
  assert.match(asked.at(-1) || '', /Remove “#new-on-plex”\?[\s\S]*It gets: New movies and episodes/);
  await page.waitForSelector('[data-route="media.added"] .hub-to.warn');
  assert.equal(await page.$('#notifs .app-card:has-text("#new-on-plex")'), null, 'gone from Notifications too');

  await page.setViewportSize({ width: 375, height: 800 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    0,
    'no sideways scrolling on a phone',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.uncheck('#hub-form [name=enabled]');
  await page.click('#hub-form button[type=submit]');
  await page.waitForSelector('#hub-steps', { state: 'hidden' });
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
