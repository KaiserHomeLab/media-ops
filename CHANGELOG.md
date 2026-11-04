# Changelog

All notable changes to Media Ops. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/): a new feature bumps the middle
number, a fix the last one.

To stay on one version instead of `latest`, use a version tag such as
`ghcr.io/kaiserhomelab/media-ops:1.20` (gets fixes, not new features) or `:1.20.1` (never changes).

## [Unreleased]

## [1.20.1] - 2026-11-04

### Changed

- Notification Hub → Where things go: your channels are listed at the top of the step, each with
  what it gets ("gets New movies and episodes") and **Edit** and **Remove** buttons. **+ Add a
  Discord channel** (there, or in a row) opens one dialog with a **Send test** button; the
  Discord dialog asks for just a channel name and webhook, with how messages look folded away.
- Removing a channel (here or under Notifications) says what will stop going there, and takes
  it out of the hub's rules and summaries, so nothing is left pointing at it.

## [1.20.0] - 2026-11-04

### Fixed

- Notification Hub → Where things go: saving one row no longer closes another row you opened
  while the save was on its way.

### Added

- Notification Hub → Connect apps: connecting Sonarr, Radarr or Seerr asks **how it reaches
  Media Ops**: on the same Docker network (`http://media-ops:8484`, Media Ops' port inside its
  container), through this computer's address, or something else, with the likely answer
  already picked. Media Ops guesses from the address you saved for the app (`http://radarr:7878`
  means Docker) and, when it can see Docker's container list, checks the two really share a
  network (and says how to fix it when they don't) and uses its own container name.
- **Set it up in Radarr for me** (and Sonarr, Seerr): adds the "Media Ops" webhook in the app
  with the right events, using the API key you saved under Apps, after a test message proves
  the app can reach the address. An existing Media Ops webhook is updated, not duplicated; Seerr's
  single webhook is only replaced after you say yes. Adding it by hand stays available, with
  numbered steps for each app.

## [1.19.0] - 2026-11-04

**Before you update:** if Media Ops runs without a settings password, the next time you open
Settings it asks for a **setup code** (printed in the container log, `docker logs media-ops`,
and saved as `setup-code.txt` in your config folder) and the password to set. Until then nothing
can be changed, but the dashboard keeps working. Using the example `docker-compose.yml`? The new
one lists containers through a read-only socket proxy instead of the Docker socket; your current
file keeps working until you switch.

### Changed

- Notification Hub is easier to follow: four steps (Connect apps, Where things go, Summaries,
  Activity). **Where things go** lists every kind of notification in plain words, each sent
  right away to the destinations you tick, put in a summary, or not sent; a **+ Add a Discord
  channel** link right in the list adds another webhook, so different notifications can go to
  different Discord channels. Custom rules (libraries, severity) move under Advanced. With the
  hub on, a destination's own "Send me" boxes give way to it. Summaries say what they gather.
  Activity speaks plainly ("Waiting for “Added to Plex”", "Not sent (set to Don't tell me)").
- **Settings needs a password now: breaking for installs running without one.** The first time
  you open Settings, it asks for a **setup code** and the password you want. Media Ops prints
  the code in its log at every start until a password is set (`docker logs media-ops`, Unraid:
  Docker → media-ops → Logs) and writes it to `setup-code.txt` in the config folder. Until then
  the dashboard is viewable but nothing can be changed: no settings, no actions on your apps.
  Removing the password on purpose (Settings → Security) still works and leaves it open;
  `reset-password` in the container asks for a new one, with a setup code.
- The example `docker-compose.yml` (and the TrueNAS one) lists containers through a read-only
  socket proxy instead of mounting the Docker socket, which gave Media Ops control of the host
  even mounted `:ro`. Media Ops reads the proxy's address from `DOCKER_HOST`. The Unraid
  template no longer maps the socket by default; it has a field for a proxy instead. Existing
  setups keep working until you change them.
- Hiding or showing Errors & warnings entries needs the settings login once a password is set.
- Asking for a password reset code again shows the same code while it's valid (it no longer
  replaces it), and counts toward the login lockout.

- Needs Node 22.13 or newer when run outside Docker (for its built-in SQLite). The Docker image
  already has it.
- Errors & warnings shows only what's wrong right now: an app down, a failing health check, a stuck
  download, an array or pool problem. Lines from apps' logs (and failed downloads in their history)
  often fix themselves, so they wait under a collapsed **Recent log entries** link, the last 24
  hours. The "Errors now" summary tile and the top strip count the same way, and notifications are
  only sent for what's wrong right now, not for log lines.

### Fixed

- Malformed requests get a clear 400 instead of a server error and a stack trace in the log: a
  JSON body that isn't an object (`null`, a list), a metrics token or unsubscribe link with
  multi-byte characters, a dashboard order that isn't a list.
- A settings password longer than 1024 characters is refused when you set it (it could be set,
  but never typed in again).
- Restoring a backup fits the Notification Hub's rules to what was restored: a rule naming a
  removed destination or a digest that isn't there no longer leaves events waiting.
- A digest's **Send now** answers at once and sends in the background, so a long newsletter no
  longer keeps the page waiting.
- Notification Hub: a Seerr webhook with a very long title can no longer tie the server up for
  seconds (the title is now read in linear time and capped). A Discord webhook that keeps
  answering "slow down" now holds a message for at most a minute in all, and digests send in the
  background, so neither delays the background check (history, other alerts). A digest can't
  be sent twice at once (a scheduled run and Send now). Raw webhook payloads are deleted after 7
  days even when the hub is turned off.
- Discord: titles and log lines with Markdown characters show as written ("M*A*S*H" no longer
  turns into "MAS*H"). When Discord says to slow down (HTTP 429), Media Ops waits as long as it
  asks and sends again instead of losing the message; a Discord server error is tried 3 times;
  messages to one webhook go out one at a time, in order.
- Media Review's "nothing has synced" problem no longer sends a new notification every hour while
  it lasts (its message counted the hours, which made it look new each time).
- Diagnostic reports hide Media Review's voter names and friends' notes.

### Added

- `TRUST_PROXY=1`: behind a reverse proxy or Cloudflare Tunnel, the settings-login lockout counts
  each visitor (from `CF-Connecting-IP` or `X-Forwarded-For`) instead of the proxy, so a
  stranger's wrong guesses can't lock you out. Off by default.
- Notification Hub, first part (off until you turn it on; nothing about today's notifications
  changes). Sonarr, Radarr, Seerr and your own scripts can send webhooks to Media Ops, each
  source with its own address and token. Every event, plus what Media Ops already notices
  (an app down, a full disk, a new Problem Report, a title newly Leaving Soon in Media Review),
  is kept for 90 days in `hub.db` next to `config.json`. An upgrade is told apart from a new
  title by the *arr's own flag, not by Plex. Rules, digests and the Settings pages come next;
  the design is in `docs/notification-hub.md`.
- Notification Hub rules: with the hub on, every event goes through an ordered list of rules
  (first match wins): send it now to the destinations you pick, hold it for a digest, or drop
  it. Turning the hub on starts the rules from each destination's current event checkboxes, so
  alerts keep going exactly where they went. The same alert again within 10 minutes is
  suppressed. Alerts held for quiet hours are kept on disk, so a restart no longer loses them.
  If the hub's database can't be written, alerts are sent the usual way.
- Settings → Notification Hub: turn the hub on, and **Activity**, the last 200 events with the
  rule each one matched and what happened to it (sent and to whom, held for quiet hours, saved
  for a digest, dropped, a repeat not sent). Open a row for its details and every send attempt,
  with the error when one failed. Filter by what happened.
- Notification Hub digests: a rule can hold events for a digest, sent on its own schedule (a
  cron line like `0 8 * * *`, in a time zone you choose) as one calm summary, for example
  "Added to Plex · Wednesday, Nov 4" with Movies, TV Shows and Anime sections. Each title shows
  once; a show's episodes fold into one line ("Severance: Season 2, episodes 1–10", "(new
  series)" for a season 1 from its first episode); quality upgrades are never listed, only
  counted in the footer when a rule sends them to the digest. A day with nothing new posts
  nothing. A digest missed while Media Ops was down is sent once when it's back; a send that
  fails keeps its titles for the next one. Two digests come ready (daily "Added to Plex", weekly
  "Leaving soon"), both off until you pick where they go. The daily summary is unchanged.
- Discord: each destination can post under its own name, avatar and colour (Settings →
  Notifications → your Discord destination). Digests arrive as proper Discord messages: the
  title, one embed per section, a small poster embed for each movie on a day with four or fewer,
  and the counts in the footer; a long digest is split to fit Discord's limits.
- Notification Hub email: digests sent to an email destination arrive as an HTML email (posters
  in a grid, the same sections) with a plain-text version. Give a digest a newsletter list and
  each address gets its own copy (nobody sees the others) with an unsubscribe link that needs
  no account, plus the one-click unsubscribe mail apps show. Set the address people open Media
  Ops at under Notification Hub first; the links point there.
- Settings → Notification Hub: add webhook sources (the address with its token is shown once,
  ready to copy), edit the rules (events, libraries, how serious, then send now, hold for a
  digest or drop; reorder them, switch one off), and set up digests (every day or week at a
  time, or any cron schedule, in your time zone, with Preview and Send now). The public address
  for newsletter unsubscribe links is set here too.
- A notification when a friend files a new Problem Report in Media Review: the title, the episode if it's one, what's wrong, who reported it, and their note. It's on by default for every destination, including ones saved before, and can be turned off per destination. Reports already there when Media Ops first sees Media Review aren't sent.
- Media Review's own problems show in Errors & warnings, and are notified like any other app's: a
  background job that failed its last run, a Title it couldn't delete overnight, no sync for over an
  hour, or its Discord bot down. Their hint sends you to Media Review's Status card, not to Media
  Ops' API key. Needs Media Review with `GET /api/v1/health`; older ones just show nothing here.
- Every dashboard card has a color by what it's about, as in Media Review: a colored top edge, an
  icon badge in its heading, and a bar beside each row of a list. Blue for who's watching, red for
  errors, purple for the library, orange for downloads, amber for Media Review, green for the
  server. They never change with the accent. Error and warning rows show their level instead.
- The Media Review card has its own row, right below Errors & warnings, instead of sharing the
  Recently added / Requests row. It can be moved or turned off under Settings → Dashboard like the
  others. A layout you saved before puts it in the same place.
- Media Review: the few titles closest to the bar, on the Review Queue card (teal ▽, "Building
  up"), with who Downvoted them. **Keep now** and **Remove now** decide early (behind the Settings
  password when one is set).
- Media Review: titles your friends have asked to bring back, on the Review Queue card (purple ↺).
  Media Review holds back what it deletes by blocklisting it in Seerr. Each one shows who asked and
  why it went (who Downvoted it, and how often it was Kept before). **Bring back** takes it off
  the blocklist and requests it in Seerr. **Decline** keeps it held back. Both take an optional note
  for the friends who asked (behind the Settings password when one is set).
- Media Review: open Problem Reports on the Review Queue card. Each shows what's wrong, which
  part (the movie, a whole show, a season or one episode) and everyone who reported it, with their
  notes. **Resolve** or **Close** sends the decision back to Media Review, with an optional note
  for the reporters (behind the Settings password when one is set). Needs a Media Review with
  Problem Reports; older ones still show their queue.
- Media Review (optional): a Review Queue card listing the titles your Plex friends have
  Downvoted past Media Review's threshold, with who Downvoted each and how much each vote
  weighed. Add it under Settings → Add app → Media Review. Media Review keeps all the rules;
  Media Ops only shows the queue. **Keep** on the card sends your decision back (behind the
  Settings password when one is set), and the card shows who has watched a title since it was
  queued and whether you've Kept it before. **Remove** sends a title to Media Review's pinned
  "Leaving Soon" collection in Plex, and the card lists what's Leaving Soon with the days left and
  **Keep after all**. Nothing is deleted from Media Ops. When Media Review couldn't delete a
  Leaving Soon title overnight, the card says why. Titles friends sent back with Objections are marked
  "sent back by Objections" with who objected, and Leaving Soon titles show Objections so far.

## [1.18.0] - 2026-10-08

### Added

- Prometheus metrics at `/metrics` (Settings → Metrics, off until you turn it on): apps up,
  latency and updates, streams and bandwidth, download speeds and queues, wanted/missing,
  requests, errors and disk space. Prometheus authenticates with a token Settings creates.
- Cloudflare Tunnel (cloudflared): whether the tunnel is connected to Cloudflare, and whether
  the public addresses it serves (for example Seerr) load from the internet. A badge in the top
  bar shows it at all times, and you're alerted when the tunnel drops or a site stops loading.
  Settings finds cloudflared in Docker.
- Stream map: viewers it can't place now go to Asgard, a gold star in the sky, joined to your
  server by the Bifröst: a glowing beam of light with sparks racing up it. The list beside the
  map still says why each one couldn't be placed. Not a fan? Turn it off in Settings → General.

### Changed

- The demo (`DEMO=1`) now has a Jellyfin server next to Plex and a qBittorrent client, and the
  README screenshots are retaken from it, with new ones of the status page and Appearance.

### Fixed

- Stream map: a viewer plex.tv can't place came back as "Unknown" at 0, 0 and was drawn as a
  dot in the ocean off West Africa; it now counts as having no location.
- Stream map: every viewer shown as "location unknown" now says why (watching on Jellyfin/Emby,
  a private address from a VPN, Tailscale or reverse proxy, no GeoIP match, or a failed
  lookup), with more on hover. The debug report counts the reasons (no addresses).
- On phones the live summary took the title's space even before it appeared.
- The live summary no longer fades in when the device asks for reduced motion.
- Jellyfin and Emby had grey icons in Settings; they have their own colors now.
- TrueNAS: a request containing text outside ASCII (an accented username, say) was sent as a
  malformed WebSocket frame, because its length was counted in characters instead of bytes.

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

[Unreleased]: https://github.com/KaiserHomeLab/media-ops/compare/v1.20.1...HEAD
[1.20.1]: https://github.com/KaiserHomeLab/media-ops/compare/v1.20.0...v1.20.1
[1.20.0]: https://github.com/KaiserHomeLab/media-ops/compare/v1.19.0...v1.20.0
[1.19.0]: https://github.com/KaiserHomeLab/media-ops/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/KaiserHomeLab/media-ops/compare/v1.17.0...v1.18.0
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
