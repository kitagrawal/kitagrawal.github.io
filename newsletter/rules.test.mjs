// Run: node --test newsletter/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  receivesLetters, isNewsletter, projectCustomer, rowChanged, sameEmail,
  verifySignature, unsubscribeToken, checkToken, unsubscribePageUrl,
} from "./rules.mjs";

const PROD = "prod_letter";
const sub = (o = {}) => ({
  id: "sub_1", status: "active", created: 100, cancel_at_period_end: false, cancel_at: null,
  pause_collection: null, metadata: {},
  items: { data: [{ price: { product: PROD }, current_period_end: 999 }] },
  ...o,
});
const customer = { id: "cus_1", email: "Reader@Example.com" };

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

test("projectCustomer: a plain reader", () => {
  assert.deepEqual(projectCustomer(customer, [sub()], PROD), {
    email: "Reader@Example.com", email_lc: "reader@example.com", subscription_id: "sub_1",
    status: "active", cancel_at_period_end: false, current_period_end: 999,
    email_opt_out: false, receives_letters: true,
  });
});

test("projectCustomer: resubscribe overlap keeps the subscription that gets letters", () => {
  const old = sub({ id: "sub_old", created: 100, cancel_at_period_end: true });
  const fresh = sub({ id: "sub_new", created: 200 });
  for (const subs of [[old, fresh], [fresh, old]]) {
    const row = projectCustomer(customer, subs, PROD);
    assert.equal(row.subscription_id, "sub_new");
    assert.equal(row.receives_letters, true);
  }
});

test("projectCustomer: none get letters -> the most recent one", () => {
  const a = sub({ id: "sub_a", created: 100, status: "canceled" });
  const b = sub({ id: "sub_b", created: 300, status: "canceled" });
  const row = projectCustomer(customer, [a, b], PROD);
  assert.equal(row.subscription_id, "sub_b");
  assert.equal(row.receives_letters, false);
});

test("projectCustomer: cancel at period end and opt-out", () => {
  const row = projectCustomer(customer, [sub({ cancel_at_period_end: true, metadata: { email_opt_out: "true" } })], PROD);
  assert.equal(row.receives_letters, false);
  assert.equal(row.cancel_at_period_end, true);
  assert.equal(row.email_opt_out, true);
});

test("projectCustomer: past_due still gets letters", () => {
  assert.equal(projectCustomer(customer, [sub({ status: "past_due" })], PROD).receives_letters, true);
});

test("projectCustomer: a live non-newsletter subscription is ignored", () => {
  const other = sub({ id: "sub_other", created: 500, items: { data: [{ price: { product: "prod_other" } }] } });
  const letter = sub({ id: "sub_letter", status: "canceled" });
  const row = projectCustomer(customer, [other, letter], PROD);
  assert.equal(row.subscription_id, "sub_letter");
  assert.equal(row.receives_letters, false);
  assert.equal(projectCustomer(customer, [other], PROD), null);
});

test("projectCustomer: deleted or missing customer -> null", () => {
  assert.equal(projectCustomer({ id: "cus_1", deleted: true }, [sub()], PROD), null);
  assert.equal(projectCustomer(null, [sub()], PROD), null);
});

test("projectCustomer: missing email and old-API period end", () => {
  const row = projectCustomer({ id: "cus_1", email: null }, [sub({ current_period_end: 42 })], PROD);
  assert.equal(row.email, null);
  assert.equal(row.email_lc, null);
  assert.equal(row.current_period_end, 42);
});

test("rowChanged", () => {
  const row = projectCustomer(customer, [sub()], PROD);
  assert.equal(rowChanged(undefined, row), true);
  assert.equal(rowChanged({ ...row, synced_at: "x" }, row), false);
  assert.equal(rowChanged({ ...row, receives_letters: false }, row), true);
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
