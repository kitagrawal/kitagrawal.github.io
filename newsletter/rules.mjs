// Pure rules shared by the newsletter Lambdas. No AWS imports, so `node --test newsletter/` runs
// without node_modules. lib.mjs re-exports everything here; deploy.sh zips it next to lib.mjs.
import { createHmac, timingSafeEqual } from "node:crypto";

const LETTER_STATUSES = ["active", "trialing", "past_due"];
const ENDED = ["canceled", "incomplete_expired"];
export const isEnded = (status) => ENDED.includes(status);

// "This subscription gets letters", from the subscription alone. A scheduled cancel
// (cancel_at_period_end or cancel_at) does not stop letters: they run until Stripe reports the
// plan canceled. applyEvent stores this as sub_live and combines it with the reader's legacy
// opt-out into the row's receives_letters.
export const receivesLetters = (sub) =>
  LETTER_STATUSES.includes(sub.status) &&
  !sub.pause_collection &&
  sub.metadata?.email_opt_out !== "true";

const productOf = (item) => {
  const p = item.price?.product ?? item.plan?.product;
  return typeof p === "string" ? p : p?.id;
};

// True if any item on the subscription is for the newsletter product.
export const isNewsletter = (sub, productId) =>
  Boolean(productId) && (sub.items?.data ?? []).some((item) => productOf(item) === productId);

// Newer API versions moved current_period_end onto the subscription items.
const periodEnd = (sub) => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;

const LIVE = (status) => LETTER_STATUSES.includes(status);
const lower = (email) => (email ? email.trim().toLowerCase() : null);

// The customer id a handled webhook event is about, or null for events we ignore.
export function customerOf(evt) {
  const o = evt?.data?.object ?? {};
  if (evt?.type?.startsWith("customer.subscription.") || evt?.type === "checkout.session.completed") {
    return typeof o.customer === "string" ? o.customer : o.customer?.id ?? null;
  }
  if (evt?.type === "customer.updated" || evt?.type === "customer.deleted") return o.id ?? null;
  return null;
}

// The one rule for a row: letters go out only to a live subscription, with an email on file,
// that the reader has not opted out of. send-issue reads only receives_letters.
const finish = (row) => ({
  action: "write",
  row: { ...row, receives_letters: Boolean(row.sub_live && !row.email_opt_out && row.email_lc) },
});
const SKIP = { action: "skip" };

// Webhook event + the current row (or undefined) -> { action: "write", row } | { action: "delete" } | SKIP.
// The row is built from events alone (no Stripe API key): subscription events carry the plan,
// checkout.session.completed and customer.updated carry the email. Each half keeps the event
// time it came from, so a late, older event never overwrites a newer one.
export function applyEvent(row, evt, productId) {
  const o = evt?.data?.object ?? {};
  const at = evt?.created ?? 0;
  switch (evt?.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!isNewsletter(o, productId)) return SKIP;
      const same = row?.subscription_id === o.id;
      if (same && row.sub_event_at > at) return SKIP; // out of order
      // Two subscriptions on one customer: keep the one that gets letters.
      if (row?.subscription_id && !same && row.sub_live && !receivesLetters(o)) return SKIP;
      const next = {
        ...row,
        subscription_id: o.id,
        status: o.status,
        cancel_at_period_end: Boolean(o.cancel_at_period_end || o.cancel_at),
        current_period_end: periodEnd(o),
        sub_live: receivesLetters(o),
        sub_event_at: at,
      };
      if (o.metadata?.email_opt_out === "true") next.email_opt_out = true;
      // A new subscription started after the reader opted out is a resubscribe.
      else if (!same && row?.email_opt_out && o.created > (row.opted_out_at ?? Infinity)) next.email_opt_out = false;
      return finish(next);
    }
    case "checkout.session.completed": {
      const email = o.customer_details?.email ?? o.customer_email;
      if (o.mode !== "subscription" || !email) return SKIP;
      if (row?.email_event_at > at) return SKIP;
      return finish({ ...row, email, email_lc: lower(email), email_event_at: at });
    }
    case "customer.updated": {
      // Only for customers we already track; other Stripe customers never get a row.
      if (!row || !o.email || row.email_event_at > at) return SKIP;
      return finish({ ...row, email: o.email, email_lc: lower(o.email), email_event_at: at });
    }
    case "customer.deleted":
      return row ? { action: "delete" } : SKIP;
    default:
      return SKIP;
  }
}

// The reader unsubscribed (page or one-click). nowSec is unix seconds, like Stripe's times.
export const optOut = (row, nowSec) => finish({ ...row, email_opt_out: true, opted_out_at: nowSec }).row;

// True while Stripe will still charge for the plan, so the reader still has to cancel it in Stripe's portal.
export const stillBilling = (row) => Boolean(row && LIVE(row.status) && !row.cancel_at_period_end);

// Form body for Stripe's POST /v1/billing_portal/sessions: a customer-portal page that opens
// straight on "Cancel subscription" for this subscription, with no login, and goes to returnUrl after.
export const portalCancelForm = (customer, subscription, returnUrl) => new URLSearchParams({
  customer,
  return_url: returnUrl,
  "flow_data[type]": "subscription_cancel",
  "flow_data[subscription_cancel][subscription]": subscription,
  "flow_data[after_completion][type]": "redirect",
  "flow_data[after_completion][redirect][return_url]": returnUrl,
}).toString();

// A Secrets Manager value -> the Stripe restricted key in it, or null. Accepts the plain key or a
// JSON object holding it under any field. Only rk_ keys: a full sk_ secret key is never used here.
export function restrictedKey(secretString) {
  const s = (secretString ?? "").trim();
  let values = [s];
  try { const o = JSON.parse(s); if (o && typeof o === "object") values = Object.values(o); } catch {}
  return values.find((v) => typeof v === "string" && /^rk_(live|test)_\w+$/.test(v.trim()))?.trim() ?? null;
}

export const sameEmail = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.trim() !== "" &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

// Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=...]; the signed payload is "<t>.<raw body>".
export function verifySignature(raw, header, secret, now = Date.now() / 1000) {
  let t;
  const sigs = [];
  for (const part of (header || "").split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length || Math.abs(now - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  return sigs.some((s) => {
    const b = Buffer.from(s, "hex");
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

// Token for the unsubscribe link: HMAC of the customer id, so nobody can unsubscribe someone else.
export const unsubscribeToken = (customerId, key) =>
  createHmac("sha256", key).update(customerId).digest("base64url");

export function checkToken(c, t, key) {
  if (typeof c !== "string" || typeof t !== "string" || !/^cus_[A-Za-z0-9]+$/.test(c)) return false;
  const expected = Buffer.from(unsubscribeToken(c, key));
  const got = Buffer.from(t);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// The letter's unsubscribe link (send-issue and link.sh use this).
export const unsubscribePageUrl = (base, customerId, key) =>
  `${base}?c=${encodeURIComponent(customerId)}&t=${unsubscribeToken(customerId, key)}`;
