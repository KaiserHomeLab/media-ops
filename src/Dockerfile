# syntax=docker/dockerfile:1
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 KaiserHomeLab
#
# Media Ops image, built the linuxserver.io way: their Alpine base (s6-overlay, PUID/PGID,
# UMASK, TZ, Docker Mods) plus Node.js and this app. See THIRD-PARTY-NOTICES.md.
# Build from the top of the repo (it needs LICENSE from there): docker build -f src/Dockerfile .

# Pinned to an exact build (the digest) so every image is built from the same base; Dependabot
# opens a PR when linuxserver.io publishes a newer one (they rebuild weekly with security fixes).
FROM ghcr.io/linuxserver/baseimage-alpine:3.24@sha256:f68ac194f40cfe528e5e9549a22623bf4effbfaf93fad834909d2d6c2abd3096

# set version label
ARG BUILD_DATE
ARG VERSION
LABEL build_version="Media Ops version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="KaiserHomeLab"
LABEL org.opencontainers.image.title="Media Ops"
LABEL org.opencontainers.image.description="Live dashboard for a Plex, Jellyfin or Emby + arr media server"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/KaiserHomeLab/media-ops"
LABEL org.opencontainers.image.url="https://github.com/KaiserHomeLab/media-ops"

# environment settings
ENV CONFIG="/config/config.json" \
  PORT="8484" \
  NODE_ENV="production"

RUN \
  echo "**** install runtime packages ****" && \
  apk add --no-cache \
    nodejs && \
  echo "**** cleanup ****" && \
  rm -rf \
    /tmp/*

# app
COPY LICENSE src/package.json src/server.js src/THIRD-PARTY-NOTICES.md /app/media-ops/
COPY src/lib/ /app/media-ops/lib/
COPY src/bin/ /app/media-ops/bin/
COPY src/public/ /app/media-ops/public/

# add local files
COPY src/root/ /
# in case the repo was uploaded without exec bits (e.g. via GitHub's web UI), or checked out
# on Windows with CRLF line endings (s6 can't run a script whose first line ends in \r)
RUN \
  find /etc/s6-overlay/s6-rc.d/*-media-ops* /usr/local/bin/reset-password -type f -exec sed -i 's/\r$//' {} + && \
  chmod +x /etc/s6-overlay/s6-rc.d/*-media-ops*/run /usr/local/bin/reset-password

# lets Docker, Unraid, Synology and Portainer show whether it's healthy
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-8484}/healthz" > /dev/null || exit 1

# ports and volumes
EXPOSE 8484
VOLUME /config
