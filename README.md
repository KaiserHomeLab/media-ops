# Media Ops

A live dashboard for a Plex + *arr server. It shows:

- **Services**: which apps are up or down, with version and response time, plus every Docker container on the box.
- **Now playing**: who's streaming what, on which device, direct play vs. transcode (and whether it's hardware), bandwidth, LAN/WAN, and progress.
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

## How it works

`server.js` polls every enabled app in parallel, with a 15-second timeout each. Results are cached for a few seconds so several open tabs don't hammer your server. Slow-changing data is cached longer: Plex library counts and Tautulli stats for 5 minutes, logs for 1 minute. Saving a setting clears the cache, so changes show on the next refresh without a restart.

- Collectors live in `lib/collectors.js`, one function per app.
- The settings-form definition for each app is in `lib/kinds.js`.
- The config store is `lib/config.js`. It writes atomically, with `0600` permissions.
- Settings writes are rejected from other websites (Origin check), and the optional password is stored as a scrypt hash.
