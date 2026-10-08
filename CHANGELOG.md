# Changelog

All notable changes to Media Ops. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/): a new feature bumps the middle
number, a fix the last one.

To stay on one version instead of `latest`, use a version tag such as
`ghcr.io/kaiserhomelab/media-ops:1.17` (gets fixes, not new features) or `:1.17.0` (never changes).

## [Unreleased]

### Changed

- The demo (`DEMO=1`) now has a Jellyfin server next to Plex and a qBittorrent client, and the
  README screenshots are retaken from it, with new ones of the status page and Appearance.

### Fixed

- On phones the live summary took the title's space even before it appeared.
- Jellyfin and Emby had grey icons in Settings; they have their own colors now.

## [1.17.0] - 2026-10-08

### Added

- Settings → Appearance: light, dark or follow the device; six accent colors; your own title
  and logo (PNG, JPEG or WebP); and a separate light/dark choice for the status page, which
  also shows your logo. Applied by the server before the page loads, so there's no flash of
  the default look.
- A live summary in the top bar (streams, download speed, apps up, errors) that appears once
  you scroll past the summary row. Click one to jump to its card. Phones get a short version;
  TV mode hides it; Settings → Appearance can turn it off.

### Fixed

- In light mode the amber accent was too faint to read as text (3.2:1). It's darker now
  (4.7:1), and buttons on it use white text.
- The "new version" badge linked to a section of the README that no longer exists; it now
  opens the release notes.

## [1.16.0] - 2026-10-08

### Added

- Jellyfin and Emby support: streams (with why each one transcodes), Stop, libraries, recently
  added with posters, update badge, history and notifications, just like Plex. You can run
  more than one media server at once. Jellyfin and Emby viewers aren't geolocated (that would
  send their addresses to plex.tv), so they show on the stream map without a location.
- NZBGet, Transmission and Deluge as download clients, next to SABnzbd and qBittorrent: speeds
  and queue on the dashboard, failed NZBGet downloads and log warnings in the errors list.
- Telegram and email notifications. Email works with any mail server (Gmail, Fastmail, your
  own): the password is only ever sent over an encrypted connection.
- A public status page (`/status`) to share with the people who use your server: whether each
  app you pick is up and its uptime over the last day, plus an optional notice. Off until you
  turn it on under Settings → Status page.
- Settings finds your apps in Docker: supported apps running in containers are listed under
  Apps, and clicking one opens the form with its name and address filled in. Uses the same
  Docker access as the containers panel.
- Settings → Dashboard: turn cards off and change the order of the rows. Saved on the server,
  so every screen and TV mode use the same layout.
- Stuck downloads can be fixed automatically (off unless you turn it on under Settings → Stuck
  downloads): when an *arr flags a download as stuck and it stays that way, Media Ops has the
  app re-check it, then replaces it with another release. At most 3 per app per hour, with a
  notification for each.
- Torrents in an error state (missing files, disk full, tracker errors) show up in the errors
  list and in "failed or stuck downloads" notifications, for every torrent client.

### Changed

- The update check now asks GitHub for the latest release instead of reading the code on the
  main branch, so it only offers versions that have actually been released. Versions 1.15.1
  and older look in the old place and won't show the "new version" notice any more; update
  once (or let your usual update tool do it) and it works again.
- The repository is reorganised: the source code is in `src/`, and the top level only has
  what you need to install Media Ops.

### Fixed

- Testing a qBittorrent login in Settings with a different password could pass by reusing the
  session from the saved one.

### Security

- A failed Discord notification could show the webhook's token in Settings and the log (it's
  part of the address in the error). Saved secrets are now blanked out of every send error.

## [1.15.1] - 2026-10-08

### Security

- After logging in, Settings could be tricked into sending you to another website by a crafted
  link (`/settings?next=/\evil.example`). It now only goes back to pages on this site.
- Location names from plex.tv are decoded correctly (an escaped `&amp;quot;` was decoded twice),
  TrueNAS alert text can't keep stray `<` `>` characters, and static files are read safely even
  while they're being replaced. Found by CodeQL.

## [1.15.0] - 2026-10-08

### Added

- Versioned images: `:1.15.0` and `:1.15` next to `latest`, so you can pin a version or roll back.
- Every release has notes on GitHub, and every image carries a signed record of how it was built
  (provenance) and a list of everything inside it (SBOM). See [SECURITY.md](.github/SECURITY.md).

### Changed

- Running without Docker now needs Node.js 22 or newer (Node 20 is end-of-life). The Docker image
  is unaffected.

### Internal

- The code is split into small modules, linted (ESLint), formatted (Prettier), and every change
  is tested in CI before an image is built. Dependabot keeps dependencies current and CodeQL
  scans for security problems.

## [1.14.2] - 2026-10-07

### Changed

- The interface uses the Inter typeface, bundled with the app (nothing loads from other sites).

## [1.14.1] - 2026-10-07

### Security

- The Plex poster proxy no longer follows redirects, so the Plex token can't be sent elsewhere.
- Password checks no longer pause the server; the lockout also covers changing the password.
- "Re-check" is limited to once per 15 seconds per app; IDs sent to apps must be whole numbers.
- Stricter browser security headers, request timeouts, and Discord messages can't ping `@everyone`.

### Changed

- Faster page loads: static files are compressed once instead of on every request.

## [1.14.0] - 2026-10-07

### Added

- Install guides for Linux, Windows, macOS, Synology, QNAP, Portainer and Proxmox.
- Detects the platform it runs on; on Windows and Mac, CPU and memory are labelled as Docker's VM.
- Settings suggests `host.docker.internal` instead of `localhost`, and explains a failed test at a
  `localhost` address.

## [1.13.0] - 2026-10-07

### Security

- Strict Content Security Policy and other security headers, login lockout after 10 wrong
  passwords, saved keys only sent to the address they were saved for, backups need a password.

## [1.12.0] - 2026-10-07

### Added

- "What's using space": biggest titles, what was downloaded this month, and what nobody watches.
- Indexer API limits from Prowlarr, update badges for every app, and how-to-fix tips on errors.

## [1.11.0] - 2026-10-07

### Changed

- TV mode always fits on one screen and shows only what matters at a glance.

## [1.10.0] - 2026-10-07

### Added

- TrueNAS support (pools, disks, apps, alerts), and detection of Unraid or TrueNAS.

## [1.9.0] - 2026-10-07

### Changed

- Errors, downloads and requests fold away when empty; library tiles stretch to fill the row.

## [1.8.0] - 2026-10-07

### Added

- Unraid array and disks, GPU and Plex load, recently added, Seerr requests, upload headroom,
  quiet hours, daily digest, backup and restore, and an optional dashboard login.

## [1.7.0] - 2026-10-07

### Added

- Diagnostics page with a shareable, redacted debug report.

## [1.6.0] - 2026-10-07

### Added

- Notifications (Discord, ntfy, Pushover, Gotify, webhooks), uptime history, 24-hour trends, disk
  full forecasts and transcode reasons.

## [1.5.0] - 2026-10-07

### Added

- Stream map: where your viewers are watching from.

## [1.4.0] - 2026-10-07

### Added

- Settings password recovery with a one-time code.

## [1.3.0] - 2026-10-07

### Added

- Errors feed: dismiss entries, clear an app's log, and re-run its health checks.

## [1.2.0] - 2026-10-07

First public release.

[Unreleased]: https://github.com/KaiserHomeLab/media-ops/compare/v1.17.0...HEAD
[1.17.0]: https://github.com/KaiserHomeLab/media-ops/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/KaiserHomeLab/media-ops/compare/v1.15.1...v1.16.0
[1.15.1]: https://github.com/KaiserHomeLab/media-ops/compare/v1.15.0...v1.15.1
[1.15.0]: https://github.com/KaiserHomeLab/media-ops/releases/tag/v1.15.0
[1.14.2]: https://github.com/KaiserHomeLab/media-ops/commit/b0bb6a9
[1.14.1]: https://github.com/KaiserHomeLab/media-ops/commit/478a5c7
[1.14.0]: https://github.com/KaiserHomeLab/media-ops/commit/0485c7b
[1.13.0]: https://github.com/KaiserHomeLab/media-ops/commit/d8f31cd
[1.12.0]: https://github.com/KaiserHomeLab/media-ops/commit/36df7b9
[1.11.0]: https://github.com/KaiserHomeLab/media-ops/commit/e567e7f
[1.10.0]: https://github.com/KaiserHomeLab/media-ops/commit/a00dd90
[1.9.0]: https://github.com/KaiserHomeLab/media-ops/commit/14f33ce
[1.8.0]: https://github.com/KaiserHomeLab/media-ops/commit/c198807
[1.7.0]: https://github.com/KaiserHomeLab/media-ops/commit/f266ff1
[1.6.0]: https://github.com/KaiserHomeLab/media-ops/commit/0515984
[1.5.0]: https://github.com/KaiserHomeLab/media-ops/commit/fc43759
[1.4.0]: https://github.com/KaiserHomeLab/media-ops/commit/b921778
[1.3.0]: https://github.com/KaiserHomeLab/media-ops/commit/c0241e2
[1.2.0]: https://github.com/KaiserHomeLab/media-ops/commit/c1f3f1a
