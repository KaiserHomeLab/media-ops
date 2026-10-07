# Third-party notices

Media Ops' own source code is MIT-licensed (see [LICENSE](LICENSE)). It has **no npm
dependencies**: the server uses only Node.js's standard library, and the pages are
plain HTML, CSS and JavaScript.

## Included in this repository

| Component | License | Source |
|---|---|---|
| World map land outlines (`public/world-map.js`), generated from Natural Earth 1:110m data | Public domain (Natural Earth); TopoJSON packaging ISC © 2013-2019 Michael Bostock | https://www.naturalearthdata.com/ · https://github.com/topojson/world-atlas |
| Natural Earth projection formula (`public/map-projection.js`) | Published method (Šavrič, Jenny, Patterson & Jenny, 2011); same polynomial as d3-geo (ISC) | https://github.com/d3/d3-geo |

`public/world-map.js` is generated from that data (pre-projected, split at the antimeridian).
The projection code was written for this project.

## Included in the Docker image

The published image (`ghcr.io/kaiserhomelab/media-ops`) is an aggregate of separately
licensed software. Each component keeps its own license; nothing here changes those terms.

| Component | License | Source |
|---|---|---|
| linuxserver.io `baseimage-alpine` (init scripts, `lsiown`, Docker Mods support) | GPL-3.0 | https://github.com/linuxserver/docker-baseimage-alpine |
| s6-overlay (process supervisor) | ISC | https://github.com/just-containers/s6-overlay |
| Alpine Linux base system and packages | various (mostly MIT, BSD, GPL-2.0) | https://pkgs.alpinelinux.org/ |
| Node.js runtime (Alpine `nodejs` package) | MIT, plus bundled dependencies' licenses | https://github.com/nodejs/node/blob/main/LICENSE |

The image's packaging (`Dockerfile` and the s6 service files under `root/`) follows the
linuxserver.io conventions for their images: PUID/PGID, `abc` user, s6-rc service layout.
Those files were written for this project and are MIT-licensed. The linuxserver.io base
image is unmodified; we only add files on top of it. Media Ops is not an official
linuxserver.io image.

## Apps Media Ops talks to

Media Ops contains **no code** from these projects. It only calls their public HTTP APIs
using the address and key you provide. They're listed to credit the projects this
dashboard depends on.

| Project | License | Used for |
|---|---|---|
| [Sonarr](https://github.com/Sonarr/Sonarr) | GPL-3.0 | series stats, queue, calendar, health, logs |
| [Radarr](https://github.com/Radarr/Radarr) | GPL-3.0 | movie stats, queue, calendar, health, logs |
| [Lidarr](https://github.com/Lidarr/Lidarr) | GPL-3.0 | music stats, queue, calendar, health, logs |
| [Readarr](https://github.com/Readarr/Readarr) | GPL-3.0 | book stats, queue, health, logs |
| [Prowlarr](https://github.com/Prowlarr/Prowlarr) | GPL-3.0 | indexer stats, health, logs |
| [Bazarr](https://github.com/morpheus65535/bazarr) | GPL-3.0 | missing-subtitle counts |
| [Tautulli](https://github.com/Tautulli/Tautulli) | GPL-3.0 | watch statistics, logs |
| [Seerr](https://github.com/seerr-team/seerr) / [Overseerr](https://github.com/sct/overseerr) / [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) | MIT | request counts, logs |
| [SABnzbd](https://github.com/sabnzbd/sabnzbd) | GPL-2.0-or-later | queue, speed, totals, warnings, failed downloads |
| [qBittorrent](https://github.com/qbittorrent/qBittorrent) | GPL-2.0-or-later | transfer stats, torrents |
| [Clonarr](https://github.com/ProphetSe7en/clonarr) | MIT | sync-profile stats via its widget API |
| [TRaSH Guides](https://github.com/TRaSH-Guides/Guides) | MIT | (indirectly, through Clonarr) |
| Plex Media Server / plex.tv | proprietary | sessions, libraries, posters; GeoIP lookups for the stream map (`plex.tv/api/v2/geoip`) |

## Trademarks

Plex is a trademark of Plex, Inc. Sonarr, Radarr, Lidarr, Readarr, Prowlarr, Bazarr,
Tautulli, Seerr, Overseerr, Jellyseerr, SABnzbd, qBittorrent, Clonarr, Unraid, TrueNAS and Docker
are names or trademarks of their respective owners. They're used here only to say which
apps Media Ops works with. Media Ops is an independent project, not affiliated with or
endorsed by any of them. The colored app tiles on the Settings page are simple letter
badges, not the projects' logos.
