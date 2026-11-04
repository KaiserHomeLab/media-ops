# Media Ops: Notification Hub (design spec)

**Status:** Being built, one pull request at a time (see 15. Build plan)
**Date:** 2026-11-03

---

## 1. Problem

Today every app posts to Discord on its own terms:

- Tautulli posts a "New on Plex" message for **every** item it sees, including quality upgrades, so `#new-on-plex` gets spammed whenever Radarr/Sonarr replace files.
- Seerr posts request activity to `#seerr-log`.
- Media Review posts Leaving Soon / owner alerts through its own bot.
- Media Ops already sends health notifications (down/up, errors, disk, temps) with quiet hours and a daily summary.

There is no single place that decides **what is worth posting, where, and when**. Workarounds (Tautulli grace periods, a separate digest container, Plex trash settings) each fix one symptom.

## 2. Goal

Add a **Notification Hub** module to Media Ops that:

1. **Receives** events from every app (webhooks in, plus what Media Ops already polls).
2. **Normalizes** them into one event format.
3. **Classifies** each event with rules: send **now**, hold for a **digest**, or **drop**.
4. **Delivers** to one or more destinations (Discord channels, email, existing push targets), formatted for each.
5. **Batches** held events into scheduled **TL;DR digests** (e.g. "Added to Plex yesterday").

### Non-goals (v1)

- Replacing Media Review's Discord bot (DMs, slash commands stay in Media Review).
- Two-way Discord interaction (buttons, commands) from Media Ops.
- A public web newsletter page. Email + Discord only.

## 3. Where it lives

A new module inside Media Ops, built on what already exists:

| Already in Media Ops | Reused for the hub |
|---|---|
| Notification destinations (Discord, Telegram, ntfy, Pushover, Gotify, email, webhook) | Output layer. Add multiple Discord destinations (one per channel). |
| Quiet hours | Applies to "now" events below a set priority. |
| Daily summary | Generalized into configurable digests. |
| App connections (Sonarr, Radarr, Tautulli, Seerr, Plex) with API keys | Used to enrich events (posters, overviews) and to verify webhook sources. |
| `config.json` in `/config`, settings UI | Hub config lives in the same file, edited from a new **Settings → Notifications → Rules** page. |

Match the existing stack, folder layout and coding conventions in `src/`. Do not add a new container.

## 4. Architecture

```
 Sonarr ─┐                                   ┌─> Discord #new-on-plex   (digest)
 Radarr ─┤   POST /api/hub/in/<source>       ├─> Discord #system-logs   (now, staff)
 Seerr  ─┼──────────────┐                    ├─> Discord #announcements (manual/now)
Tautulli─┤              v                    ├─> Email newsletter       (digest)
MediaRev─┘      ┌───────────────┐            └─> ntfy / Pushover        (now, owner)
                │ 1. Ingest     │                     ^
 Media Ops      │ 2. Normalize  │                     │
 pollers ──────>│ 3. Enrich     │──> 5. Deliver ──────┘
 (health,disk)  │ 4. Classify   │        ^
                └──────┬────────┘        │
                       v                 │
                ┌───────────────┐  6. Digest scheduler
                │ SQLite queue  │──(cron per digest)──┘
                └───────────────┘
```

## 5. Inbound

### 5.1 Endpoints

One endpoint per source so each can have its own parser and token:

| Source | Endpoint | How to configure the source |
|---|---|---|
| Sonarr (incl. anime instance) | `POST /api/hub/in/sonarr/<instance>` | Settings → Connect → Webhook. Events: On Import, On Upgrade, On Health Issue, On Health Restored, On Manual Interaction Required. |
| Radarr | `POST /api/hub/in/radarr/<instance>` | Same as Sonarr. |
| Seerr | `POST /api/hub/in/seerr/<instance>` | Settings → Notifications → Webhook, default JSON payload. |
| Tautulli (later, optional) | `POST /api/hub/in/tautulli/<instance>` | Not in v1: Media Ops already sees streams start by polling. |
| Media Review | (none) | v1: from Media Ops' existing Media Review app, which reads Leaving Soon every poll. v2: an outgoing webhook in Media Review. |
| Generic | `POST /api/hub/in/generic/<instance>` | For scripts, a game server, anything else. Accepts the normalized schema directly. |

`<instance>` is the source's own name (`sonarr`, `sonarr-anime`…). The whole `/api/hub/in/` path answers 404 while the hub is off.

### 5.2 Auth

- Each source gets a random token, shown once in the UI; only its SHA-256 hash is kept (in `config.json`, so backups carry it). A lost token is replaced with **New token**.
- Accepted as an `X-Hub-Token` header, `Authorization: Bearer`, the password of Basic auth (the *arr webhook form's username/password fields) or `?token=`.
- A wrong token gets 401 and is counted in Settings (not put in the errors feed one by one, where anyone who can reach the port could fill it). 20 wrong tokens from one address in 15 minutes and it waits out the window; this is separate from the Settings login lockout.
- No session and no same-origin check: the callers are servers. The dashboard lock doesn't apply to this path.
- Same port as Media Ops (8484). Anyone who publishes Media Ops to the internet (a Cloudflare Tunnel, a reverse proxy) publishes this path too, so the token is what protects it.

### 5.3 Normalized event

Every inbound payload becomes one record:

```json
{
  "id": "uuid",
  "received_at": "2026-11-03T14:02:11Z",
  "source": "radarr",
  "source_instance": "radarr",
  "type": "media.added",
  "severity": "info",
  "media": {
    "kind": "movie",
    "title": "M*A*S*H",
    "year": 1970,
    "library": "Movies",
    "ids": { "tmdb": 651, "imdb": "tt0066026", "tvdb": null },
    "show": null,
    "season": null,
    "episode": null,
    "quality": "Bluray-1080p",
    "poster_url": "https://...",
    "overview": "..."
  },
  "is_upgrade": false,
  "dedupe_key": "movie:tmdb:651",
  "raw": { }
}
```

### 5.4 Event types (v1)

| `type` | Comes from | Notes |
|---|---|---|
| `media.added` | Sonarr/Radarr `Download` with `isUpgrade=false` | The main "new on Plex" event. |
| `media.upgraded` | Sonarr/Radarr `Download` with `isUpgrade=true` | **Never** treated as new. |
| `media.request.created` / `approved` / `available` / `failed` | Seerr `notification_type` | Map `MEDIA_PENDING`, `MEDIA_APPROVED`, `MEDIA_AVAILABLE`, `MEDIA_FAILED`. |
| `media.leaving_soon` | Media Review API poll (v1) | Titles entering Leaving Soon. |
| `media.removed` | Media Review poll / *arr `MovieFileDelete`, `SeriesDelete` | Optional, digest only. |
| `app.down` / `app.up` | Existing Media Ops health poller | Already implemented. Route through the hub. |
| `app.health_issue` / `app.health_restored` | *arr `Health` / `HealthRestored` | |
| `download.failed` / `download.stuck` | Existing Media Ops download-client polling | |
| `system.disk` / `system.temp` | Existing Media Ops checks | |
| `playback.started` | Tautulli (optional) | Off by default. |
| `custom` | Generic endpoint | |

The key fix for the current problem: **upgrade detection uses the *arr `isUpgrade` flag**, not Plex. Plex sometimes treats a replaced file as a brand-new item, which is why Tautulli can't tell the difference.

## 6. Classification and routing

### 6.1 Rule model

Rules are evaluated top to bottom. The first match wins. Each rule:

```json
{
  "name": "New movies and shows go to the morning digest",
  "match": {
    "type": ["media.added"],
    "media.library": ["Movies", "TV Shows", "Anime"]
  },
  "action": "digest",
  "digest": "added_daily",
  "enabled": true
}
```

- `action`: `now` | `digest` | `drop`
- `now` rules list one or more `destinations`.
- `match` supports equality, list membership and simple `not`. No scripting in v1.
- A final catch-all rule (`drop`) is always last and cannot be deleted.

### 6.2 Default rules (ship these)

| # | Match | Action | Destination |
|---|---|---|---|
| 1 | `app.down`, `download.failed`, `system.disk` severity ≥ warning | now | Discord `#system-logs` + owner push |
| 2 | `app.up`, `app.health_restored` | now | Discord `#system-logs` |
| 3 | `media.upgraded` | digest `added_daily` as a footnote count only, **or** drop (UI toggle, default **drop**) | |
| 4 | `media.added` in Movies / TV Shows / Anime | digest `added_daily` | Discord `#new-on-plex`, email newsletter |
| 5 | `media.added` in Music | drop | |
| 6 | `media.request.available` | now | Discord `#seerr-log` (optional DM to requester later) |
| 7 | `media.request.*` (other) | now | Discord `#seerr-log` |
| 8 | `media.leaving_soon` | digest `leaving_weekly` | Discord `#new-on-plex` |
| 9 | `playback.started` | drop | |
| 10 | everything else | drop | |

Quiet hours from existing Media Ops settings hold `now` events with severity below `critical` until quiet hours end, then send them grouped.

## 7. Dedupe and grouping

- **Dedupe key:** movies `movie:tmdb:<id>`. Episodes `episode:tvdb:<series>:S<ss>E<ee>`.
- Within one digest window, the same `dedupe_key` appears **once**. Later events update the stored record (e.g. better quality) instead of adding a row.
- If `media.added` and `media.upgraded` share a key in one window, show it as added only.
- **TV grouping in digests:** collapse episodes by show and season:
  - 1 episode → `Show Name S02E05 "Episode Title"`
  - several in one season → `Show Name: Season 2, episodes 1–8`
  - a whole new show → `Show Name (new series): Season 1`
- **Now** events: suppress the same `dedupe_key` + `type` for 10 minutes (configurable) to stop flapping alerts.

## 8. Digests

### 8.1 Config

```json
"digests": [
  {
    "id": "added_daily",
    "title": "Added to Plex",
    "cron": "0 8 * * *",
    "timezone": "America/Chicago",
    "destinations": ["discord_new_on_plex", "email_newsletter"],
    "skip_if_empty": true,
    "max_items_per_section": 25
  },
  {
    "id": "leaving_weekly",
    "title": "Leaving Plex Soon",
    "cron": "0 10 * * 6",
    "timezone": "America/Chicago",
    "destinations": ["discord_new_on_plex"],
    "skip_if_empty": true
  }
]
```

- The window is "everything queued since this digest last sent". The first run covers the last 24 hours.
- `skip_if_empty`: post nothing on days with nothing new.
- A **Send now** button and a **Preview** button per digest in the UI.

### 8.2 Discord format (`#new-on-plex`)

Use a webhook with branding that matches the server:

- Username, avatar and embed colour set per Discord destination (for example your server's name and icon, and Plex's **`#E5A00D`**).
- Message content: `**Added to Plex** · Tuesday, Nov 3`
- One embed per section, in this order: **Movies**, **TV Shows**, **Anime**. Each line is a title with its year or episode range, linked to the Plex/Seerr page if a public URL is configured.
- If ≤ 4 movies, show each as its own small embed with poster thumbnail and a one-line overview. Otherwise use a compact list.
- Footer: `12 new · 3 upgraded quietly · Request more at requests.example.com`
- Respect Discord limits: ≤ 10 embeds per message, ≤ 6000 characters total, ≤ 4096 per embed description. Split into multiple messages if needed.
- **Escape Discord markdown** in titles (`*`, `_`, `~`, `` ` ``, `|`, `>`). Today's Tautulli posts turn `M*A*S*H` into `MAS*H`.

Example:

```
Added to Plex · Tuesday, Nov 3

MOVIES
• M*A*S*H (1970)
• Caveat (2020)

TV SHOWS
• Severance: Season 2, episodes 1–3
• The Bear S03E01 "Tomorrow"

ANIME
• Frieren (new series): Season 1

4 new · 2 upgraded quietly · Request more at requests.example.com
```

### 8.3 Email format

- HTML email with poster grid and the same sections, plus a plain-text alternative.
- Uses the existing Media Ops email destination (SMTP settings already there).
- Recipient list managed in the UI. Each email has an unsubscribe link that removes the address (no account needed).

## 9. Outbound

- **Discord:** allow **multiple** Discord destinations, each with a name, webhook URL, username, avatar URL and colour. Store webhook URLs like other secrets (masked in UI, excluded from "Copy short report").
- **Rate limiting:** queue per webhook. Back off on HTTP 429 using `retry_after`. Retry 5xx up to 3 times, then log to the errors feed.
- **Email:** existing SMTP destination.
- **Push:** existing ntfy / Pushover / Gotify destinations for owner alerts.
- **Delivery log:** every send attempt is recorded (status, destination, message id) and shown in the UI.

## 10. Storage

SQLite file `/config/hub.db` through Node's built-in `node:sqlite` (no npm dependency; Node 22.13 or newer). Keep `/config` on the cache pool, not `/mnt/user`, the same advice as Media Review.

| Table | Purpose |
|---|---|
| `hub_events` | Normalized events (`id`, `received_at`, `source`, `type`, `severity`, `dedupe_key`, `is_upgrade`, `media_json`, `raw_json`, `rule_name`, `action`, `digest_id`, `status`). |
| `hub_digest_runs` | One row per digest send (`digest_id`, `window_start`, `window_end`, `item_count`, `sent_at`, `status`). |
| `hub_deliveries` | Each outbound attempt (`event_id` or `digest_run_id`, `destination`, `http_status`, `error`, `sent_at`). |
| `hub_sources` | When each source was last heard from, and how often. (The hashed tokens live in `config.json`.) |

Retention: delete `raw_json` after 7 days. Delete events after 90 days.

## 11. UI

Add under **Settings → Notifications**:

1. **Sources:** list each source, its endpoint URL with token (copy button), last event received, and a **Send test** button.
2. **Rules:** ordered list with drag to reorder, enable/disable toggles, and a simple editor (type, library, severity → action/destination/digest).
3. **Digests:** schedule, destinations, **Preview** (renders what would be sent now) and **Send now**.
4. **Destinations:** existing page, extended to allow multiple Discord webhooks.
5. **Activity:** the last 200 events with the rule that matched and what happened (sent / queued / dropped). This is the main debugging tool.

## 12. Migration from the current setup

1. Ship the hub with all rules **disabled** except logging, and watch **Activity** for a few days.
2. In Sonarr, anime-Sonarr and Radarr, add the hub webhook (On Import + On Upgrade + Health).
3. Enable rules 3 and 4 and the `added_daily` digest. Check the first digest in `#new-on-plex`.
4. In Tautulli, **disable** the "New on Plex" Discord agent. Media-added now comes from the hub.
5. Point Seerr's webhook at the hub and remove Seerr's direct Discord agent (or keep it for `#seerr-log` until rules 6–7 are trusted).
6. Move existing Media Ops health notifications onto hub rules 1–2.

## 13. Acceptance criteria

- [ ] A Radarr upgrade of an existing movie produces **no** post in `#new-on-plex` (only a count in the digest footer when that toggle is on).
- [ ] Ten episodes of one season imported overnight appear as **one line** in the morning digest.
- [ ] A day with no new media produces **no** digest post.
- [ ] `M*A*S*H` displays correctly in Discord.
- [ ] An app going down posts to `#system-logs` within 1 minute, outside quiet hours.
- [ ] Hitting a Discord 429 delays and retries without losing the message.
- [ ] Webhook URLs and tokens never appear in logs or the short diagnostic report.
- [ ] Every event is visible in **Activity** with the rule it matched.

## 14. Decisions

Open questions, answered:

1. Upgrades: dropped by default, with a toggle for a footer count ("3 upgraded quietly").
2. Daily digest time: 08:00 in the container's time zone by default (the same as today's daily summary), set per digest.
3. Requester DMs when a request is available: out of scope for v1.
4. Other servers (a game server's up/down, for example): through the generic endpoint, routed by an ordinary rule. Nothing special in v1.
5. A weekly email: digests are configurable, so a weekly one is just another digest. No default.

Made while planning (2026-11-03):

- **Storage:** `node:sqlite`, `/config/hub.db` (section 10).
- **Rollout:** the hub is **off by default** and nothing changes for existing installs. Turning it on creates rules from each destination's current event checkboxes, so alerts keep going where they went; the default rules in 6.2 are added switched off.
- **Tokens:** hashed, shown once (5.2).
- **Media Review:** from Media Ops' existing Media Review app (5.1).
- **Names:** server names, colours, links and channels are settings, never in code.

What the code does that the sections above don't say:

- Events also carry a one-line `summary` (`Added: Severance S02E01 "Hello, Ms. Cobel"`), for Activity and for "now" messages.
- What the background poll already notices becomes hub events too: `app.down`, `app.up`, `app.error`, `app.warning`, `download.failed`, `system.disk`, `system.server` (array, pools, TrueNAS alerts, hot disks), `system.bandwidth`, `playback.started`, `media.problem_report`. Their dedupe key follows what they are about (an app, a disk), not the line.
- `hub.test` (a source's test button) and `hub.unhandled` (an event the hub doesn't use yet, or an old file replaced by an upgrade) are recorded so Activity shows everything that arrived.
- "Now" events wait in `hub.db` (status `pending`) until the next background tick, then go out as one message per destination, at most 10 lines, as Media Ops has always batched. Statuses in Activity: `pending`, `held` (quiet hours), `sent`, `failed`, `suppressed` (the same `dedupe_key` + `type` sent within `flapMinutes`, default 10; 0 turns it off), `queued` (for a digest), `dropped`, `unrouted` (no destination), `skipped` (someone started watching during quiet hours).
- Rule matches can use `type` (a family with `.*`), `source`, `source_instance`, `severity`, `min_severity`, `is_upgrade`, `media.kind` and `media.library`, plus one level of `not`.
- If `hub.db` can't be written, that round's alerts are sent the old way, so nothing is lost.
- Digests (`lib/hub/digests.js`): settings are `{ id, title, enabled, cron, timezone, destinations, skipIfEmpty, maxItemsPerSection, footer }` (camelCase; a blank `timezone` is the container's). The upgrade toggle in 6.2 is just a rule: send `media.upgraded` to the digest and it's counted in the footer, drop it and it isn't. A digest that has never run waits for its next time; one missed while Media Ops was down runs once on start. A run that reaches no destination keeps its titles queued and counts as that slot's run. Events a digest took are `digested` in Activity. Sections: `media.added` by library (Movies, TV Shows, Anime first), other types by kind ("Leaving soon", "Now available"…). "(new series)" means season 1 including episode 1.
- Discord (`lib/discord.js`) is used for every Discord send, alerts included: Markdown is escaped (a backslash before any punctuation is safe in Discord), each destination has an optional name, https avatar and `#RRGGBB` colour, and each webhook has a one-at-a-time queue (429: wait `Retry-After`, up to 5 times, never more than a minute; 5xx: 3 tries). Digest titles link nowhere in v1: Media Ops has no "public address" setting for Plex/Seerr pages.
- Email (`lib/hub/newsletter.js`): a digest to an email destination is HTML plus plain text. A digest's `recipients` (newsletter list, up to 500) each get their own message through that destination's mail server, with `List-Unsubscribe` / `List-Unsubscribe-Post` and a link to `<publicUrl>/hub/unsubscribe?d=…&e=…&s=…`, signed with an HMAC key kept in `config.json` (`hub.secret`, made when first needed, carried by backups). GET asks, POST removes the address from that digest. Without recipients, the destination's own To addresses get one copy, with no unsubscribe link. A newsletter list needs `hub.publicUrl` set.
- Seerr also sends `media.request.declined` and `media.issue.*`. *arr Manual Interaction Required is `download.stuck`.
- Severities are `info`, `warning`, `error`, `critical`. Today's levels map onto them (`warn` is `warning`, `good` is `info`). Nothing is `critical` yet, so quiet hours keep today's "still wake me if an app goes down" option until rules can mark events critical.
- The *arr webhooks don't name a Plex library. Movies go to Movies, Sonarr's anime series type to Anime, other shows to TV Shows, and a source can name its library outright (an anime Sonarr instance). Music (rule 5) needs a Lidarr source, which isn't in v1.

## 15. Build plan

Small pull requests, each usable on its own:

1. Ingest, normalize and store: the endpoints, sources and tokens, `hub.db`, and polled events recorded. Nothing is sent differently. (#59)
2. Rules and "now" delivery, behind the hub switch; flap suppression; quiet hours in the hub. (#60)
3. Activity page in Settings. (#61)
4. Digests: schedules, windows, dedupe and TV grouping, Preview and Send now. (#62)
5. Discord output (per-destination name, avatar, colour; embeds; limits; a queue with retries) (#63) and the email newsletter (HTML, one message per recipient, unsubscribe links).
6. Settings → Notification Hub: sources, rules, digests.
