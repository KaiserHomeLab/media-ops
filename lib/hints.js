// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// "How to fix" lines for errors with a well-known cause. Matched against an event's source,
// message and detail; the first match wins, so specific patterns come before general ones.
// Keep each hint to one or two sentences of what to actually do.
'use strict';

const HINTS = [
  [/database is locked/i,
    "Usually the app's /config folder is on the array (/mnt/user) instead of a fast drive. Point /config at the cache or an SSD pool (e.g. /mnt/cache/appdata/<app>), or set the appdata share to stay on cache."],
  [/database disk image is malformed|database corrupt/i,
    "The app's database is damaged. Stop the app and restore the newest backup from its /config/Backups folder (System → Backup in the app)."],
  [/API Request Limit reached|429|Too ?Many ?Requests|hit its (daily|hourly) API limit|used 90% of its (daily|hourly) API limit/i,
    "The indexer's API limit is used up. Set the real limit in Prowlarr (Indexers → edit → API limit) so searches are spread out, and avoid big manual 'search all missing' runs."],
  [/grab limit/i,
    "The indexer's download limit is nearly used up. Prowlarr will pause grabs from it until the window resets."],
  [/unavailable due to failures|disabled (till|until)|due to recent failures/i,
    "The indexer failed several times in a row, so it's paused and retried automatically. If it keeps happening, test it in Prowlarr; the site may be down or the API key expired."],
  [/cross-device link|hardlink/i,
    "Hardlinks need downloads and media on the same filesystem. Give every container one shared /data mount (TRaSH Guides' folder structure) instead of separate /downloads and /media."],
  [/remote path|path .* (does not exist|not found|doesn't exist)|isn't accessible|is not accessible/i,
    "The download client reports a path this app can't see. Mount the same folder at the same path in both containers (one /data mapping), or add a Remote Path Mapping."],
  [/access to the path .* (is )?denied|permission denied|UnauthorizedAccess/i,
    "A permissions problem: the app can't read or write that folder. Check its PUID/PGID (Unraid: 99/100, TrueNAS: 568/568) and fix ownership (Unraid: Tools → New Permissions on that share)."],
  [/No files found are eligible for import|\bsample\b.*\b(only|file)|password[- ]protected|encrypted/i,
    "The download finished but had nothing importable (a sample, a password-protected or a wrong release). Use Replace… to blocklist it and grab another."],
  [/download client .*(unavailable|unable to communicate)|unable to connect to (sabnzbd|qbittorrent|nzbget|transmission|deluge)/i,
    "The app can't reach the download client. Check Settings → Download Clients: use the server's IP or container name, not localhost, and the right port and API key."],
  [/no indexers? (available|are enabled)|all indexers are unavailable/i,
    "No indexers are usable. Check Prowlarr's indexers and that Prowlarr's app sync to this app works (Prowlarr → Settings → Apps → Test)."],
  [/running hot|critically hot/i,
    "Check airflow and fans. Drives run warmer during a parity check or scrub, so watch whether it settles afterwards."],
  [/nearly full|Space usage for pool|% full/i,
    "See 'What's using space' on the dashboard for the biggest titles and the ones nobody watches."],
  [/read\/write errors|scrub .*found .* errors|parity check found/i,
    "Errors on a disk can mean a failing drive or a loose cable. Check its SMART report, reseat cables, and run another check."],
  [/is not started|degraded|faulted|is missing|is disabled/i,
    "A disk or pool needs attention now. Open the server's web UI before writing more data."],
  [/has crashed/i,
    "Open the app's logs in the server's Apps/Docker page; a crash on start is often a bad setting or a full appdata drive."],
  [/Connection refused|ECONNREFUSED/i,
    "Nothing answered at that address. Check the app is running and the port in Settings → Apps."],
  [/timed out|ETIMEDOUT|timeout/i,
    "The app is very slow or unreachable. If it's busy (big library scan, database locked), this usually clears by itself."],
  [/HTTP 401|Unauthorized|refused the API key/i,
    "The API key was rejected. Copy it again from the app and paste it in Settings → Apps."],
];

function hintFor(e) {
  const text = `${e.source || ''} ${e.message || ''} ${e.detail || ''}`;
  for (const [re, hint] of HINTS) if (re.test(text)) return hint;
  return null;
}

module.exports = { hintFor, HINTS };
