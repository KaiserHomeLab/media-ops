# Media Ops

A live dashboard for a Plex + *arr server. It shows:

- **Services**: which apps are up or down, with version and response time, plus every Docker container on the box.
- **Now playing**: who's streaming what, on which device, direct play vs. transcode (and whether it's hardware), bandwidth, LAN/WAN, and progress.
- **Stream map**: a world map with a dot for every remote viewer, a line from your server to each one, and local viewers at the home pin. It zooms to fit your viewers, and hovering a dot shows who's watching what. Locations are city-level, from Plex's own GeoIP lookup (no third-party service, and IPs never reach the browser). Your server's location is found automatically from Plex, or you can set it under Settings → General.
- **Errors & warnings**: one feed for the whole stack. It includes:
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
- **Admin actions** (behind the settings password, if one is set): **Stop** a stream with a message the viewer sees (needs Plex Pass), and for stuck downloads **Retry** the import or **Replace…** it (remove, blocklist, search for another).
- **TV mode**: a full-screen, larger, read-only view with a clock. Edit buttons are hidden and the mouse pointer hides when idle. Open `http://<server>:8484/?tv=1` on a wall tablet or TV browser to start straight in it.
- **Add to home screen**: install it like an app on your phone, with an icon, full-screen view and shortcuts to TV mode and Settings.
- **Library**: Plex library counts, and *arr totals (series, episodes, movies, missing, size on disk).
- **Downloads, Coming up, Watch stats** (Tautulli), **Storage** and **Host**.

## Install on Unraid

The image is published to GitHub Container Registry by `.github/workflows/docker.yml` (see "Publishing the image" below).

**Option A: Unraid template (Docker tab UI)**
1. Save `unraid-template.xml` as `/boot/config/plugins/dockerMan/templates-user/my-media-ops.xml` on the Unraid flash drive.
2. Docker → **Add Container** → Template → **media-ops** → Apply.

**Option B: Docker Compose Manager plugin**: use `docker-compose.yml`.

Then open `http://<unraid-ip>:8484`, click **Settings**, and add your apps.

## Adding apps

Settings → **Add app** → pick the app → enter its address and API key → **Test** → **Save**.

- Use the Unraid server's IP (e.g. `http://192.168.1.10:8989`), not `localhost`. Inside a container, `localhost` refers to the container itself. The form pre-fills the IP of the last app you added.
- Each form says where that app keeps its API key.
- **Save** tests the connection first, like Prowlarr. If the test fails, the button becomes **Save anyway**.
- To run two of the same app (e.g. Sonarr and Sonarr Anime), add Sonarr twice with different names.
- Drag the cards to reorder the dashboard. Click a card to edit, disable or delete it.
- Saved API keys are never sent back to the browser. To keep a key, leave the field blank when editing.
- **Security**: set a password to lock the Settings page. The dashboard itself stays viewable without logging in.

### Forgot the settings password?

You need access to the server itself. Use any one of these:

1. **Forgot password?** on the Settings login screen → **Get a reset code**. The code is written to the container log (Unraid: Docker tab → media-ops icon → **Logs**) and to `password-reset.txt` in the appdata folder. Enter it with a new password, or leave the password blank to remove it. Codes expire after 15 minutes or 5 wrong tries.
2. **Console:** Unraid Docker tab → media-ops icon → **Console**, then run `reset-password`. This removes the password. Locally, run `npm run reset-password`.
3. **Edit the file:** set `"auth": null` in `config.json`. The app picks up the change without a restart.

Settings are stored in `/config/config.json` (i.e. `/mnt/user/appdata/media-ops/config.json`). Back up that folder and you've backed up everything.

### Clonarr

The dashboard uses Clonarr's `/api/widget/summary` endpoint. It shows instances, sync profiles, profiles with errors, the last TRaSH pull and the last sync. Sync errors go into the Errors feed. The API key is under Clonarr **Settings → Security**. If your Clonarr build is older than that endpoint, it shows as up/down only and the test result tells you so.

## Publishing the image

1. Create the repo `KaiserHomeLab/media-ops` on GitHub and push this folder to `main`.
2. The **Docker image** workflow builds `linux/amd64` + `linux/arm64` and pushes `ghcr.io/kaiserhomelab/media-ops:latest`. It also pushes a version tag when you push a tag such as `v1.0.0`.
3. In GitHub → your profile → **Packages** → `media-ops` → Package settings, set visibility to **Public** so Unraid can pull it without logging in.

Without GitHub, you can build on the Unraid box directly: copy the folder over and run `docker build -t media-ops .`, then use `media-ops` as the repository in the template.

## Run locally

```bash
npm start          # real mode; settings saved to ./data/config.json
npm run demo       # fake data, to see what the dashboard looks like
```

Requires Node 20+. There are no dependencies to install.

## The container

Built like a linuxserver.io image, on their `baseimage-alpine` with the s6-overlay process supervisor:

- The app runs as the unprivileged `abc` user, set by `PUID`/`PGID`. On Unraid, use 99/100 (nobody:users) so files in appdata match your other containers.
- On startup, `/config` is re-owned to that user, so permissions fix themselves.
- If the Docker socket is mounted, `abc` is added to the socket's group automatically. The dashboard only reads from it (container list), but anything with socket access is effectively root on the host, so leave it out if you don't want the container panel.
- Supports [Docker Mods](https://mods.linuxserver.io/) (`DOCKER_MODS=…`) and custom init scripts (`/custom-cont-init.d`), like any linuxserver.io image.
- Logs: `docker logs media-ops`. Shell: `docker exec -it media-ops bash`.

| Variable | Default | |
|---|---|---|
| `PUID` / `PGID` | `911` | User/group the app runs as (Unraid: `99` / `100`) |
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

`server.js` polls every enabled app in parallel, with a 15-second timeout each. Results are cached for a few seconds so several open tabs don't hammer your server. Slow-changing data is cached longer: Plex library counts and Tautulli stats for 5 minutes, logs for 1 minute. Saving a setting clears the cache, so changes show on the next refresh without a restart.

- Collectors live in `lib/collectors.js`, one function per app.
- The settings-form definition for each app is in `lib/kinds.js`.
- The config store is `lib/config.js`. It writes atomically, with `0600` permissions.
- Settings writes are rejected from other websites (Origin check), and the optional password is stored as a scrypt hash.

## Troubleshooting

**Settings → Diagnostics → Run diagnostics** checks every app live and shows each API call it made: address, status, timing and a sample of the reply. **Copy debug report** gives you a report you can paste into a GitHub issue. Keys, tokens, viewer IP addresses and usernames are removed from it.

## Development

```bash
npm test        # node --test test/  (no dependencies)
npm run demo    # fake data on http://localhost:8484
```

Tests run the collectors against a fake server answering with recorded-style replies (`test/fixtures/`). GitHub Actions runs them on Node 22 and 24 before every image build.

## License

Media Ops is released under the [MIT License](LICENSE).

The Docker image is built on the [linuxserver.io](https://www.linuxserver.io/) Alpine base
image (GPL-3.0) with s6-overlay (ISC) and Node.js (MIT). Those components keep their own
licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). It's not an official
linuxserver.io image.

## Acknowledgements

This dashboard only exists because of the projects it talks to: Sonarr, Radarr, Lidarr,
Readarr, Prowlarr, Bazarr, Tautulli, Seerr/Overseerr/Jellyseerr, SABnzbd, qBittorrent,
Clonarr and TRaSH Guides, plus Plex. Thanks also to linuxserver.io for the base image and
container conventions. Media Ops uses only their public APIs and includes none of their code.
Licenses and links are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Plex and the other app names are trademarks of their respective owners. Media Ops is an
independent project, not affiliated with or endorsed by any of them.

## Security

See [SECURITY.md](SECURITY.md) for how secrets are stored and how to report a vulnerability.
