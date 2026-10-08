// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
'use strict';
// Every app the dashboard can connect to: what the settings form asks for, and where to find it.

const apiKey = where => ({ key: 'apiKey', label: 'API key', type: 'secret', help: where });

const KINDS = [
  {
    kind: 'plex',
    label: 'Plex',
    group: 'Media server',
    port: 32400,
    fields: [
      {
        key: 'token',
        label: 'Plex token',
        type: 'secret',
        help: 'Open any item in Plex Web → ⋯ → Get Info → View XML, and copy the X-Plex-Token value from the URL.',
        link: 'https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/',
      },
    ],
  },
  {
    kind: 'tautulli',
    label: 'Tautulli',
    group: 'Media server',
    port: 8181,
    fields: [apiKey('Settings → Web Interface → API (tick "Enable API").')],
  },

  {
    kind: 'sonarr',
    label: 'Sonarr',
    group: 'Arrs',
    port: 8989,
    fields: [apiKey('Settings → General → Security → API Key.')],
  },
  {
    kind: 'radarr',
    label: 'Radarr',
    group: 'Arrs',
    port: 7878,
    fields: [apiKey('Settings → General → Security → API Key.')],
  },
  {
    kind: 'lidarr',
    label: 'Lidarr',
    group: 'Arrs',
    port: 8686,
    fields: [apiKey('Settings → General → Security → API Key.')],
  },
  {
    kind: 'readarr',
    label: 'Readarr',
    group: 'Arrs',
    port: 8787,
    fields: [apiKey('Settings → General → Security → API Key.')],
  },
  {
    kind: 'prowlarr',
    label: 'Prowlarr',
    group: 'Arrs',
    port: 9696,
    fields: [apiKey('Settings → General → Security → API Key.')],
  },
  {
    kind: 'bazarr',
    label: 'Bazarr',
    group: 'Arrs',
    port: 6767,
    fields: [apiKey('Settings → General → Security → API Key.')],
  },

  {
    kind: 'seerr',
    label: 'Seerr',
    group: 'Requests',
    port: 5055,
    fields: [apiKey('Settings → General → API Key. (Overseerr and Jellyseerr work too.)')],
  },

  {
    kind: 'sabnzbd',
    label: 'SABnzbd',
    group: 'Downloaders',
    port: 8080,
    fields: [apiKey('Config → General → Security → API Key (the full API key, not the NZB key).')],
  },
  {
    kind: 'nzbget',
    label: 'NZBGet',
    group: 'Downloaders',
    port: 6789,
    fields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        optional: true,
        help: 'Settings → Security → ControlUsername (nzbget unless you changed it). A RestrictedUsername works too.',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'secret',
        optional: true,
        help: 'Settings → Security → ControlPassword.',
      },
    ],
  },
  {
    kind: 'qbittorrent',
    label: 'qBittorrent',
    group: 'Downloaders',
    port: 8080,
    fields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        optional: true,
        help: 'Leave blank if "Bypass authentication for clients on localhost / whitelisted subnets" is on.',
      },
      { key: 'password', label: 'Password', type: 'secret', optional: true },
    ],
  },

  {
    kind: 'transmission',
    label: 'Transmission',
    group: 'Downloaders',
    port: 9091,
    fields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        optional: true,
        help: 'Only if Transmission asks for a login (rpc-authentication-required).',
      },
      { key: 'password', label: 'Password', type: 'secret', optional: true },
    ],
  },
  {
    kind: 'deluge',
    label: 'Deluge',
    group: 'Downloaders',
    port: 8112,
    note: "Use the address of the Deluge Web UI. If it isn't connected to a daemon yet, Media Ops connects it to the first one in its Connection Manager.",
    fields: [
      {
        key: 'password',
        label: 'Web UI password',
        type: 'secret',
        help: 'The password you type to open the Deluge Web UI (deluge unless you changed it).',
      },
    ],
  },

  {
    kind: 'unraid',
    label: 'Unraid',
    group: 'Server',
    port: null,
    note: 'Needs Unraid 7.2+ (or the Unraid Connect plugin). Use the address of the Unraid web UI.',
    fields: [apiKey('Unraid → Settings → Management Access → API Keys → Create. A read-only (viewer) key is enough.')],
  },
  {
    kind: 'truenas',
    label: 'TrueNAS',
    group: 'Server',
    port: null,
    note: 'Needs TrueNAS 25.04 or newer. Use the address of the TrueNAS web UI. Media Ops always connects securely (wss://), even if you type http://, because TrueNAS revokes API keys sent over plain http.',
    fields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        help: 'The TrueNAS user the API key belongs to. Best: a user with the Read-Only Administrator role, just for Media Ops.',
      },
      apiKey('TrueNAS → your user menu (top right) → API Keys → Add, for the user above.'),
    ],
  },
  {
    kind: 'clonarr',
    label: 'Clonarr',
    group: 'Tools',
    port: 6060,
    fields: [{ ...apiKey('Settings → Security → API key.'), optional: true }],
  },
  {
    kind: 'ping',
    label: 'Other (up/down only)',
    group: 'Tools',
    port: null,
    fields: [],
    note: 'Checks that the address answers. Use it for anything without a supported API.',
  },
];

const BY_KIND = Object.fromEntries(KINDS.map(k => [k.kind, k]));
// Older config names that map onto a current kind.
BY_KIND.overseerr = { ...BY_KIND.seerr, kind: 'overseerr', label: 'Overseerr' };
BY_KIND.jellyseerr = { ...BY_KIND.seerr, kind: 'jellyseerr', label: 'Jellyseerr' };

const secretKeys = kind => (BY_KIND[kind]?.fields || []).filter(f => f.type === 'secret').map(f => f.key);

module.exports = { KINDS, BY_KIND, secretKeys };
