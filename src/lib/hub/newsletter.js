// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Notification Hub email: a digest as an HTML email (posters, sections) with a plain-text twin,
// through an email destination's mail server. A digest's newsletter recipients each get their
// own copy (no one sees anyone else's address) with an unsubscribe link that needs no account:
// the link is signed (HMAC with a key only this server knows), and opening it asks before it
// removes the address. Mail apps' one-click unsubscribe (RFC 8058) works too.
'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const smtp = require('../smtp');
const { send } = require('../web');

/** @type {Record<string, string>} */
const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** @param {unknown} s */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ENTITY[c]);

// ------------------------------------------------------------------ signed links
// The key that signs unsubscribe links: made once, kept in config.json, never sent to a browser.
/** @returns {string} */
function secret() {
  const have = config.load().hub?.secret;
  if (have && /^[0-9a-f]{64}$/.test(have)) return have;
  const made = crypto.randomBytes(32).toString('hex');
  config.update(c => ({ ...c, hub: { ...(c.hub || { enabled: false, sources: [] }), secret: made } }));
  return made;
}
/** @param {string} key @param {string} digestId @param {string} email */
const sign = (key, digestId, email) =>
  crypto.createHmac('sha256', key).update(`${digestId}\n${email.toLowerCase()}`).digest('base64url').slice(0, 32);

/** @param {string} base the public address @param {string} key @param {string} digestId @param {string} email */
function unsubscribeUrl(base, key, digestId, email) {
  const q = new URLSearchParams({
    d: digestId,
    e: Buffer.from(email).toString('base64url'),
    s: sign(key, digestId, email),
  });
  return `${base.replace(/\/+$/, '')}/hub/unsubscribe?${q}`;
}

/** @param {URLSearchParams} q @returns {{ digestId: string, email: string } | null} */
function verify(q) {
  const digestId = String(q.get('d') || '');
  const email = Buffer.from(String(q.get('e') || ''), 'base64url').toString('utf8');
  const sig = String(q.get('s') || '');
  // Exactly what sign() makes (32 base64url characters), so the comparison below is byte-for-byte.
  if (!digestId || !smtp.isAddress(email) || !/^[A-Za-z0-9_-]{32}$/.test(sig)) return null;
  const key = config.load().hub?.secret;
  if (!key) return null;
  const want = Buffer.from(sign(key, digestId, email));
  return crypto.timingSafeEqual(want, Buffer.from(sig)) ? { digestId, email } : null;
}

// ------------------------------------------------------------------ the email
/** @param {ReturnType<typeof import('./digests').build>} b @param {string | null} unsubscribeLink */
function html(b, unsubscribeLink) {
  const parts = b.sections.map(s => {
    const items = s.items || [];
    const posters = items.filter(i => i.posterUrl);
    // Titles with posters as a grid (a table: email apps don't do modern CSS), the rest as a list.
    const grid = posters.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0">${chunk(
          posters,
          4,
        )
          .map(
            row =>
              `<tr>${row
                .map(
                  i =>
                    `<td style="padding:0 12px 12px 0;vertical-align:top;width:120px"><img src="${esc(i.posterUrl)}" width="120" alt="" style="display:block;border-radius:6px;width:120px;height:auto"><div style="font-size:13px;margin-top:6px;color:#1a1a19">${esc(i.line)}</div></td>`,
                )
                .join('')}</tr>`,
          )
          .join('')}</table>`
      : '';
    const rest = items.filter(i => !i.posterUrl).map(i => `<li style="margin:2px 0">${esc(i.line)}</li>`);
    if (s.more) rest.push(`<li style="margin:2px 0;color:#6b6a63">…and ${s.more} more</li>`);
    return `<h2 style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b6a63;margin:24px 0 8px">${esc(s.name)}</h2>${grid}${rest.length ? `<ul style="padding-left:20px;margin:0">${rest.join('')}</ul>` : ''}`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(b.title)}</title></head>
<body style="margin:0;padding:24px;background:#f4f3ee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a19">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px">
<h1 style="font-size:20px;margin:0 0 4px">${esc(b.title)}</h1>
${parts.join('\n')}
${b.footer ? `<p style="font-size:13px;color:#6b6a63;margin:24px 0 0">${esc(b.footer)}</p>` : ''}
${unsubscribeLink ? `<p style="font-size:12px;color:#8b8a80;margin:16px 0 0">Don't want these? <a href="${esc(unsubscribeLink)}" style="color:#8b8a80">Unsubscribe</a>.</p>` : ''}
</div></body></html>`;
}
/** @template T @param {T[]} list @param {number} n @returns {T[][]} */
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/** @param {import('../types').Target} t */
const server = t => ({
  host: t.smtpHost,
  port: Number(t.smtpPort) || 587,
  username: t.username,
  password: t.password,
  from: t.from,
});

// One digest to one email destination. With newsletter recipients, each gets a copy with their
// own unsubscribe link (which needs the public address); without, the destination's own To
// addresses get one copy, as for any other notification. Throws when no copy got through.
/** @param {import('../types').Config} cfg @param {import('./digests').Digest} d @param {ReturnType<typeof import('./digests').build>} b @param {{ title: string, lines: string[] }} text @param {import('../types').Target} t */
async function sendDigest(cfg, d, b, text, t) {
  const plain = text.lines.join('\n');
  const recipients = d.recipients || [];
  if (!recipients.length) {
    await smtp.sendMail({
      ...server(t),
      to: t.to,
      fromName: d.title,
      subject: b.title,
      text: plain,
      html: html(b, null),
    });
    return { sent: 1, failed: 0 };
  }
  const base = cfg.hub?.publicUrl;
  if (!base)
    throw new Error('Set the public address under Notification Hub first: every newsletter has an unsubscribe link');
  const key = secret();
  let sent = 0;
  /** @type {string[]} */
  const errors = [];
  for (const to of recipients) {
    const link = unsubscribeUrl(base, key, d.id, to);
    try {
      await smtp.sendMail({
        ...server(t),
        to,
        fromName: d.title,
        subject: b.title,
        text: `${plain}\n\nUnsubscribe: ${link}`,
        html: html(b, link),
        headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      sent++;
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!sent) throw new Error(`No copy went out: ${errors[0]}`);
  return { sent, failed: errors.length };
}

// ------------------------------------------------------------------ unsubscribing
/** @param {string} body */
const page =
  body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title><link rel="stylesheet" href="/style.css"></head>
<body><main style="max-width:480px;margin:15vh auto;padding:0 16px"><section class="card">${body}</section></main></body></html>`;

// GET shows what will happen and asks (link checkers in mail apps open links on their own);
// POST does it, from that page's button or a mail app's one-click unsubscribe. The signed link
// is the permission, so neither needs a login or the same-origin check.
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
async function unsubscribe(req, res, url) {
  const who = verify(url.searchParams);
  /** @param {number} status @param {string} body */
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page(body));
  };
  if (!who)
    return reply(
      400,
      '<h2>This link doesn’t work</h2><p class="hint">It may have been cut short by your mail app. Use the link in the newest email.</p>',
    );
  const digest = (config.load().hub?.digests || []).find(d => d.id === who.digestId);
  if (req.method === 'GET')
    return reply(
      200,
      `<h2>Unsubscribe?</h2><p class="hint">Stop sending “${esc(digest?.title || who.digestId)}” to <b>${esc(who.email)}</b>.</p>
       <form method="post" action="${esc(url.pathname + url.search)}"><button class="btn primary" type="submit">Unsubscribe</button></form>`,
    );
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
  req.resume(); // the body ("List-Unsubscribe=One-Click", or the form's) carries nothing we need
  config.update(c => ({
    ...c,
    hub: c.hub && {
      ...c.hub,
      digests: (c.hub.digests || []).map(d =>
        d.id === who.digestId
          ? { ...d, recipients: (d.recipients || []).filter(r => r.toLowerCase() !== who.email.toLowerCase()) }
          : d,
      ),
    },
  }));
  return reply(
    200,
    `<h2>Unsubscribed</h2><p class="hint"><b>${esc(who.email)}</b> won’t get “${esc(digest?.title || who.digestId)}” any more.</p>`,
  );
}

module.exports = { html, sendDigest, unsubscribe, unsubscribeUrl, verify, sign, secret };
