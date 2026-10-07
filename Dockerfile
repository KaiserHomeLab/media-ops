# syntax=docker/dockerfile:1

FROM ghcr.io/linuxserver/baseimage-alpine:3.24

# set version label
ARG BUILD_DATE
ARG VERSION
LABEL build_version="Media Ops version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="KaiserHomeLab"
LABEL org.opencontainers.image.title="Media Ops"
LABEL org.opencontainers.image.description="Live dashboard for a Plex + arr media server"

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
COPY package.json server.js /app/media-ops/
COPY lib/ /app/media-ops/lib/
COPY bin/ /app/media-ops/bin/
COPY public/ /app/media-ops/public/

# add local files
COPY root/ /
# in case the repo was uploaded without exec bits (e.g. via GitHub's web UI)
RUN chmod +x /etc/s6-overlay/s6-rc.d/*-media-ops*/run /usr/local/bin/reset-password

# ports and volumes
EXPOSE 8484
VOLUME /config
