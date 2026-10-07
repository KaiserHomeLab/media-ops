'use strict';
// Fake data in the exact shape the real collectors return, so the UI can be tried without a server.

const GB = 1024 ** 3, TB = 1024 ** 4, DAY = 864e5;
const start = Date.now();
const wobble = (base, spread, period = 7000, phase = 0) =>
  Math.max(0, base + spread * Math.sin((Date.now() + phase) / period));
const ago = mins => new Date(Date.now() - mins * 60e3).toISOString();
const iso = offsetDays => new Date(Date.now() + offsetDays * DAY).toISOString();

function stream(s, i) {
  const offset = (s.offset + (Date.now() - start)) % s.duration;
  return { id: String(i), thumb: null, hw: s.decision === 'Transcode', ...s, offset };
}

const STREAMS = [
  { user: 'mitsu', player: 'Living Room', product: 'Plex for Apple TV', platform: 'tvOS', state: 'playing', local: true,
    type: 'episode', title: 'Severance', subtitle: 'S02E07 · Chikhai Bardo', offset: 21 * 60e3, duration: 52 * 60e3,
    decision: 'Direct Play', resolution: '4k', videoCodec: 'hevc', audioCodec: 'eac3', container: 'mkv', bitrate: 24800, bandwidth: 26100 },
  { user: 'alex', player: 'Pixel 9', product: 'Plex for Android', platform: 'Android', state: 'playing', local: false,
    type: 'movie', title: 'Dune: Part Two', subtitle: '2024', offset: 88 * 60e3, duration: 166 * 60e3,
    decision: 'Transcode', transcodeSpeed: 2.4, resolution: '1080', videoCodec: 'hevc', audioCodec: 'truehd', container: 'mkv', bitrate: 18200, bandwidth: 6000 },
  { user: 'sam', player: 'Firefox', product: 'Plex Web', platform: 'Linux', state: 'paused', local: false,
    type: 'episode', title: 'The Bear', subtitle: 'S03E02 · Next', offset: 9 * 60e3, duration: 31 * 60e3,
    decision: 'Direct Stream', resolution: '1080', videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', bitrate: 7400, bandwidth: 7800 },
  { user: 'mitsu', player: 'Office', product: 'Plexamp', platform: 'macOS', state: 'playing', local: true,
    type: 'track', title: 'Radiohead', subtitle: 'Reckoner — In Rainbows', offset: 2 * 60e3, duration: 4.8 * 60e3,
    decision: 'Direct Play', audioCodec: 'flac', container: 'flac', bitrate: 1011, bandwidth: 1100 },
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

function overview(host) {
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
          topUsers: [{ name: 'mitsu', plays: 214 }, { name: 'alex', plays: 131 }, { name: 'sam', plays: 88 }, { name: 'jordan', plays: 41 }, { name: 'riley', plays: 12 }],
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
          events: [
            { time: new Date().toISOString(), level: 'warn', source: 'Queue', live: true,
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
          stats: { movies: 2611, monitored: 2402, onDisk: 2545, missing: 37, size: 18.9 * TB },
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
          events: [{ time: ago(180), level: 'error', source: 'NewznabRequestGenerator', message: 'NZBgeek: HTTP request failed: [429:TooManyRequests] [GET] at [https://api.nzbgeek.info/api?t=tvsearch]' }],
        },
      }),
      svc('seerr', 'Seerr', '3.0.1', {
        data: { stats: { total: 642, movie: 401, tv: 241, pending: 4, approved: 3, declined: 18, processing: 2, available: 615 } },
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

module.exports = { overview };
