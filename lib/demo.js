// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Fake data in the exact shape the real collectors return, so the UI can be tried without a server.

const GB = 1024 ** 3, TB = 1024 ** 4, DAY = 864e5;
const start = Date.now();
const wobble = (base, spread, period = 7000, phase = 0) =>
  Math.max(0, base + spread * Math.sin((Date.now() + phase) / period));
// Fixed timestamps (relative to server start) so log lines keep the same identity between refreshes.
const ago = mins => new Date(start - mins * 60e3).toISOString();
const iso = offsetDays => new Date(Date.now() + offsetDays * DAY).toISOString();

function stream(s, i) {
  const offset = (s.offset + (Date.now() - start)) % s.duration;
  return { id: String(i), thumb: null, hw: s.decision === 'Transcode', ...s, offset };
}

const STREAMS = [
  { user: 'casey', player: 'Living Room', product: 'Plex for Apple TV', platform: 'tvOS', state: 'playing', local: true,
    type: 'episode', title: 'Severance', subtitle: 'S02E07 · Chikhai Bardo', offset: 21 * 60e3, duration: 52 * 60e3,
    decision: 'Direct Play', resolution: '4k', videoCodec: 'hevc', audioCodec: 'eac3', container: 'mkv', bitrate: 24800, bandwidth: 26100, sessionId: 'demo-1' },
  { user: 'alex', player: 'Pixel 9', product: 'Plex for Android', platform: 'Android', state: 'playing', local: false,
    type: 'movie', title: 'Dune: Part Two', subtitle: '2024', offset: 88 * 60e3, duration: 166 * 60e3,
    geo: { city: 'Denver', region: 'Colorado', country: 'United States', code: 'US', lat: 39.74, lon: -104.99 },
    decision: 'Transcode', transcodeSpeed: 2.4, resolution: '4k', videoCodec: 'hevc', audioCodec: 'truehd', container: 'mkv', bitrate: 58200, bandwidth: 6000,
    reason: 'quality limit 4K → 720p · audio TRUEHD → AAC', fourKTranscode: true, hwName: 'Intel (QuickSync)', sessionId: 'demo-2' },
  { user: 'sam', player: 'Firefox', product: 'Plex Web', platform: 'Linux', state: 'paused', local: false,
    type: 'episode', title: 'The Bear', subtitle: 'S03E02 · Next', offset: 9 * 60e3, duration: 31 * 60e3,
    geo: { city: 'Toronto', region: 'Ontario', country: 'Canada', code: 'CA', lat: 43.65, lon: -79.38 },
    decision: 'Direct Stream', resolution: '1080', videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', bitrate: 7400, bandwidth: 7800,
    reason: 'remux MP4 → MPEGTS (direct stream)', sessionId: 'demo-3' },
  { user: 'jordan', player: 'Roku Ultra', product: 'Plex for Roku', platform: 'Roku', state: 'playing', local: false,
    type: 'episode', title: 'Shōgun', subtitle: 'S01E05 · Broken to the Fist', offset: 37 * 60e3, duration: 58 * 60e3,
    geo: { city: 'London', region: 'England', country: 'United Kingdom', code: 'GB', lat: 51.51, lon: -0.13 },
    decision: 'Direct Play', resolution: '1080', videoCodec: 'h264', audioCodec: 'eac3', container: 'mkv', bitrate: 9800, bandwidth: 10400, sessionId: 'demo-4' },
  { user: 'casey', player: 'Office', product: 'Plexamp', platform: 'macOS', state: 'playing', local: true,
    type: 'track', title: 'Radiohead', subtitle: 'Reckoner — In Rainbows', offset: 2 * 60e3, duration: 4.8 * 60e3,
    decision: 'Direct Play', audioCodec: 'flac', container: 'flac', bitrate: 1011, bandwidth: 1100, sessionId: 'demo-5' },
];

function playsByDate() {
  const dates = [], tv = [], movies = [], music = [];
  for (let d = 29; d >= 0; d--) {
    const dt = new Date(Date.now() - d * DAY);
    dates.push(dt.toISOString().slice(0, 10));
    const weekend = [0, 5, 6].includes(dt.getDay()) ? 1.6 : 1;
    const n = k => Math.round((k + (Math.sin(d * 1.7 + k) + 1) * k * 0.6) * weekend);
    tv.push(n(6)); movies.push(n(2)); music.push(n(3));
  }
  return { dates, series: [{ name: 'TV', data: tv }, { name: 'Movies', data: movies }, { name: 'Music', data: music }] };
}

const disks = [
  { path: '/data/media', label: 'media', freeSpace: 9.1 * TB, totalSpace: 43.6 * TB },
  { path: '/data/downloads', label: 'scratch', freeSpace: 612 * GB, totalSpace: 1.8 * TB },
  { path: '/config', label: 'nvme', freeSpace: 188 * GB, totalSpace: 476 * GB },
];

function overview(realHost) {
  // A believable server for the demo and the README screenshots, not the machine running it.
  const GiB = 1024 ** 3;
  const host = {
    ...realHost, hostname: process.env.HOST_NAME || 'Tower', platform: 'Linux 6.12.54-Unraid', os: process.env.DEMO === 'truenas' ? 'truenas' : 'unraid',
    cpus: 16, cpuModel: '12th Gen Intel(R) Core(TM) i5-12600K', cpu: Math.round(wobble(23, 9, 2600)),
    load: [2.1, 1.8, 1.6].map((v, i) => +wobble(v, 0.4, 3100 + i * 500).toFixed(2)),
    memTotal: 32 * GiB, memUsed: Math.round(wobble(17.4, 0.6, 4100) * GiB), uptime: 23 * 86400 + 4 * 3600,
  };
  const svc = (kind, name, version, extra = {}) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'), kind, name, link: '#', up: true, version,
    latency: Math.round(wobble(18, 10, 3000, name.length * 999)), ...extra,
  });
  return {
    generatedAt: Date.now(),
    demo: true,
    refreshSeconds: 5,
    host,
    disks: [],
    space: demoSpace(start),
    gpus: [{ card: 'card0', vendor: 'Intel', name: 'Intel iGPU', busy: Math.round(wobble(34, 14, 2200)), freqMhz: Math.round(wobble(900, 300, 2200)), maxMhz: 1300 }],
    docker: [
      ['plex', 'plexinc/pms-docker', 'Up 12 days (healthy)'], ['sonarr', 'lscr.io/linuxserver/sonarr', 'Up 12 days'],
      ['radarr', 'lscr.io/linuxserver/radarr', 'Up 12 days'], ['lidarr', 'lscr.io/linuxserver/lidarr', 'Up 12 days'],
      ['sonarr-anime', 'lscr.io/linuxserver/sonarr', 'Up 12 days'], ['prowlarr', 'lscr.io/linuxserver/prowlarr', 'Up 12 days'],
      ['seerr', 'seerr/seerr', 'Up 12 days (healthy)'], ['tautulli', 'lscr.io/linuxserver/tautulli', 'Up 12 days'],
      ['sabnzbd', 'lscr.io/linuxserver/sabnzbd', 'Up 12 days'], ['clonarr', 'ghcr.io/prophetse7en/clonarr', 'Up 6 days'],
      ['media-ops', 'ghcr.io/you/media-ops', 'Up 2 hours (healthy)'],
    ].map(([name, image, status]) => ({
      name, image, status, state: status.startsWith('Up') ? 'running' : 'exited',
      health: /\((healthy|unhealthy)\)/.exec(status)?.[1] || null,
    })),
    services: [
      svc('plex', 'Plex', '1.42.2.10156', {
        data: {
          streams: STREAMS.map(stream),
          home: { city: 'Chicago', region: 'Illinois', country: 'United States', code: 'US', lat: 41.88, lon: -87.63 },
          resources: { hostCpu: wobble(31, 9, 3000), plexCpu: wobble(18, 7, 2600), hostMem: 46, plexMem: 4.1 },
          recentlyAdded: [
            ['episode', 'Andor', 'S02E09 · Welcome to the Rebellion', 0.7], ['movie', 'Sinners', '2025', 2.2], ['episode', 'Frieren: Beyond Journey’s End', 'S02E04 · The Hero’s Statue', 3.1],
            ['episode', 'Slow Horses', 'S04E05 · Hello Goodbye', 5], ['album', 'Double Infinity', 'Big Thief', 9], ['movie', 'Thunderbolts*', '2025', 20],
            ['episode', 'The Last of Us', 'S02E05 · Feel Her Love', 26], ['movie', 'Mickey 17', '2025', 44],
          ].map(([type, title, sub, hoursAgo], i) => ({ id: String(900 + i), type, title, sub, thumb: null, addedAt: start - hoursAgo * 3600e3, library: type === 'movie' ? 'Movies' : type === 'album' ? 'Music' : 'TV Shows' })),
          mapEnabled: true,
          libraries: [
            { title: 'Movies', type: 'movie', count: 2184 },
            { title: 'TV Shows', type: 'show', count: 412, episodes: 18733 },
            { title: 'Anime', type: 'show', count: 96, episodes: 3120 },
            { title: 'Music', type: 'artist', count: 1307, albums: 4210, tracks: 51288 },
            { title: '4K Movies', type: 'movie', count: 361 },
          ],
        },
      }),
      svc('tautulli', 'Tautulli', 'v2.15.3', {
        data: {
          topUsers: [{ name: 'casey', plays: 214 }, { name: 'alex', plays: 131 }, { name: 'sam', plays: 88 }, { name: 'jordan', plays: 41 }, { name: 'riley', plays: 12 }],
          topShows: [{ name: 'Severance', plays: 34 }, { name: 'The Bear', plays: 29 }, { name: 'Shōgun', plays: 22 }, { name: 'Bluey', plays: 19 }, { name: 'Andor', plays: 15 }],
          topMovies: [{ name: 'Dune: Part Two', plays: 9 }, { name: 'Oppenheimer', plays: 6 }, { name: 'Spirited Away', plays: 5 }, { name: 'Heat', plays: 4 }, { name: 'Arrival', plays: 3 }],
          topPlatforms: [{ name: 'tvOS', plays: 201 }, { name: 'Android', plays: 118 }, { name: 'Chrome', plays: 77 }, { name: 'Roku', plays: 52 }, { name: 'iOS', plays: 38 }],
          mostConcurrent: 7,
          playsByDate: playsByDate(),
        },
      }),
      svc('sonarr', 'Sonarr', '4.0.15.2941', {
        data: {
          stats: { series: 508, monitored: 471, continuing: 133, episodes: 21853, missing: 214, size: 21.4 * TB },
          queue: [
            { title: 'Andor S02E09', size: 4.2 * GB, left: 1.1 * GB, progress: 0.74, status: 'downloading', eta: '00:04:12', protocol: 'usenet', client: 'SABnzbd' },
            { title: 'Slow Horses S04E05', size: 2.1 * GB, left: 0, progress: 1, status: 'importPending', protocol: 'usenet', client: 'SABnzbd',
              warning: true, messages: ['No files found are eligible for import in /data/usenet/complete/tv/Slow.Horses.S04E05.1080p.WEB.h264', 'Sample file detected'] },
          ],
          health: [{ type: 'warning', message: 'Indexer NZBgeek is unavailable due to failures for more than 6 hours' }],
          imports: [['Andor S02E09', 0.7, 'WEBDL-2160p'], ['Slow Horses S04E05', 5, 'WEBDL-1080p'], ['The Last of Us S02E05', 26, 'WEBDL-1080p']].map(([title, h, quality]) => ({ title, quality, time: ago(h * 60) })),
          events: [
            { time: new Date().toISOString(), level: 'warn', source: 'Queue', live: true, queueId: 812,
              message: 'Slow Horses S04E05: No files found are eligible for import in /data/usenet/complete/tv/Slow.Horses.S04E05.1080p.WEB.h264', detail: 'Sample file detected' },
            { time: ago(42), level: 'error', source: 'ImportApprovedEpisodes', message: 'Couldn\'t import episode /data/usenet/complete/tv/Andor.S02E08/andor.s02e08.mkv: Access to the path is denied.',
              detail: 'System.UnauthorizedAccessException: Access to the path \'/data/media/tv/Andor/Season 02\' is denied.\n ---> System.IO.IOException: Permission denied\n   at System.IO.FileSystem.CreateDirectory(String fullPath)\n   at NzbDrone.Common.Disk.DiskProviderBase.CreateFolder(String path)' },
            { time: ago(185), level: 'warn', source: 'Newznab', message: 'NZBgeek: API request limit reached (100/100). Disabling until 00:00 UTC.' },
            { time: ago(60 * 26), level: 'warn', source: 'RssSyncService', message: 'RSS sync: 2 indexers unavailable, results may be incomplete' },
          ],
          disks,
          upcoming: [
            { kind: 'tv', title: 'Andor', sub: 'S02E10 · Who Are You?', date: iso(0.3), hasFile: false },
            { kind: 'tv', title: 'The Last of Us', sub: 'S02E06 · The Price', date: iso(1.2), hasFile: false },
            { kind: 'tv', title: 'Severance', sub: 'S02E08 · Sweet Vitriol', date: iso(2.1), hasFile: false },
            { kind: 'tv', title: 'Bluey', sub: 'S03E49 · Surprise!', date: iso(-0.5), hasFile: true },
            { kind: 'tv', title: 'The Rehearsal', sub: 'S02E03 · Gold Standard', date: iso(4.4), hasFile: false },
          ],
        },
      }),
      svc('sonarr', 'Sonarr Anime', '4.0.15.2941', {
        data: {
          stats: { series: 141, monitored: 138, continuing: 37, episodes: 4280, missing: 58, size: 6.2 * TB },
          queue: [{ title: 'Frieren S02E04', size: 1.4 * GB, left: 0.9 * GB, progress: 0.36, status: 'downloading', eta: '00:01:50', protocol: 'usenet', client: 'SABnzbd' }],
          health: [],
          disks,
          upcoming: [
            { kind: 'tv', title: 'Frieren: Beyond Journey’s End', sub: 'S02E05 · The Hero’s Statue', date: iso(0.6), hasFile: false },
            { kind: 'tv', title: 'Dandadan', sub: 'S02E13 · Let’s Go Home', date: iso(3.2), hasFile: false },
          ],
          events: [
            { time: ago(95), level: 'warn', source: 'AggregateEpisodes', message: 'Unable to parse absolute episode number from "[SubsPlease] Frieren - 31 (1080p).mkv", falling back to scene mapping' },
          ],
        },
      }),
      svc('radarr', 'Radarr', '5.26.2.10099', {
        data: {
          update: { version: '5.27.0.10142' },
          stats: { movies: 2611, monitored: 2402, onDisk: 2545, missing: 37, size: 18.9 * TB },
          imports: [{ title: 'Sinners (2025)', quality: 'Remux-2160p', time: ago(132) }],
          events: [
            { time: ago(310), level: 'error', source: 'DownloadClient', message: 'SABnzbd: Download Sinners.2025.2160p.UHD.BluRay failed — Aborted, cannot be completed', detail: 'Marked as failed in SABnzbd history. Radarr will search for a replacement release.' },
          ],
          queue: [{ title: 'Sinners (2025)', size: 18.4 * GB, left: 9.7 * GB, progress: 0.47, status: 'downloading', eta: '00:21:40', protocol: 'usenet', client: 'SABnzbd' }],
          health: [],
          disks,
          upcoming: [
            { kind: 'movie', title: 'Mission: Impossible – The Final Reckoning', sub: 'Digital release', date: iso(3.5), hasFile: false },
            { kind: 'movie', title: 'Thunderbolts*', sub: 'Physical release', date: iso(6.1), hasFile: false },
          ],
        },
      }),
      svc('lidarr', 'Lidarr', '2.12.4.4658', {
        data: {
          stats: { artists: 1288, albums: 4310, tracks: 51288, missing: 902, size: 1.6 * TB },
          queue: [], health: [], disks,
          upcoming: [{ kind: 'music', title: 'Big Thief', sub: 'Double Infinity', date: iso(2.7), hasFile: false }],
        },
      }),
      svc('prowlarr', 'Prowlarr', '1.37.0.5076', {
        data: {
          stats: { indexers: 9, enabled: 8, failing: 1, queries: 48211, grabs: 6390, avgResponseMs: 412 }, health: [],
          limits: [
            { name: 'DrunkenSlug', unit: 'day', queries: 212, queryLimit: 1000, grabs: 14, grabLimit: 100, pausedUntil: null },
            { name: 'NZBFinder', unit: 'day', queries: 388, queryLimit: null, grabs: 9, grabLimit: null, pausedUntil: null },
            { name: 'NZBgeek', unit: 'day', queries: 463, queryLimit: 500, grabs: 31, grabLimit: 100, pausedUntil: null },
            { name: 'NZBplanet', unit: 'hour', queries: 37, queryLimit: 40, grabs: 2, grabLimit: 10, pausedUntil: new Date(start + 7 * 60e3).toISOString() },
          ],
          events: [
            { time: new Date().toISOString(), level: 'warn', source: 'Indexer limits', live: true, message: 'NZBgeek has used 90% of its daily API limit', detail: '463 of 500 queries in the last 24 hours' },
            { time: ago(180), level: 'error', source: 'NewznabRequestGenerator', message: 'NZBgeek: HTTP request failed: [429:TooManyRequests] [GET] at [https://api.nzbgeek.info/api?t=tvsearch]' },
          ],
        },
      }),
      svc('seerr', 'Seerr', '3.0.1', {
        data: {
          update: { version: null, behind: 4 },
          stats: { total: 642, movie: 401, tv: 241, pending: 3, approved: 3, declined: 18, processing: 2, available: 615 },
          requests: [
            { id: 641, type: 'movie', title: 'Weapons', year: '2025', is4k: false, seasons: null, requestedBy: 'jordan', createdAt: ago(40) },
            { id: 640, type: 'tv', title: 'Pluribus', year: '2025', is4k: false, seasons: [1], requestedBy: 'sam', createdAt: ago(180) },
            { id: 638, type: 'movie', title: 'One Battle After Another', year: '2025', is4k: true, seasons: null, requestedBy: 'alex', createdAt: ago(60 * 20) },
          ],
        },
      }),
      svc('sabnzbd', 'SABnzbd', '4.5.1', {
        data: {
          client: 'usenet', paused: false, status: 'Downloading', downBps: wobble(62e6, 18e6, 2500), upBps: 0,
          items: [{ title: 'Andor.S02E09.2160p.DSNP.WEB-DL.DDP5.1.HDR.H.265', progress: 0.74, size: 4.2 * GB, eta: '0:04:12', status: 'Downloading' }],
          totals: { day: 61 * GB, week: 412 * GB, month: 1.9 * TB, all: 94 * TB },
          events: [
            { time: ago(312), level: 'error', source: 'Failed download', message: 'Sinners.2025.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos: Aborted, cannot be completed', detail: 'Category: movies' },
            { time: ago(60 * 9), level: 'warn', source: 'Warnings', message: 'Server news.eweka.nl will be ignored for 10 minutes (Too many connections)' },
          ],
        },
      }),
      // DEMO=truenas shows a TrueNAS box instead of Unraid.
      process.env.DEMO === 'truenas' ? svc('truenas', 'TrueNAS', '25.10.1', {
        data: {
          server: 'nas',
          pools: [
            { name: 'tank', status: 'ONLINE', healthy: true, size: 72 * TB, used: 51.8 * TB, free: 20.2 * TB, scan: { kind: 'SCRUB', state: 'SCANNING', progress: 41.6, errors: 0, end: null } },
            { name: 'apps', status: 'ONLINE', healthy: true, size: 1.8 * TB, used: 0.42 * TB, free: 1.38 * TB, scan: { kind: 'SCRUB', state: 'FINISHED', progress: 100, errors: 0, end: start - 3 * 864e5 } },
          ],
          capacity: { total: 73.8 * TB, used: 52.22 * TB },
          disks: [
            ['nvme0n1', 'apps', 2, 48, true], ['nvme1n1', 'apps', 2, 51, true],
            ['sda', 'tank', 18, 38, false], ['sdb', 'tank', 18, 39, false], ['sdc', 'tank', 18, 47, false],
            ['sdd', 'tank', 18, 40, false], ['sde', 'tank', 18, 37, false], ['sdf', 'not in a pool', 4, null, false],
          ].map(([name, role, tb, temp, ssd]) => ({
            name, role, status: 'DISK_OK', model: ssd ? 'Samsung 990 PRO' : 'WDC WUH721818ALE6L4', temp,
            tempWarn: ssd ? 60 : 45, tempCrit: ssd ? 70 : 55, fullWarn: null, fullCrit: null, errors: 0, spinning: null, ssd, size: tb * TB, used: null,
          })),
          apps: [
            ...['plex', 'sonarr', 'sonarr-anime', 'radarr', 'lidarr', 'prowlarr', 'sabnzbd', 'tautulli', 'seerr', 'media-ops'].map(name => ({ name, state: 'RUNNING', upgrade: name === 'radarr' || name === 'seerr' })),
            { name: 'bazarr', state: 'STOPPED', upgrade: false },
          ],
          alerts: 2,
          events: [
            { time: new Date().toISOString(), level: 'warn', source: 'Pool', live: true, message: 'Disk sdc is running hot', detail: '47 °C (warning at 45 °C)' },
            { time: new Date().toISOString(), level: 'warn', source: 'TrueNAS', live: true, message: 'Space usage for pool "tank" is 72%. Optimal pool performance requires used space remain below 80%.' },
            { time: new Date().toISOString(), level: 'warn', source: 'TrueNAS', live: true, message: 'Update available: 25.10.2' },
          ],
        },
      }) : svc('unraid', 'Unraid', '7.2.1', {
        data: {
          server: 'Tower', state: 'STARTED',
          capacity: { total: 43.6 * TB, used: 34.5 * TB, free: 9.1 * TB },
          parity: { status: 'RUNNING', running: true, paused: false, progress: 37, errors: 0, speed: '182.4 MB/s', date: null, duration: null, correcting: true },
          disks: [
            ['parity', 'parity', 18, 36, true, false, null], ['parity2', 'parity', 18, 35, true, false, null],
            ['disk1', 'data', 12, 37, true, false, 0.93], ['disk2', 'data', 12, 46, true, false, 0.88], ['disk3', 'data', 14, 34, false, false, 0.71],
            ['disk4', 'data', 14, null, false, false, 0.52], ['cache', 'cache', 2, 41, true, true, 0.38], ['nvme', 'cache', 1, 52, true, true, 0.61],
          ].map(([name, role, tb, temp, spinning, ssd, full]) => ({
            name, role, status: 'DISK_OK', temp, tempWarn: ssd ? 60 : 45, tempCrit: ssd ? 70 : 55, fullWarn: role === 'parity' ? null : 70, fullCrit: role === 'parity' ? null : 90,
            errors: name === 'disk3' ? 2 : 0, spinning, ssd, size: tb * TB, used: full == null ? null : full * tb * TB,
          })),
          events: [
            { time: new Date().toISOString(), level: 'warn', source: 'Array', live: true, message: 'Disk disk2 is running hot', detail: '46 °C (warning at 45 °C)' },
            { time: new Date().toISOString(), level: 'warn', source: 'Array', live: true, message: 'Disk disk3 has read/write errors', detail: '2 errors since the counters were last reset' },
            { time: new Date().toISOString(), level: 'error', source: 'Array', live: true, message: 'Disk disk1 is nearly full', detail: "93% used (Unraid's critical level is 90%)" },
          ],
        },
      }),
      svc('clonarr', 'Clonarr', 'v2.1.4', {
        data: {
          stats: { instances: 3, profiles: 5, active: 5, withErrors: 1, paused: false,
            lastPull: ago(60 * 5), nextPull: iso(0.8), lastSync: ago(60 * 2), trashCommit: '9f3c2a1' },
          events: [{ time: ago(120), level: 'error', source: 'Sonarr Anime · [Anime] Remux-1080p',
            message: 'Profile sync failed: custom format "Anime Dual Audio" rejected by Sonarr — name already in use' }],
        },
      }),
    ],
  };
}

// "What's using space" for the demo: what lib/space.js would build from real libraries.
function demoSpace(now) {
  const D = 864e5;
  const it = (app, kind, title, year, tb, addedDaysAgo, extra = {}) => ({ app, kind, title, year, size: tb * TB, added: now - addedDaysAgo * D, link: '#', ...extra });
  return {
    biggest: [
      it('Sonarr', 'series', "Grey's Anatomy", 2005, 1.62, 900), it('Sonarr', 'series', 'The Simpsons', 1989, 1.41, 900),
      it('Sonarr', 'series', 'Doctor Who', 2005, 0.98, 700), it('Sonarr', 'series', 'Supernatural', 2005, 0.93, 860),
      it('Sonarr Anime', 'series', 'One Piece', 1999, 0.88, 500), it('Sonarr', 'series', 'Game of Thrones', 2011, 0.71, 880),
      it('Radarr', 'movie', 'The Lord of the Rings: The Return of the King', 2003, 0.12, 640), it('Sonarr', 'series', 'House', 2004, 0.61, 820),
      it('Sonarr', 'series', 'Criminal Minds', 2005, 0.58, 870), it('Sonarr', 'series', 'Severance', 2022, 0.21, 300),
    ].sort((a, b) => b.size - a.size),
    downloaded: {
      total: 1.21 * TB,
      items: [
        { ...it('Sonarr', 'series', 'Andor', 2022, 0, 400), bytes: 0.19 * TB, count: 12 },
        { ...it('Radarr', 'movie', 'Sinners', 2025, 0, 20), bytes: 0.088 * TB, count: 1 },
        { ...it('Sonarr', 'series', 'Ted Lasso', 2020, 0, 9), bytes: 0.071 * TB, count: 10 },
        { ...it('Sonarr', 'series', 'The Last of Us', 2023, 0, 300), bytes: 0.064 * TB, count: 7 },
        { ...it('Sonarr Anime', 'series', "Frieren: Beyond Journey's End", 2023, 0, 200), bytes: 0.031 * TB, count: 4 },
      ],
    },
    cleanup: {
      days: 365, historyDays: 1240, total: 6.4 * TB, count: 41,
      items: [
        { ...it('Sonarr', 'series', 'Criminal Minds', 2005, 0.58, 870), lastPlayed: now - 690 * D, plays: 3 },
        { ...it('Sonarr', 'series', 'Supernatural', 2005, 0.93, 860), lastPlayed: now - 410 * D, plays: 12 },
        { ...it('Sonarr', 'series', 'NCIS', 2003, 0.49, 850), lastPlayed: null, plays: 0 },
        { ...it('Sonarr', 'series', 'Lost', 2004, 0.34, 840), lastPlayed: now - 1010 * D, plays: 7 },
        { ...it('Radarr', 'movie', 'Cleopatra', 1963, 0.09, 700), lastPlayed: null, plays: 0 },
        { ...it('Radarr', 'movie', 'Waterworld', 1995, 0.07, 690), lastPlayed: null, plays: 0 },
      ].sort((a, b) => b.size - a.size),
    },
    tautulli: true,
  };
}

// 24 h of plausible history so the uptime bars, trends and forecasts have something to show.
function history() {
  const now = Date.now(), MIN = 60e3, step = 5 * MIN;
  const start = Math.floor((now - DAY) / step) * step;
  const n = Math.ceil((now - start) / step);
  const streams = [], transcodes = [], kbps = [], downBps = [];
  for (let i = 0; i < n; i++) {
    const hour = new Date(start + i * step).getHours() + new Date(start + i * step).getMinutes() / 60;
    // Quiet overnight, busy in the evening; streams change in whole numbers and hold for a while.
    const evening = Math.max(0, Math.sin(((hour - 13) / 12) * Math.PI)) ** 1.5;
    const s = Math.round(evening * 6 + (Math.floor(i / 9) % 3 === 0 ? 0.6 : 0));
    streams.push(s);
    transcodes.push(Math.min(s, Math.round(s * 0.3)));
    kbps.push(s ? Math.round(s * 9000 + Math.sin(i / 7) * 2500) : 0);
    // A few download bursts (new episodes landing), idle otherwise.
    const burst = [3, 9.5, 19.25, 21].some(hh => Math.abs(hour - hh) < 0.6);
    downBps.push(burst ? Math.round(55e6 + Math.sin(i) * 12e6) : Math.round(4e5 + Math.sin(i / 5) * 3e5));
  }
  const peak = Math.max(...streams), peakAt = start + streams.indexOf(peak) * step;
  const kpeak = Math.max(...kbps), kpeakAt = start + kbps.indexOf(kpeak) * step;
  const cells = (blips = []) => Array.from({ length: 48 }, (_, i) => (blips.includes(i) ? 0.5 : 1));
  const ids = overview({}).services.map(s => s.id);
  return {
    uptime: Object.fromEntries(ids.map(id => [id,
      id === 'clonarr' ? { cells: cells([30, 31]), day: 0.958, week: 0.991 }
        : id === 'prowlarr' ? { cells: cells([12]), day: 0.989, week: 0.997 }
          : { cells: cells(), day: 1, week: 0.9996 }])),
    trends: { start, step, streams, transcodes, kbps, downBps, today: { streams: peak, streamsAt: peakAt, kbps: kpeak, kbpsAt: kpeakAt }, since: start },
    forecasts: {
      '/data/media': { status: 'growing', perDay: 61 * GB, daysToFull: (9.1 * TB) / (61 * GB) },
      '/data/downloads': { status: 'flat', perDay: 0 },
      '/config': { status: 'collecting', days: 2 },
    },
  };
}

module.exports = { overview, history };
