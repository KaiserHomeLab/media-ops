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
- The stream map looks up remote viewers' IP addresses with Plex's own GeoIP service
  (plex.tv, authenticated with your Plex token; the same service Tautulli uses). No other
  third party receives them. Only city-level locations reach the browser, never the IPs.
  You can turn the map off under Settings → General.
- The dashboard view itself is **not** password-protected. It's meant for your LAN. Don't
  expose port 8484 to the internet without a reverse proxy that adds authentication.
- Mounting the Docker socket gives the container root-equivalent access to the host. Media
  Ops only reads the container list, but leave the socket out if you don't need that panel.
