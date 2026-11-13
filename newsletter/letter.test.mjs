// Run: node --test newsletter/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLetter, renderLetter, SAMPLE_CANCEL_URL } from "./letter.mjs";

const CANCEL = "https://kitagrawal.github.io/unsubscribe.html?c=cus_123";
const SUPPORT = "support@appliedailetter.com";

test("parseLetter: reads subject and body from front matter", () => {
  const r = parseLetter("---\nsubject: Agents in production\n---\n\nHello **reader**.\n");
  assert.equal(r.subject, "Agents in production");
  assert.equal(r.body, "Hello **reader**.\n");
});

test("parseLetter: quotes are optional and stripped; CRLF works", () => {
  assert.equal(parseLetter('---\nsubject: "Quoted: yes"\n---\nBody').subject, "Quoted: yes");
  assert.equal(parseLetter("---\nsubject: 'Single'\n---\nBody").subject, "Single");
  assert.equal(parseLetter("---\r\nsubject: Win\r\n---\r\nBody\r\n").subject, "Win");
});

test("parseLetter: missing or empty subject is refused with a clear error", () => {
  assert.throws(() => parseLetter("Just a body"), /no subject/i);
  assert.throws(() => parseLetter("---\ntitle: x\n---\nBody"), /no subject/i);
  assert.throws(() => parseLetter("---\nsubject:   \n---\nBody"), /no subject/i);
  assert.throws(() => parseLetter('---\nsubject: ""\n---\nBody'), /no subject/i);
  assert.throws(() => parseLetter(""), /no subject/i);
});

test("renderLetter: HTML has the rendered Markdown, the Cancel link and the support line", () => {
  const { html } = renderLetter({ subject: "S", body: "Hello **bold** and [a link](https://example.com/x).\n\n- one\n- two\n", cancelUrl: CANCEL });
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a [^>]*href="https:\/\/example\.com\/x"[^>]*>a link<\/a>/);
  assert.match(html, /<li[^>]*>one<\/li>/);
  assert.match(html, new RegExp(`href="${CANCEL.replace(/[.?]/g, "\\$&")}"[^>]*>Cancel your plan</a>`));
  assert.ok(html.includes(SUPPORT));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /max-width:600px/);
  assert.match(html, /#0f6b5c/);
  assert.ok(!/unsubscribe/i.test(html.replace(/unsubscribe\.html/g, "")));
});

test("renderLetter: subject is HTML-escaped in title and heading", () => {
  const { html, subject } = renderLetter({ subject: `<script>alert("x")</script> & more`, body: "b", cancelUrl: CANCEL });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /<title>&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; more<\/title>/);
  assert.match(html, /<h1[^>]*>&lt;script&gt;/);
  assert.equal(subject, `<script>alert("x")</script> & more`);
});

test("renderLetter: the Cancel URL is escaped in the href", () => {
  const { html } = renderLetter({ subject: "S", body: "b", cancelUrl: "https://x.test/?a=1&c=2" });
  assert.ok(html.includes('href="https://x.test/?a=1&amp;c=2"'));
});

test("renderLetter: text part has the Markdown body, the Cancel link and the support line", () => {
  const body = "Hello **bold**.\n\n- one\n- two\n";
  const { text } = renderLetter({ subject: "S", body, cancelUrl: CANCEL });
  assert.ok(text.startsWith("Hello **bold**."));
  assert.ok(text.includes("- two"));
  assert.ok(text.includes(CANCEL));
  assert.ok(text.includes(SUPPORT));
  assert.ok(!/unsubscribe/i.test(text.replace(/unsubscribe\.html/g, "")));
});

test("renderLetter: fields fill subject and body in both parts; until renders as a UTC date", () => {
  const until = Date.UTC(2026, 11, 12, 23, 59) / 1000;
  const r = renderLetter({
    subject: "Hi {{name}}",
    body: "Letters continue until {{until}}. Bye {{ name }}.",
    cancelUrl: CANCEL,
    fields: { name: "Ada", until },
  });
  assert.equal(r.subject, "Hi Ada");
  assert.match(r.html, /<title>Hi Ada<\/title>/);
  assert.match(r.html, /until 12 December 2026\./);
  assert.match(r.html, /Bye Ada\./);
  assert.match(r.text, /until 12 December 2026\. Bye Ada\./);
  assert.ok(!r.html.includes("{{") && !r.text.includes("{{"));
});

test("renderLetter: field values are HTML-escaped in the HTML part; unknown names are left alone", () => {
  const r = renderLetter({ subject: "S", body: "Hi {{name}} {{other}}", cancelUrl: CANCEL, fields: { name: "<b>x</b>" } });
  assert.ok(!r.html.includes("<b>x</b>"));
  assert.ok(r.html.includes("{{other}}"));
});

test("renderLetter: no fields argument is fine", () => {
  const r = renderLetter({ subject: "S", body: "b", cancelUrl: CANCEL });
  assert.equal(r.subject, "S");
});

test("SAMPLE_CANCEL_URL points at the cancel page with an obviously fake id", () => {
  assert.match(SAMPLE_CANCEL_URL, /^https:\/\/.+\/unsubscribe\.html\?c=cus_PROOF$/);
});

test("parseLetter then renderLetter: round trip", () => {
  const { subject, body } = parseLetter("---\nsubject: Round trip\n---\n# Heading\n\nText.\n");
  const r = renderLetter({ subject, body, cancelUrl: SAMPLE_CANCEL_URL });
  assert.match(r.html, /<h1 [^>]*>Heading<\/h1>/);
  assert.ok(r.text.includes("cus_PROOF"));
});
