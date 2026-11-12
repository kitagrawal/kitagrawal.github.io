// Pure rules shared by the newsletter Lambdas. No AWS imports, so `node --test newsletter/` runs
// without node_modules. lib.mjs re-exports everything here; deploy.sh zips it next to lib.mjs.
import { createHmac, timingSafeEqual } from "node:crypto";

const LETTER_STATUSES = ["active", "trialing", "past_due"];
const ENDED = ["canceled", "incomplete_expired"];
export const isEnded = (status) => ENDED.includes(status);

// The one rule for "this subscription gets letters". send-issue reads only the table's
// receives_letters, which syncCustomer sets from this.
export const receivesLetters = (sub) =>
  LETTER_STATUSES.includes(sub.status) &&
  !sub.cancel_at_period_end &&
  !sub.cancel_at &&
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

// Stripe customer + its subscriptions -> the table row (without synced_at), or null when the
// row should not exist: the customer is deleted, or never had a newsletter subscription.
// The subscription shown is one that receives letters if any does, else the most recent.
export function projectCustomer(customer, subs, productId) {
  if (!customer || customer.deleted) return null;
  const mine = subs.filter((s) => isNewsletter(s, productId));
  if (!mine.length) return null;
  const pick = [...mine].sort(
    (a, b) => Number(receivesLetters(b)) - Number(receivesLetters(a)) || b.created - a.created,
  )[0];
  const email = customer.email ?? null;
  return {
    email,
    email_lc: email ? email.trim().toLowerCase() : null,
    subscription_id: pick.id,
    status: pick.status,
    cancel_at_period_end: Boolean(pick.cancel_at_period_end || pick.cancel_at),
    current_period_end: periodEnd(pick),
    email_opt_out: pick.metadata?.email_opt_out === "true",
    receives_letters: receivesLetters(pick),
  };
}

// The fields compared to decide whether a sync changed a row (for the reconcile count).
export const ROW_FIELDS = [
  "email", "email_lc", "subscription_id", "status", "cancel_at_period_end",
  "current_period_end", "email_opt_out", "receives_letters",
];
export const rowChanged = (old, row) => !old || ROW_FIELDS.some((k) => (old[k] ?? null) !== (row[k] ?? null));

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
