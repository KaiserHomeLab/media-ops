# Media Ops

A live dashboard for a Plex + *arr server. It shows:

- **Services**: which apps are up or down, with version and response time, plus every Docker container on the box.
- **Now playing**: who's streaming what, on which device, direct play vs. transcode (and whether it's hardware), bandwidth, LAN/WAN, and progress.
- **Stream map**: a world map with a dot for every remote viewer, a line from your server to each one, and local viewers at the home pin. It zooms to fit your viewers, and hovering a dot shows who's watching what. Locations are city-level, from Plex's own GeoIP lookup (no third-party service, and IPs never reach the browser). Your server's location is found automatically from Plex, or you can set it under Settings → General.
- **Errors & warnings**: rolls up to a slim bar when there's nothing to show (so do Downloads, Requests and the map). One feed for the whole stack. It includes:
  - error/warning log lines from Sonarr, Radarr, Lidarr and Prowlarr
  - *arr health checks
  - queue items stuck on import
  - SABnzbd failed downloads and warnings
  - Seerr and Tautulli log errors
  - Clonarr profile-sync failures

  Filter by app or show errors only. Click a row for the full exception.
  - **Dismiss** (✕ on a row, or **Dismiss all**) hides entries on the dashboard only. Nothing is deleted in the app. Dismissals are saved and apply in every browser. A dismissed ongoing problem (health check, unreachable app, stuck download) shows up again if it clears and later comes back. **Show dismissed** / **Restore all** undo it.
  - **Clear log** (select an app first) deletes the log inside the app, after a confirmation. For Sonarr/Radarr/Lidarr/Prowlarr it empties System → Logs; for SABnzbd it clears warnings and failed-download history. Seerr, Tautulli and Clonarr have no API for this, so use Dismiss. If a settings password is set, you need to be logged in.
  - **Re-check** (↻) makes an arr re-run its health checks right away (same as its System → Status button) and refreshes. For other apps it polls them again.
- **Notifications** (Settings → Notifications): Discord, ntfy, Pushover, Gotify or any JSON webhook. Choose per destination which events to send: app down or back up, new errors, new warnings, failed or stuck downloads, a disk over your threshold, someone starting to watch. An app has to fail two checks in a row before "down" is sent, errors that already existed at startup are never sent, and each check sends at most one batched message per destination.
- **Uptime history**: every service tile shows a 24-hour bar (half-hour segments) and its uptime percentage. Hover the tile for the 7-day figure.
- **Trends**: 24-hour charts of streams (with transcodes), stream bandwidth and download speed, plus today's peak.
- **Disk forecast**: "Full in ~N weeks at +X GB/day", from a straight-line fit over the last 30 days. It starts after 3 days of data.
- **Why it's transcoding**: each transcoding stream shows a likely reason (client can't play the codec, quality limit, subtitles being burned in, audio conversion), worked out from what Plex reports. 4K transcodes get a red badge.
- **Unraid**: add it as an app (Settings → Add app → Unraid, with an API key from Unraid's **Settings → Management Access → API Keys**; a read-only *viewer* key is enough; needs Unraid 7.2+ or the Unraid Connect plugin). Shows array state, parity-check progress and history, and every disk's temperature, fill level, spin state and errors. Alerts for disabled or missing disks, hot disks (45/55 °C for hard drives, 60/70 °C for SSDs), disks past Unraid's critical fill level, read/write errors, and parity errors.
- **TrueNAS**: add it as an app (Settings → Add app → TrueNAS; needs TrueNAS 25.04 or newer). Shows every pool's health, used space and scrub/resilver progress, every disk's temperature, your TrueNAS apps (running, stopped, crashed, updates available), and TrueNAS's own active alerts. Alerts for unhealthy pools, scrub errors, hot disks, crashed apps and TrueNAS warnings. It uses TrueNAS's WebSocket API (the REST API was removed in TrueNAS 26) and always connects over `wss://`, because TrueNAS revokes an API key that's ever sent over plain http. Setup:
  1. TrueNAS → Credentials → Users → **Add** a user (e.g. `mediaops`) with the **Read-Only Administrator** role.
  2. Your user menu (top right) → **API Keys** → **Add**, for that user. Copy the key.
  3. In Media Ops, enter the TrueNAS address, the username and the key.
- **Knows where it's running**: on Unraid or TrueNAS, Settings offers to add that server in one click (it reads the host's kernel name, which containers share).
- **GPU and Plex load**: the Host panel shows Plex's own CPU use (from Plex's resource statistics) and your GPU: Intel iGPU and AMD read from the host drivers through `/sys`, Nvidia through `nvidia-smi` when the container uses the Nvidia runtime.
- **Recently added**: the newest posters in Plex, and what Sonarr and Radarr imported in the last two days, with quality.
- **Requests**: pending Seerr/Overseerr/Jellyseerr requests with **Approve** and **Decline** buttons.
- **Upload headroom**: set your internet upload speed under Settings → General and the bandwidth tile shows how much of it remote streams use, with an alert at 85%.
- **Quiet hours and daily digest** (Settings → Notifications): hold alerts overnight and get them as one message in the morning, optionally still sending "app down". The digest is one daily summary: plays, new episodes and movies, disk growth, downtime, errors, pending requests and array health. **Send one now** previews it.
- **Backup and restore** (Settings): download everything as one file, or restore from one. The file includes your API keys, so keep it private.
- **Dashboard login** (Settings → Security): optionally require the settings password to view the dashboard too, for sharing it outside your home.
- **Admin actions** (behind the settings password, if one is set): **Stop** a stream with a message the viewer sees (needs Plex Pass), and for stuck downloads **Retry** the import or **Replace…** it (remove, blocklist, search for another).
- **TV mode**: a full-screen, read-only glance view that fits on one screen with no scrolling. It shows the headline numbers, what's playing, the stream map, services, and errors, downloads and server health when there's something to show. Library, calendar, posters, requests and charts are left out. The mouse pointer hides when idle. Open `http://<server>:8484/?tv=1` on a wall tablet or TV browser to start straight in it.
- **Add to home screen**: install it like an app on your phone, with an icon, full-screen view and shortcuts to TV mode and Settings.
- **What's using space**: the biggest series, movies and artists; what was downloaded in the last 30 days; and, with Tautulli, the movies and shows nobody has watched for a year (adjustable under Settings → General), with how much space they take. It's only a list, nothing is deleted. Each title links to it in Sonarr/Radarr/Lidarr.
- **Indexer limits**: for each Prowlarr indexer, API calls and grabs in Prowlarr's own rolling window (24 hours, or 1 hour) against the limits you set on it, with a warning at 90% and an error at 100%. Shows when Prowlarr has paused an indexer.
- **Updates**: Sonarr, Radarr, Lidarr, Readarr, Prowlarr, Plex, Tautulli and Seerr show a ⬆ badge when a newer version is out (checked every 6 hours), and the header says when a newer Media Ops image is available. Updates are also listed in the daily digest.
- **How to fix**: errors with a well-known cause (database locked, indexer API limit, permissions, hardlinks, unreachable download client, hot disks and more) get a 💡 and a one-line fix when you open them.
- **Library**: Plex library counts, and *arr totals (series, episodes, movies, missing, size on disk).
- **Downloads, Coming up, Watch stats** (Tautulli), **Storage** and **Host**.

## Install on Unraid

The image is `ghcr.io/kaiserhomelab/media-ops:latest`.

**Option A: Unraid template (Docker tab UI)**
1. Save `unraid-template.xml` as `/boot/config/plugins/dockerMan/templates-user/my-media-ops.xml` on the Unraid flash drive.
2. Docker → **Add Container** → Template → **media-ops** → Apply.

**Option B: Docker Compose Manager plugin**: use `docker-compose.yml`.

Then open `http://<unraid-ip>:8484`, click **Settings**, and add your apps.

## Install on TrueNAS

TrueNAS 24.10 and newer run apps with Docker:

1. Create a folder for the settings, e.g. a dataset `tank/apps/media-ops`. Give the `apps` user (568) write access.
2. Apps → **Discover Apps** → ⋮ → **Install via YAML**, and paste `truenas-compose.yml`. Change `tank` to your pool's name.
3. Open `http://<truenas-ip>:8484` → **Settings**. Under General, set the disk paths to your pool (e.g. `/mnt/tank`), then add your apps and **TrueNAS** itself.

## Adding apps

Settings → **Add app** → pick the app → enter its address and API key → **Test** → **Save**.

- Use the server's IP (e.g. `http://192.168.1.10:8989`), not `localhost`. Inside a container, `localhost` refers to the container itself. The form pre-fills the IP of the last app you added.
- Each form says where that app keeps its API key.
- **Save** tests the connection first, like Prowlarr. If the test fails, the button becomes **Save anyway**.
- To run two of the same app (e.g. Sonarr and Sonarr Anime), add Sonarr twice with different names.
- Drag the cards to reorder the dashboard. Click a card to edit, disable or delete it.
- Saved API keys are never sent back to the browser. To keep a key, leave the field blank when editing.
- **Security**: set a password to lock the Settings page. **Do this first**: without one, anyone on your network can change your apps, stop streams or clear logs, and the dashboard shows a reminder until you do. Backups can only be downloaded once a password is set. The dashboard itself stays viewable without logging in unless you turn that on too.
- Changing an app's address means entering its API key again: a saved key is only ever sent to the address it was saved for.
- Docker container list: rather than mounting the Docker socket (root-level access to the host), you can run a read-only [socket proxy](https://github.com/Tecnativa/docker-socket-proxy) with `CONTAINERS=1` and enter its address under Settings → General.

### Forgot the settings password?

You need access to the server itself. Use any one of these:

1. **Forgot password?** on the Settings login screen → **Get a reset code**. The code is written to the container log (Unraid: Docker tab → media-ops icon → **Logs**) and to `password-reset.txt` in the appdata folder. Enter it with a new password, or leave the password blank to remove it. Codes expire after 15 minutes or 5 wrong tries.
2. **Console:** Unraid Docker tab → media-ops icon → **Console**, then run `reset-password`. This removes the password. Locally, run `npm run reset-password`.
3. **Edit the file:** set `"auth": null` in `config.json`. The app picks up the change without a restart.

Settings are stored in `/config/config.json` (i.e. `/mnt/user/appdata/media-ops/config.json`). Back up that folder and you've backed up everything.

## The container

Built like a linuxserver.io image, on their `baseimage-alpine` with the s6-overlay process supervisor:

- The app runs as the unprivileged `abc` user, set by `PUID`/`PGID`. On Unraid, use 99/100 (nobody:users) so files in appdata match your other containers.
- On startup, `/config` is re-owned to that user, so permissions fix themselves.
- If the Docker socket is mounted, `abc` is added to the socket's group automatically. The dashboard only reads from it (container list), but anything with socket access is effectively root on the host, so leave it out if you don't want the container panel.
- Supports [Docker Mods](https://mods.linuxserver.io/) (`DOCKER_MODS=…`) and custom init scripts (`/custom-cont-init.d`), like any linuxserver.io image.
- Logs: `docker logs media-ops`. Shell: `docker exec -it media-ops bash`.

| Variable | Default | |
|---|---|---|
| `PUID` / `PGID` | `911` | User/group the app runs as (Unraid: `99` / `100`, TrueNAS: `568` / `568`) |
| `TZ` | `Etc/UTC` | Time zone, e.g. `America/Chicago` |
| `UMASK` | `022` | File creation mask |
| `HOST_NAME` | container ID | Name shown in the dashboard header |
| `PORT` | `8484` | Web UI port inside the container |
| `DEMO` | | `1` = show fake data |

The s6 service files are in `root/etc/s6-overlay/s6-rc.d/`:
- `init-media-ops-config`: permissions and Docker-socket group.
- `svc-media-ops`: the app itself, with a readiness check.

### History and notifications run in the background

The server keeps checking your apps every refresh interval (at least every 10 s) even with no browser open. Each check records uptime, the trend metrics and daily disk usage to `/config/history.json`, which is saved every few minutes and on shutdown, and sends any notifications. History is kept for 8 days (uptime), 24 hours (per-minute trends) and 180 days (disk usage), so the file stays small.

## How it works

`server.js` polls every enabled app in parallel, with a 15-second timeout each. Results are cached for a few seconds so several open tabs don't hammer your server. Slow-changing data is cached longer: library totals, calendars and Tautulli stats for 5 minutes, logs for 1 minute. Saving a setting clears the cache, so changes show on the next refresh without a restart.

- Collectors live in `lib/collectors.js`, one function per app.
- The settings-form definition for each app is in `lib/kinds.js`.
- The config store is `lib/config.js`. It writes atomically, with `0600` permissions.
- Settings writes are rejected from other websites (Origin check), and the optional password is stored as a scrypt hash.

## Troubleshooting

**Settings → Diagnostics → Run diagnostics** checks every app live and shows each API call it made: address, status, timing and a sample of the reply. **Copy short report** gives you a report you can paste into a GitHub issue or chat; **Download full report** includes each app's replies. Keys, tokens, viewer IP addresses and usernames are removed from it.

## Development

```bash
npm run demo    # fake data on http://localhost:8484 (DEMO=truenas node server.js for TrueNAS)
```

## License

Media Ops is released under the [MIT License](LICENSE).

The Docker image is built on the [linuxserver.io](https://www.linuxserver.io/) Alpine base
image (GPL-3.0) with s6-overlay (ISC) and Node.js (MIT). Those components keep their own
licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). It's not an official
linuxserver.io image.

## Acknowledgements

This dashboard only exists because of the projects it talks to: Sonarr, Radarr, Lidarr,
Readarr, Prowlarr, Bazarr, Tautulli, Seerr/Overseerr/Jellyseerr, SABnzbd, qBittorrent,
Clonarr and TRaSH Guides, Unraid and TrueNAS, plus Plex. Thanks also to linuxserver.io for the base image and
container conventions. Media Ops uses only their public APIs and includes none of their code.
Licenses and links are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Plex and the other app names are trademarks of their respective owners. Media Ops is an
independent project, not affiliated with or endorsed by any of them.

## Security

See [SECURITY.md](SECURITY.md) for how secrets are stored and how to report a vulnerability.
