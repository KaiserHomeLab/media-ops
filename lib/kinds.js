'use strict';
// Every app the dashboard can connect to: what the settings form asks for, and where to find it.

const apiKey = where => ({ key: 'apiKey', label: 'API key', type: 'secret', help: where });

const KINDS = [
  { kind: 'plex', label: 'Plex', group: 'Media server', port: 32400,
    fields: [{ key: 'token', label: 'Plex token', type: 'secret',
      help: 'Open any item in Plex Web → ⋯ → Get Info → View XML, and copy the X-Plex-Token value from the URL.',
      link: 'https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/' }] },
  { kind: 'tautulli', label: 'Tautulli', group: 'Media server', port: 8181,
    fields: [apiKey('Settings → Web Interface → API (tick "Enable API").')] },

  { kind: 'sonarr', label: 'Sonarr', group: 'Arrs', port: 8989, fields: [apiKey('Settings → General → Security → API Key.')] },
  { kind: 'radarr', label: 'Radarr', group: 'Arrs', port: 7878, fields: [apiKey('Settings → General → Security → API Key.')] },
  { kind: 'lidarr', label: 'Lidarr', group: 'Arrs', port: 8686, fields: [apiKey('Settings → General → Security → API Key.')] },
  { kind: 'readarr', label: 'Readarr', group: 'Arrs', port: 8787, fields: [apiKey('Settings → General → Security → API Key.')] },
  { kind: 'prowlarr', label: 'Prowlarr', group: 'Arrs', port: 9696, fields: [apiKey('Settings → General → Security → API Key.')] },
  { kind: 'bazarr', label: 'Bazarr', group: 'Arrs', port: 6767, fields: [apiKey('Settings → General → Security → API Key.')] },

  { kind: 'seerr', label: 'Seerr', group: 'Requests', port: 5055,
    fields: [apiKey('Settings → General → API Key. (Overseerr and Jellyseerr work too.)')] },

  { kind: 'sabnzbd', label: 'SABnzbd', group: 'Downloaders', port: 8080,
    fields: [apiKey('Config → General → Security → API Key (the full API key, not the NZB key).')] },
  { kind: 'qbittorrent', label: 'qBittorrent', group: 'Downloaders', port: 8080,
    fields: [
      { key: 'username', label: 'Username', type: 'text', optional: true, help: 'Leave blank if "Bypass authentication for clients on localhost / whitelisted subnets" is on.' },
      { key: 'password', label: 'Password', type: 'secret', optional: true },
    ] },

  { kind: 'clonarr', label: 'Clonarr', group: 'Tools', port: 6060,
    fields: [{ ...apiKey('Settings → Security → API key.'), optional: true }] },
  { kind: 'ping', label: 'Other (up/down only)', group: 'Tools', port: null,
    fields: [], note: 'Checks that the address answers. Use it for anything without a supported API.' },
];

const BY_KIND = Object.fromEntries(KINDS.map(k => [k.kind, k]));
// Older config names that map onto a current kind.
BY_KIND.overseerr = { ...BY_KIND.seerr, kind: 'overseerr', label: 'Overseerr' };
BY_KIND.jellyseerr = { ...BY_KIND.seerr, kind: 'jellyseerr', label: 'Jellyseerr' };

const secretKeys = kind => (BY_KIND[kind]?.fields || []).filter(f => f.type === 'secret').map(f => f.key);

module.exports = { KINDS, BY_KIND, secretKeys };
