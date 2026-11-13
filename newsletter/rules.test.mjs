// Run: node --test newsletter/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  receivesLetters, isNewsletter, applyEvent, customerOf, optOut, stillBilling, sameEmail,
  verifySignature, unsubscribeToken, checkToken, unsubscribePageUrl,
} from "./rules.mjs";

const PROD = "prod_letter";
const sub = (o = {}) => ({
  id: "sub_1", status: "active", created: 100, cancel_at_period_end: false, cancel_at: null,
  pause_collection: null, metadata: {},
  items: { data: [{ price: { product: PROD }, current_period_end: 999 }] },
  ...o,
});

test("receivesLetters: live statuses get letters", () => {
  for (const status of ["active", "trialing", "past_due"]) assert.equal(receivesLetters(sub({ status })), true);
  for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
    assert.equal(receivesLetters(sub({ status })), false, status);
  }
});

test("receivesLetters: cancel at period end, cancel_at, pause and opt-out stop letters", () => {
  assert.equal(receivesLetters(sub({ cancel_at_period_end: true })), false);
  assert.equal(receivesLetters(sub({ cancel_at: 12345 })), false);
  assert.equal(receivesLetters(sub({ pause_collection: { behavior: "void" } })), false);
  assert.equal(receivesLetters(sub({ metadata: { email_opt_out: "true" } })), false);
  assert.equal(receivesLetters(sub({ metadata: { email_opt_out: "false" } })), true);
});

test("isNewsletter: product as id or expanded object; other products and unset id ignored", () => {
  assert.equal(isNewsletter(sub(), PROD), true);
  assert.equal(isNewsletter(sub({ items: { data: [{ price: { product: { id: PROD } } }] } }), PROD), true);
  assert.equal(isNewsletter(sub({ items: { data: [{ price: { product: "prod_other" } }] } }), PROD), false);
  assert.equal(isNewsletter(sub(), undefined), false);
});

const ev = (type, object, created = 1000) => ({ type, created, data: { object } });
const subEv = (o = {}, created = 1000, type = "customer.subscription.updated") =>
  ev(type, sub({ customer: "cus_1", ...o }), created);
const checkout = (email = "Reader@Example.com", created = 1000) =>
  ev("checkout.session.completed", { mode: "subscription", customer: "cus_1", customer_details: { email } }, created);
// Apply events in order, as StripeSync's saveRow would.
const play = (...events) => events.reduce((row, e) => {
  const r = applyEvent(row, e, PROD);
  return r.action === "write" ? r.row : r.action === "delete" ? undefined : row;
}, undefined);

test("customerOf: subscription, checkout and customer events", () => {
  assert.equal(customerOf(subEv()), "cus_1");
  assert.equal(customerOf(checkout()), "cus_1");
  assert.equal(customerOf(ev("customer.updated", { id: "cus_2" })), "cus_2");
  assert.equal(customerOf(ev("invoice.paid", { customer: "cus_1" })), null);
});

test("applyEvent: checkout then subscription -> a reader who gets letters", () => {
  for (const order of [[checkout(), subEv({}, 1001, "customer.subscription.created")],
                       [subEv({}, 1001, "customer.subscription.created"), checkout()]]) {
    const row = play(...order);
    assert.equal(row.email_lc, "reader@example.com");
    assert.equal(row.subscription_id, "sub_1");
    assert.equal(row.current_period_end, 999);
    assert.equal(row.receives_letters, true);
  }
});

test("applyEvent: no email yet -> no letters", () => {
  assert.equal(play(subEv()).receives_letters, false);
});

test("applyEvent: an older event never overwrites a newer one", () => {
  const row = play(checkout(), subEv({ status: "canceled" }, 2000), subEv({ status: "active" }, 1500));
  assert.equal(row.status, "canceled");
  assert.equal(row.receives_letters, false);
  const mail = play(checkout("new@example.com", 2000), checkout("old@example.com", 1000));
  assert.equal(mail.email_lc, "new@example.com");
});

test("applyEvent: non-newsletter subscriptions and non-subscription checkouts are skipped", () => {
  assert.equal(applyEvent(undefined, subEv({ items: { data: [{ price: { product: "prod_other" } }] } }), PROD).action, "skip");
  assert.equal(applyEvent(undefined, ev("checkout.session.completed", { mode: "payment", customer: "cus_1", customer_details: { email: "a@b.c" } }), PROD).action, "skip");
});

test("applyEvent: two subscriptions -> keep the one that gets letters", () => {
  const row = play(checkout(), subEv({ id: "sub_new" }, 1001), subEv({ id: "sub_old", status: "canceled" }, 1002));
  assert.equal(row.subscription_id, "sub_new");
  assert.equal(row.receives_letters, true);
});

test("applyEvent: cancel at period end, cancel_at, pause, past_due", () => {
  assert.equal(play(checkout(), subEv({ cancel_at_period_end: true })).receives_letters, false);
  assert.equal(play(checkout(), subEv({ cancel_at: 5 })).cancel_at_period_end, true);
  assert.equal(play(checkout(), subEv({ pause_collection: { behavior: "void" } })).receives_letters, false);
  assert.equal(play(checkout(), subEv({ status: "past_due" })).receives_letters, true);
});

test("optOut: letters stop and stay stopped through later webhooks, including the owner's cancel", () => {
  let row = optOut(play(checkout(), subEv()), 1100);
  assert.equal(row.receives_letters, false);
  assert.equal(stillBilling(row), true); // owner still has to cancel in Stripe
  for (const e of [subEv({}, 1200), subEv({ cancel_at_period_end: true }, 1300), subEv({ status: "canceled" }, 1400, "customer.subscription.deleted")]) {
    row = applyEvent(row, e, PROD).row;
    assert.equal(row.email_opt_out, true);
    assert.equal(row.receives_letters, false);
  }
  assert.equal(row.status, "canceled");
  assert.equal(stillBilling(row), false);
});

test("applyEvent: Stripe metadata email_opt_out also opts out", () => {
  assert.equal(play(checkout(), subEv({ metadata: { email_opt_out: "true" } })).receives_letters, false);
});

test("applyEvent: a new subscription after opting out is a resubscribe", () => {
  const out = optOut(play(checkout(), subEv({ id: "sub_a" })), 1100);
  const back = applyEvent(out, subEv({ id: "sub_b", created: 1200 }, 1200, "customer.subscription.created"), PROD).row;
  assert.equal(back.subscription_id, "sub_b");
  assert.equal(back.email_opt_out, false);
  assert.equal(back.receives_letters, true);
});

test("applyEvent: customer.updated changes a known reader's email only; customer.deleted deletes", () => {
  const row = play(checkout(), subEv(), ev("customer.updated", { id: "cus_1", email: "New@Example.com" }, 1500));
  assert.equal(row.email_lc, "new@example.com");
  assert.equal(applyEvent(undefined, ev("customer.updated", { id: "cus_9", email: "x@y.z" }), PROD).action, "skip");
  assert.equal(applyEvent(row, ev("customer.deleted", { id: "cus_1" }), PROD).action, "delete");
  assert.equal(applyEvent(undefined, ev("customer.deleted", { id: "cus_1" }), PROD).action, "skip");
});

test("sameEmail: case and spaces ignored; empty never matches", () => {
  assert.equal(sameEmail("Reader@Example.com", " reader@example.COM "), true);
  assert.equal(sameEmail("a@example.com", "b@example.com"), false);
  assert.equal(sameEmail("", ""), false);
  assert.equal(sameEmail(null, "a@example.com"), false);
  assert.equal(sameEmail("a@example.com", undefined), false);
});

test("verifySignature", () => {
  const secret = "whsec_test", raw = Buffer.from('{"id":"evt_1"}'), t = 1_700_000_000;
  const v1 = createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
  assert.equal(verifySignature(raw, `t=${t},v1=${v1}`, secret, t), true);
  assert.equal(verifySignature(raw, `t=${t},v1=deadbeef,v1=${v1}`, secret, t), true);
  assert.equal(verifySignature(raw, `t=${t},v1=${v1}`, "wrong", t), false);
  assert.equal(verifySignature(raw, `t=${t},v1=${v1}`, secret, t + 301), false);
  assert.equal(verifySignature(raw, undefined, secret, t), false);
});

test("checkToken and unsubscribePageUrl", () => {
  const key = "k";
  const t = unsubscribeToken("cus_ABC", key);
  assert.equal(checkToken("cus_ABC", t, key), true);
  assert.equal(checkToken("cus_ABD", t, key), false);
  assert.equal(checkToken("cus_ABC", t.slice(1), key), false);
  assert.equal(checkToken("sub_ABC", unsubscribeToken("sub_ABC", key), key), false);
  assert.equal(checkToken(undefined, t, key), false);
  assert.equal(
    unsubscribePageUrl("https://kitagrawal.github.io/unsubscribe.html", "cus_ABC", key),
    `https://kitagrawal.github.io/unsubscribe.html?c=cus_ABC&t=${t}`,
  );
});
