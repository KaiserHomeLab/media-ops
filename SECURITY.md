# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on this repository. I'll reply
there as soon as I can.

## How Media Ops handles your secrets

- API keys and tokens are stored in `/config/config.json` (permissions `0600`) on your
  server, and are never sent back to the browser. The Settings form only shows that one is saved.
- The optional Settings password is stored as a salted scrypt hash. Sessions live in
  memory only.
- Password reset needs a one-time code written to the container log and the config folder,
  so only someone with access to the server can reset it.
- Requests that change anything are rejected if they come from another website (Origin check).
- Actions that change something inside an app (clear its log, stop a stream, retry or replace
  a download) need the settings login when a password is set. Re-check only reads, so it's open.
- Notification secrets (webhook URLs, tokens, keys) are stored like API keys: in `config.json`,
  never sent back to the browser. Messages go only to the destinations you add.
- The stream map looks up remote viewers' IP addresses with Plex's own GeoIP service
  (plex.tv, authenticated with your Plex token; the same service Tautulli uses). No other
  third party receives them. Only city-level locations reach the browser, never the IPs.
  You can turn the map off under Settings → General.
- **Backups** downloaded from Settings contain your API keys and the password hash. Store them like
  a password manager export. A restore keeps the current password if the backup has none.
- The dashboard view is open on your LAN by default. Turn on **Settings → Security → Also require
  the password to view the dashboard** before exposing it more widely, or put it behind your
  reverse proxy's login (Authelia, Authentik, etc.).
- **Update check**: every 6 hours Media Ops reads its own `package.json` from GitHub
  (`raw.githubusercontent.com`) to see if a newer version is out. It's a plain download; nothing
  about your server is sent. Turn it off under Settings → General.
- Diagnostics reports are redacted (keys, tokens, IPs, emails and usernames removed) so they can
  be shared.
- Without the dashboard login, don't expose port 8484 to the internet unless a reverse proxy in
  front of it adds authentication.
- **TrueNAS** is always reached over `wss://` (TrueNAS revokes API keys sent over plain http). Its
  certificate isn't verified, because TrueNAS ships with a self-signed one; use it on your LAN, and
  give Media Ops a user with the read-only administrator role.
- Mounting the Docker socket gives the container root-equivalent access to the host. Media
  Ops only reads the container list, but leave the socket out if you don't need that panel.
