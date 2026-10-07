# Contributing to Media Ops

Thanks for helping out! Bug reports, ideas and pull requests are all welcome. For security
problems, please use [private reporting](SECURITY.md) instead of a public issue.

## Getting started

You need Node.js 22 or newer. There's nothing to install for the app itself (it has no runtime
dependencies); `npm ci` only installs the development tools (ESLint and Prettier).

```bash
git clone https://github.com/KaiserHomeLab/media-ops.git
cd media-ops
npm ci
npm run demo          # http://localhost:8484 with made-up data, no apps needed
```

`npm start` runs it for real, with settings in `./data/config.json`.

## Before you open a pull request

```bash
npm run lint          # ESLint
npm run format        # Prettier (or format:check to only check)
npm test              # unit and server tests
```

CI runs the same checks on every pull request, and `main` only accepts changes that pass
them. Please add or update a test for any change in behaviour, and add user-visible changes to
`CHANGELOG.md` under **Unreleased**.

## How the code is laid out

| Where | What |
|---|---|
| `server.js` | Routes requests and starts everything |
| `lib/poll.js` | Polls every app, builds the overview, runs the background monitor |
| `lib/collectors/` | One file per app (the *arr apps share `arr.js`); each returns `{ version, latency, data }` |
| `lib/kinds.js` | The Settings form for each app |
| `lib/settings-api.js`, `lib/dashboard-api.js` | The JSON API used by the two pages |
| `lib/auth.js`, `lib/web.js` | Login sessions and lockout; security headers, JSON and static files |
| `public/js/` | The dashboard, as native ES modules (no build step) |
| `public/settings.js` | The Settings page |
| `test/` | Tests (`node --test`), with fake app servers in `test/helpers.js` |

**Adding an app** touches a few places: a collector in `lib/collectors/` (exported from
`index.js`), its form in `lib/kinds.js`, a renderer in `public/js/`, demo data in
`lib/demo.js`, and a test in `test/collectors.test.js` using `fakeServer()`.

## Rules that keep it safe

- **No runtime dependencies.** Node's standard library only; the browser loads only our own
  files.
- **Secrets never reach the browser.** Fields with `type: 'secret'` are stripped before
  anything is sent, and a saved key is only ever sent to the address it was saved for.
- **Escape everything from an app** before it goes into HTML: `esc()` for text, `n0()` or
  `num()` for numbers, `safeHref()` for links. The pages run under a strict Content Security
  Policy: no inline scripts or `on…=` handlers.
- **Validate anything from the browser** before it goes into an app's URL.
- **Don't follow redirects with a secret attached.**
- Every source file starts with the `SPDX-License-Identifier: MIT` header.

[SECURITY.md](SECURITY.md) explains these in more detail.

## Commits and pull requests

- Keep each pull request to one change; it's squash-merged into a single commit on `main`.
- Write the title as what the change does ("Show TrueNAS app updates"), and explain the why in
  the description.
- Never put real API keys, tokens, IP addresses, server names or personal data in code, tests,
  fixtures or screenshots. Test fixtures use made-up values (`example.com`, documentation IP
  ranges like `198.51.100.x`).

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
