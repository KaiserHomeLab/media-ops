# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on this repository. I'll reply
there as soon as I can.

## How Media Ops handles your secrets

- API keys and tokens are stored in `/config/config.json` (permissions `0600`) on your
  server, and are never sent back to the browser. The Settings form only shows that one is saved.
- The optional Settings password is stored as a salted scrypt hash. Sessions live in
  memory only. Ten wrong passwords (or reset codes) from one address lock it out for 15 minutes;
  this also covers the "current password" on the change-password form.
- A saved API key or token is only ever sent to the address it was saved for. Changing an app's
  address (or a notification server) requires entering the key again, so nobody who can edit
  settings can redirect a stored key to their own server.
- Password reset needs a one-time code written to the container log and the config folder,
  so only someone with access to the server can reset it.
- Requests that change anything are rejected if they come from another website (Origin and
  Sec-Fetch-Site checks; the session cookie is also SameSite=Strict, and Secure behind https).
- Every page is sent with a strict Content Security Policy (no inline or third-party scripts, no
  injected `<style>` elements), `frame-ancestors 'none'` against clickjacking, `nosniff`,
  `no-referrer`, and `Cross-Origin-Resource-Policy: same-origin` so other sites can't embed
  its responses. Values coming from
  your apps (titles, versions, log lines) are escaped before they're shown, and only http(s)
  links are ever made clickable.
- Actions that change something inside an app (clear its log, stop a stream, retry or replace
  a download) need the settings login when a password is set. Re-check only reads, so it's open,
  but limited to once per 15 seconds per app. IDs sent from the browser must be whole numbers
  before they go into an app's address.
- Plex posters are fetched by the server (so the Plex token never reaches the browser), with
  redirects refused so the token can't be bounced to another host.
- Notification secrets (webhook URLs, tokens, keys) are stored like API keys: in `config.json`,
  never sent back to the browser. Messages go only to the destinations you add.
- The stream map looks up remote viewers' IP addresses with Plex's own GeoIP service
  (plex.tv, authenticated with your Plex token; the same service Tautulli uses). No other
  third party receives them. Only city-level locations reach the browser, never the IPs.
  You can turn the map off under Settings → General.
- **Backups** downloaded from Settings contain your API keys and the password hash, so they can
  only be downloaded once a settings password is set. Store them like a password manager export.
  A restore runs every app and destination through the same checks as the Settings forms, drops
  unknown settings, and keeps the current password if the backup has none.
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
- **TrueNAS** is always reached over `wss://` (TrueNAS revokes API keys sent over plain http).
  TrueNAS ships with a self-signed certificate, so Media Ops trusts it on first use and remembers
  its fingerprint (`known-certs.json`); if the certificate later changes, the connection is
  refused before the key is sent. Testing or saving TrueNAS in Settings trusts a replaced
  certificate. Give Media Ops a user with the read-only administrator role.
- Mounting the Docker socket gives the container root-equivalent access to the host. Media
  Ops only reads the container list, but a bug or compromise in any program with the socket
  could do anything. Safer: run a read-only socket proxy (e.g. `tecnativa/docker-socket-proxy`
  with only `CONTAINERS=1`) and enter its address (`http://socket-proxy:2375`) under Settings →
  General instead, or leave the socket out if you don't need that panel.
- Replies from apps are capped (128 MB per reply, 64 MB per TrueNAS message, 5 MB per poster),
  so a misbehaving app can't exhaust memory. Settings writes are capped at 64 KB (2 MB for a
  restore), and a client gets 30 seconds to send a request.
- Discord messages can't ping `@everyone`, even when they quote an app's log line.
- The image is built by GitHub Actions pinned to exact commits, so a moved tag can't change
  what runs with the publishing token. It's only published after lint, every test and a smoke
  test pass, and `main` only accepts changes through pull requests that pass those checks.
- Each published image carries build provenance (how and from which commit it was built) and an
  SBOM (every package inside). To see them:
  `docker buildx imagetools inspect ghcr.io/kaiserhomelab/media-ops:latest --format '{{ json .Provenance }}'`
  (or `.SBOM`).
- The base image is pinned to an exact digest. Dependabot opens weekly pull requests for newer
  base images, GitHub Actions and the development tools, and CodeQL scans every change for
  security problems.
