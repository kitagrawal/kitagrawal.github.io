// Run: node --test newsletter/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  receivesLetters, isNewsletter, applyEvent, customerOf, cancelDecision, needsCancel, cancelForm, cancelReply,
  cancelPageUrl, verifySignature, restrictedKey,
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

test("receivesLetters: a scheduled cancel on a live plan still gets letters", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assert.equal(receivesLetters(sub({ status, cancel_at_period_end: true })), true, status);
    assert.equal(receivesLetters(sub({ status, cancel_at: 12345 })), true, status);
  }
  assert.equal(receivesLetters(sub({ status: "canceled", cancel_at_period_end: true })), false);
  assert.equal(receivesLetters(sub({ status: "canceled", cancel_at: 12345 })), false);
});

test("receivesLetters: pause and metadata opt-out stop letters", () => {
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

test("applyEvent: a scheduled cancel keeps letters until Stripe reports canceled; pause stops them", () => {
  assert.equal(play(checkout(), subEv({ cancel_at_period_end: true })).receives_letters, true);
  const scheduled = play(checkout(), subEv({ cancel_at: 5 }));
  assert.equal(scheduled.cancel_at_period_end, true);
  assert.equal(scheduled.receives_letters, true);
  const ended = play(checkout(), subEv({ cancel_at_period_end: true }, 1100), subEv({ status: "canceled", cancel_at_period_end: true }, 1200, "customer.subscription.deleted"));
  assert.equal(ended.receives_letters, false);
  assert.equal(play(checkout(), subEv({ pause_collection: { behavior: "void" } })).receives_letters, false);
  assert.equal(play(checkout(), subEv({ status: "past_due" })).receives_letters, true);
});

test("legacy opt-out row stays receives_letters false even with a live plan and a scheduled cancel", () => {
  const row = { ...play(checkout(), subEv({ cancel_at_period_end: true })), email_opt_out: true };
  assert.equal(applyEvent(row, subEv({ cancel_at_period_end: true }, 1300), PROD).row.receives_letters, false);
});

test("legacy opt-out stays blocked through later webhooks, including a cancel", () => {
  let row = { ...play(checkout(), subEv()), email_opt_out: true, opted_out_at: 1100, receives_letters: false };
  for (const e of [subEv({}, 1200), subEv({ cancel_at_period_end: true }, 1300), subEv({ status: "canceled" }, 1400, "customer.subscription.deleted")]) {
    row = applyEvent(row, e, PROD).row;
    assert.equal(row.email_opt_out, true);
    assert.equal(row.receives_letters, false);
  }
  assert.equal(row.status, "canceled");
});

test("applyEvent: Stripe metadata email_opt_out also opts out", () => {
  assert.equal(play(checkout(), subEv({ metadata: { email_opt_out: "true" } })).receives_letters, false);
});

test("applyEvent: a new subscription after opting out is a resubscribe", () => {
  const out = { ...play(checkout(), subEv({ id: "sub_a" })), email_opt_out: true, opted_out_at: 1100, receives_letters: false };
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

test("verifySignature", () => {
  const secret = "whsec_test", raw = Buffer.from('{"id":"evt_1"}'), t = 1_700_000_000;
  const v1 = createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
  assert.equal(verifySignature(raw, `t=${t},v1=${v1}`, secret, t), true);
  assert.equal(verifySignature(raw, `t=${t},v1=deadbeef,v1=${v1}`, secret, t), true);
  assert.equal(verifySignature(raw, `t=${t},v1=${v1}`, "wrong", t), false);
  assert.equal(verifySignature(raw, `t=${t},v1=${v1}`, secret, t + 301), false);
  assert.equal(verifySignature(raw, undefined, secret, t), false);
});

const row = (o = {}) => ({ username: "cus_ABC", subscription_id: "sub_1", status: "active", cancel_at_period_end: false, ...o });

test("cancelDecision: a live plan with no scheduled cancel is cancelled", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assert.deepEqual(cancelDecision("cus_ABC", row({ status })), { action: "cancel", subscription: "sub_1" }, status);
  }
  // a legacy opted-out reader who still pays can cancel too
  assert.equal(cancelDecision("cus_ABC", row({ email_opt_out: true })).action, "cancel");
});

test("cancelDecision: every other case is the same support answer", () => {
  const support = { action: "support" };
  assert.deepEqual(cancelDecision("cus_ABC", undefined), support);
  assert.deepEqual(cancelDecision("cus_ABC", row({ cancel_at_period_end: true })), support);
  for (const status of ["canceled", "incomplete_expired", "incomplete", "unpaid", "paused"]) {
    assert.deepEqual(cancelDecision("cus_ABC", row({ status })), support, status);
  }
  assert.deepEqual(cancelDecision("cus_ABC", row({ subscription_id: undefined })), support);
  assert.deepEqual(cancelDecision("cus_ABC", row({ subscription_id: "" })), support);
  for (const bad of [undefined, null, "", "sub_ABC", "cus_", "cus_a b", "cus_ABC&x=1", 42, { c: "cus_ABC" }]) {
    assert.deepEqual(cancelDecision(bad, row()), support, String(bad));
  }
});

test("needsCancel: opted out, live plan, no scheduled cancel is picked", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assert.equal(needsCancel(row({ email_opt_out: true, status })), true, status);
  }
});

test("needsCancel: not opted out, ended, no plan or already cancelling is not picked", () => {
  assert.equal(needsCancel(row()), false);
  assert.equal(needsCancel(row({ email_opt_out: false })), false);
  assert.equal(needsCancel(row({ email_opt_out: "true" })), false);
  assert.equal(needsCancel(row({ email_opt_out: true, cancel_at_period_end: true })), false);
  for (const status of ["canceled", "incomplete_expired", "incomplete", "unpaid", "paused"]) {
    assert.equal(needsCancel(row({ email_opt_out: true, status })), false, status);
  }
  assert.equal(needsCancel(row({ email_opt_out: true, subscription_id: undefined })), false);
  assert.equal(needsCancel(row({ email_opt_out: true, username: "not-a-customer" })), false);
  assert.equal(needsCancel(undefined), false);
});

test("needsCancel: after the webhook records the scheduled cancel the row is not picked again", () => {
  const before = row({ email_opt_out: true });
  const after = applyEvent(before, { type: "customer.subscription.updated", created: 5,
    data: { object: sub({ cancel_at_period_end: true }) } }, PROD).row;
  assert.equal(needsCancel(before), true);
  assert.equal(needsCancel({ ...before, ...after }), false);
});

test("cancelForm schedules the cancel for the end of the paid period", () => {
  const p = new URLSearchParams(cancelForm());
  assert.equal(p.get("cancel_at_period_end"), "true");
  assert.deepEqual([...p.keys()], ["cancel_at_period_end"]);
});

test("cancelReply: a scheduled cancel gives the period end, from the subscription or its first item", () => {
  assert.deepEqual(cancelReply({ cancel_at_period_end: true, current_period_end: 1800000000 }), { done: true, until: 1800000000 });
  assert.deepEqual(cancelReply(sub({ cancel_at_period_end: true })), { done: true, until: 999 });
});

test("cancelReply: anything else is the support answer", () => {
  const support = { error: "support" };
  assert.deepEqual(cancelReply({ error: { message: "No such subscription" } }), support);
  assert.deepEqual(cancelReply({ error: { message: "x" }, cancel_at_period_end: true, current_period_end: 5 }), support);
  assert.deepEqual(cancelReply(sub({ cancel_at_period_end: false })), support); // Stripe did not schedule it
  assert.deepEqual(cancelReply({ cancel_at_period_end: true }), support); // no period end to show
  assert.deepEqual(cancelReply(null), support);
  assert.deepEqual(cancelReply(undefined), support);
  assert.deepEqual(cancelReply({}), support);
});

test("cancelPageUrl carries only the customer id", () => {
  assert.equal(
    cancelPageUrl("https://kitagrawal.github.io/unsubscribe.html", "cus_ABC"),
    "https://kitagrawal.github.io/unsubscribe.html?c=cus_ABC",
  );
  assert.equal(cancelPageUrl("http://localhost:8000/unsubscribe.html", "cus a&b"), "http://localhost:8000/unsubscribe.html?c=cus%20a%26b");
});

test("restrictedKey takes only an rk_ key, plain or inside JSON", () => {
  assert.equal(restrictedKey("rk_live_abc123"), "rk_live_abc123");
  assert.equal(restrictedKey(' {"stripe_key": "rk_test_x9"} '), "rk_test_x9");
  assert.equal(restrictedKey('{"secret": "sk_live_x", "restricted": "rk_live_y"}'), "rk_live_y");
  assert.equal(restrictedKey("sk_live_abc123"), null);
  assert.equal(restrictedKey('{"key": "sk_live_abc"}'), null);
  assert.equal(restrictedKey(""), null);
  assert.equal(restrictedKey(undefined), null);
});
