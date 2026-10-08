# Changelog

All notable changes to Media Ops. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/): a new feature bumps the middle
number, a fix the last one.

To stay on one version instead of `latest`, use a version tag such as
`ghcr.io/kaiserhomelab/media-ops:1.15` (gets fixes, not new features) or `:1.15.0` (never changes).

## [Unreleased]

### Changed

- The update check now asks GitHub for the latest release instead of reading the code on the
  main branch, so it only offers versions that have actually been released. Versions 1.15.1
  and older look in the old place and won't show the "new version" notice any more; update
  once (or let your usual update tool do it) and it works again.
- The repository is reorganised: the source code is in `src/`, and the top level only has
  what you need to install Media Ops.

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

[Unreleased]: https://github.com/KaiserHomeLab/media-ops/compare/v1.15.1...HEAD
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
