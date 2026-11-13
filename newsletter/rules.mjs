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
      // Reader-email claims (readerEmail below): a resumed cancel clears its note so a later cancel
      // gets a new one; a new plan after an ended one starts the welcome/goodbye over.
      if (!next.cancel_at_period_end) delete next.cancel_noted_at;
      if (!same && isEnded(row?.status) && !isEnded(o.status)) {
        delete next.welcomed_at;
        delete next.goodbye_at;
        delete next.cancel_noted_at;
      }
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

// The cancel link's customer id: the only proof the cancel page and CancelPlan ask for (ADR 0001).
const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;

// What CancelPlan does for a customer id and its table row (or undefined): { action: "cancel",
// subscription } for a live plan with no scheduled cancel, otherwise { action: "support" } (bad id,
// no row, no plan, already cancelling, ended). One answer for every case, so ids cannot be probed.
export const cancelDecision = (c, row) =>
  typeof c === "string" && CUSTOMER_ID.test(c) && row?.subscription_id && LIVE(row.status) && !row.cancel_at_period_end
    ? { action: "cancel", subscription: row.subscription_id }
    : { action: "support" };

// Legacy opt-outs still billing: the rows cancel-opt-outs.sh cancels at period end. True when the
// reader has the legacy email_opt_out flag and cancelDecision would cancel the plan (live, none
// scheduled). Once the webhook records the scheduled cancel the row stops matching, so a re-run picks nobody.
export const needsCancel = (row) =>
  row?.email_opt_out === true && cancelDecision(row.username, row).action === "cancel";

// Form body for Stripe's POST /v1/subscriptions/{id}: the plan ends when the paid period does.
export const cancelForm = () => new URLSearchParams({ cancel_at_period_end: "true" }).toString();

// Stripe's reply to that call (the subscription object, or anything else on failure) -> the page's
// answer: { done: true, until } with the paid period's end (unix seconds), or { error: "support" }.
export function cancelReply(stripeSub) {
  const until = stripeSub && !stripeSub.error ? periodEnd(stripeSub) : null;
  return stripeSub?.cancel_at_period_end === true && Number.isFinite(until) ? { done: true, until } : { error: "support" };
}

// A Secrets Manager value -> the Stripe restricted key in it, or null. Accepts the plain key or a
// JSON object holding it under any field. Only rk_ keys: a full sk_ secret key is never used here.
export function restrictedKey(secretString) {
  const s = (secretString ?? "").trim();
  let values = [s];
  try { const o = JSON.parse(s); if (o && typeof o === "object") values = Object.values(o); } catch {}
  return values.find((v) => typeof v === "string" && /^rk_(live|test)_\w+$/.test(v.trim()))?.trim() ?? null;
}

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

// The Cancel link at the bottom of a letter (send-issue and link.sh use this).
export const cancelPageUrl = (base, customerId) => `${base}?c=${encodeURIComponent(customerId)}`;

// What send-issue does for an uploaded S3 key. The handler URL-decodes the key first (events send
// "+" for a space); here the key is plain. Returns one of:
//   { mode: "proof", issueId }                      drafts/<name>.md: one email to the author
//   { mode: "send", issueId, recipients }           issues/<name>.md with SES production access
//   { mode: "refuse", issueId, reason }             issues/<name>.md while SES is in the sandbox
//   { mode: "ignore" }                              anything else (other prefix, not .md, nested key, empty name)
// recipients: rows with receives_letters, one per email_lc (the lowest customer id wins, so the
// choice is the same on every run), as { customerId, email, emailLc } in customer id order.
export function sendPlan(objectKey, rows, productionAccess) {
  const m = typeof objectKey === "string" ? objectKey.match(/^(drafts|issues)\/([^/]+)\.md$/) : null;
  if (!m || !m[2].trim()) return { mode: "ignore" };
  const [, prefix, issueId] = m;
  if (prefix === "drafts") return { mode: "proof", issueId };
  if (productionAccess !== true) {
    return { mode: "refuse", issueId, reason: "SES is in the sandbox: real sends are refused until production access is granted" };
  }
  const seen = new Set();
  const recipients = [];
  const eligible = (rows ?? []).filter((r) => r?.receives_letters === true && r.username && r.email && r.email_lc);
  for (const r of eligible.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0))) {
    if (seen.has(r.email_lc)) continue;
    seen.add(r.email_lc);
    recipients.push({ customerId: r.username, email: r.email, emailLc: r.email_lc });
  }
  return { mode: "send", issueId, recipients };
}

// Which reader email (if any) a row change makes due. StripeSync calls it after saveRow writes, with the
// row before (or undefined) and after the write. Returns { kind, claim } or null:
//   welcome            claim welcomed_at     the write makes a plan live with an email, no opt-out, no welcome yet,
//                                            and it is a new reader or plan: there was no row before, or the
//                                            subscription id changed, the row before had no email, or the plan
//                                            was still incomplete (never live). A pause then
//                                            resume, or past_due then active, on the same subscription with the
//                                            email already on file gives none
//   cancel-scheduled   claim cancel_noted_at the write is the transition that schedules a cancel: the row before
//                                            had none scheduled, the plan is live, the note is not yet claimed;
//                                            needs current_period_end for the "letters continue until" date.
//                                            applyEvent clears cancel_noted_at when the cancel is resumed, so
//                                            cancel, resume, cancel notes twice. A cancel scheduled before this
//                                            code was deployed, or one scheduled while the plan was paused, gets
//                                            no note
//   goodbye            claim goodbye_at      the plan ended, no goodbye yet, and the reader was welcomed or the
//                      write is the one that ended a live plan (a row that never went live gets none). Never for a
//                      reader with the legacy email_opt_out flag (before or after the write)
// One email per event: welcome wins over cancel-scheduled. null in the SES sandbox (nothing is claimed, so
// a welcome or cancel note skipped in the sandbox is lost; a goodbye still goes out on a later event) or when
// there is no email on file. Readers who were live before reader emails existed get nothing without a backfill.
// The claim is a field on the row: StripeSync sets it with a conditional write before sending, so each
// email is sent at most once.
export function readerEmail(oldRow, newRow, productionAccess) {
  if (productionAccess !== true || !newRow?.email) return null;
  const optedOut = newRow.email_opt_out === true || oldRow?.email_opt_out === true;
  const live = newRow.sub_live === true && newRow.email_opt_out !== true;
  // Both event orders give exactly one welcome: subscription first (the row before had no email) or the
  // checkout email first (the row before had no subscription id).
  // A plan that starts incomplete (async payment, or the card payment confirmed after checkout) has never
  // been live, so its first live write still welcomes.
  const newReaderOrPlan = !oldRow || oldRow.subscription_id !== newRow.subscription_id || !oldRow.email_lc ||
    !oldRow.status || oldRow.status === "incomplete";
  if (live && newReaderOrPlan && !newRow.welcomed_at) return { kind: "welcome", claim: "welcomed_at" };
  if (live && oldRow && oldRow.cancel_at_period_end !== true && newRow.cancel_at_period_end === true &&
      !newRow.cancel_noted_at && Number.isFinite(newRow.current_period_end)) {
    return { kind: "cancel-scheduled", claim: "cancel_noted_at" };
  }
  if (!optedOut && isEnded(newRow.status) && !newRow.goodbye_at && (newRow.welcomed_at || LIVE(oldRow?.status))) {
    return { kind: "goodbye", claim: "goodbye_at" };
  }
  return null;
}
