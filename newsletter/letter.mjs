// Pure: turns a Markdown letter into the email readers receive. Imports only the vendored marked.
import { marked } from "./vendor/marked.esm.js";

export const SUPPORT_EMAIL = "support@appliedailetter.com";
export const SAMPLE_CANCEL_URL = "https://kitagrawal.github.io/unsubscribe.html?c=cus_PROOF";

const ACCENT = "#0f6b5c";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Leading `---` block with `subject: ...` (quotes optional). Throws when the subject is missing or empty.
export function parseLetter(markdown) {
  const src = String(markdown ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  let subject = "";
  let body = src;
  if (m) {
    body = src.slice(m[0].length);
    const line = m[1].split("\n").find((l) => /^subject[ \t]*:/i.test(l));
    if (line) {
      subject = line.replace(/^subject[ \t]*:/i, "").trim();
      const q = subject.match(/^(["'])([\s\S]*)\1$/);
      if (q) subject = q[2].trim();
    }
  }
  if (!subject) throw new Error("Letter has no subject: start the file with a front matter block containing `subject: ...`.");
  return { subject, body: body.replace(/^\n+/, "") };
}

const readableDate = (secs) => {
  const d = new Date(secs * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

// Fill {{name}}; `until` as unix seconds becomes a readable UTC date. Unknown names are left as written.
const fill = (s, fields, esc = (x) => x) =>
  String(s).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k) => {
    if (!Object.prototype.hasOwnProperty.call(fields, k) || fields[k] == null) return all;
    const v = fields[k];
    return esc(k === "until" && typeof v === "number" ? readableDate(v) : String(v));
  });

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const P = `margin:0 0 16px;`;
// Email clients drop <style>, so the rendered tags get inline styles.
const inline = (html) =>
  html
    .replace(/<h1>/g, `<h1 style="font-size:26px;line-height:1.25;margin:28px 0 12px;color:#16181d;">`)
    .replace(/<h2>/g, `<h2 style="font-size:21px;line-height:1.3;margin:26px 0 10px;color:#16181d;">`)
    .replace(/<h3>/g, `<h3 style="font-size:17px;line-height:1.35;margin:22px 0 8px;color:#16181d;">`)
    .replace(/<p>/g, `<p style="${P}">`)
    .replace(/<a /g, `<a style="color:${ACCENT};text-decoration:underline;" `)
    .replace(/<ul>/g, `<ul style="margin:0 0 16px;padding-left:24px;">`)
    .replace(/<ol>/g, `<ol style="margin:0 0 16px;padding-left:24px;">`)
    .replace(/<li>/g, `<li style="margin:0 0 6px;">`)
    .replace(/<blockquote>/g, `<blockquote style="margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid ${ACCENT};color:#5d6370;">`)
    .replace(/<pre>/g, `<pre style="margin:0 0 16px;padding:12px 14px;background:#f1efe8;border-radius:6px;overflow-x:auto;font-size:14px;line-height:1.5;">`)
    .replace(/<code>/g, `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em;">`)
    .replace(/<hr>/g, `<hr style="border:0;border-top:1px solid #e3dfd6;margin:28px 0;">`)
    .replace(/<img /g, `<img style="max-width:100%;height:auto;" `);

// cancelUrl: null (or empty) leaves the Unsubscribe link out of the footer, for reader emails sent after the
// reader has already unsubscribed or the plan has ended; the support line stays.
export function renderLetter({ subject, body, cancelUrl, fields = {} }) {
  const subj = fill(subject, fields);
  const md = fill(body, fields);
  // Field values are escaped before Markdown sees them, so a value can never inject HTML.
  const content = inline(marked.parse(fill(body, fields, escapeHtml), { async: false, gfm: true, breaks: false }));
  const title = escapeHtml(subj);
  const cancelHtml = cancelUrl
    ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#5d6370;"><a href="${escapeHtml(cancelUrl)}" style="color:${ACCENT};text-decoration:underline;">Unsubscribe</a></p>\n`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f7f5f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f5f0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px 28px;font-family:${FONT};font-size:17px;line-height:1.65;color:#16181d;">
<div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT};font-weight:600;margin:0 0 6px;">The Applied AI Letter</div>
<h1 style="font-size:28px;line-height:1.25;margin:0 0 20px;color:#16181d;border-bottom:3px solid ${ACCENT};padding-bottom:16px;">${title}</h1>
${content}
<hr style="border:0;border-top:1px solid #e3dfd6;margin:32px 0 16px;">
${cancelHtml}<p style="margin:0;font-size:14px;line-height:1.6;color:#5d6370;">Questions or trouble with your plan? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${ACCENT};text-decoration:underline;">${SUPPORT_EMAIL}</a>.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  const text = `${md.replace(/\s+$/, "")}\n\n--\n${cancelUrl ? `Unsubscribe: ${cancelUrl}\n` : ""}Questions or trouble with your plan? Email ${SUPPORT_EMAIL}.\n`;
  return { subject: subj, html, text };
}
