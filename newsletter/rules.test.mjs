// Run: node --test newsletter/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  receivesLetters, isNewsletter, applyEvent, customerOf, cancelDecision, needsCancel, cancelForm, cancelReply,
  cancelPageUrl, verifySignature, restrictedKey, sendPlan, readerEmail,
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

const reader = (username, email, extra = {}) => ({ username, email, email_lc: email.toLowerCase(), receives_letters: true, ...extra });

test("sendPlan: a draft is a proof, in the sandbox too, with no recipients read", () => {
  assert.deepEqual(sendPlan("drafts/2026-11-agents.md", [], false), { mode: "proof", issueId: "2026-11-agents" });
  assert.deepEqual(sendPlan("drafts/my letter.md", undefined, true), { mode: "proof", issueId: "my letter" });
});

test("sendPlan: an issue is refused in the sandbox", () => {
  const plan = sendPlan("issues/one.md", [reader("cus_1", "a@x.com")], false);
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.issueId, "one");
  assert.match(plan.reason, /sandbox/);
  assert.equal(sendPlan("issues/one.md", [], undefined).mode, "refuse");
});

test("sendPlan: an issue with production access goes to readers who receive letters only", () => {
  const rows = [
    reader("cus_1", "a@x.com"),
    reader("cus_2", "b@x.com", { receives_letters: false }),
    reader("cus_3", "c@x.com", { receives_letters: "true" }),
    { username: "cus_4", email: "d@x.com", receives_letters: true }, // no email_lc
    reader("cus_5", "e@x.com", { receives_letters: undefined }),
  ];
  assert.deepEqual(sendPlan("issues/one.md", rows, true), {
    mode: "send", issueId: "one", recipients: [{ customerId: "cus_1", email: "a@x.com", emailLc: "a@x.com" }],
  });
});

test("sendPlan: one copy per email_lc, the lowest customer id wins whatever the row order", () => {
  const rows = [reader("cus_9", "Same@X.com"), reader("cus_2", "same@x.com"), reader("cus_5", "other@x.com")];
  const expected = [
    { customerId: "cus_2", email: "same@x.com", emailLc: "same@x.com" },
    { customerId: "cus_5", email: "other@x.com", emailLc: "other@x.com" },
  ];
  assert.deepEqual(sendPlan("issues/n.md", rows, true).recipients, expected);
  assert.deepEqual(sendPlan("issues/n.md", [...rows].reverse(), true).recipients, expected);
});

test("sendPlan: no readers is still a send with no recipients", () => {
  assert.deepEqual(sendPlan("issues/n.md", [], true), { mode: "send", issueId: "n", recipients: [] });
});

test("sendPlan: other keys are ignored", () => {
  for (const key of [
    "other/x.md", "drafts/x.txt", "drafts/x", "drafts/.md", "drafts/ .md", "issues/.md", "drafts/", "drafts/sub/x.md",
    "issues/a/b.md", "x/drafts/a.md", "drafts/a.md/", "Drafts/a.md", "", undefined, null, 5,
  ]) assert.deepEqual(sendPlan(key, [reader("cus_1", "a@x.com")], true), { mode: "ignore" }, String(key));
});

test("sendPlan: the issue id keeps dots and drops only the prefix and the final .md", () => {
  assert.equal(sendPlan("drafts/v1.2.final.md", [], true).issueId, "v1.2.final");
  assert.equal(sendPlan("issues/a.md.md", [], true).issueId, "a.md");
});

// readerEmail: each step plays an event like StripeSync (applyEvent, then readerEmail on old and new row)
// and, when an email is due, claims it like the conditional write does (sets the claim field).
const step = (row, evt, prod = true) => {
  const r = applyEvent(row, evt, PROD);
  if (r.action !== "write") return { row, due: null };
  const due = readerEmail(row, r.row, prod);
  return { row: due ? { ...r.row, [due.claim]: "2026-01-01T00:00:00Z" } : r.row, due };
};
const run = (...events) => events.reduce((acc, e) => {
  const s = step(acc.row, e);
  return { row: s.row, dues: [...acc.dues, s.due?.kind ?? null] };
}, { row: undefined, dues: [] });
const live = (extra = {}) => ({ email: "a@x.com", sub_live: true, status: "active", ...extra });

test("readerEmail: welcome once the plan is live with an email, whichever of checkout and subscription comes first", () => {
  assert.deepEqual(readerEmail(undefined, live(), true), { kind: "welcome", claim: "welcomed_at" });
  assert.deepEqual(run(checkout(), subEv({}, 1100, "customer.subscription.created")).dues, [null, "welcome"]);
  assert.deepEqual(run(subEv({}, 1100, "customer.subscription.created"), checkout("Reader@Example.com", 1200)).dues, [null, "welcome"]);
});

test("readerEmail: one welcome however many events follow", () => {
  const { dues } = run(checkout(), subEv({}, 1100, "customer.subscription.created"), subEv({}, 1200), subEv({}, 1300), ev("customer.updated", { id: "cus_1", email: "n@x.com" }, 1400));
  assert.deepEqual(dues, [null, "welcome", null, null, null]);
});

test("readerEmail: nothing in the sandbox, without an email, or for a plan that is not live", () => {
  assert.equal(readerEmail(undefined, live(), false), null);
  assert.equal(readerEmail(undefined, live(), undefined), null);
  assert.equal(readerEmail(undefined, live({ email: undefined }), true), null);
  assert.equal(readerEmail(undefined, live({ email: "" }), true), null);
  assert.equal(readerEmail(undefined, undefined, true), null);
  assert.equal(readerEmail(undefined, live({ sub_live: false, status: "active" }), true), null); // paused
  assert.equal(readerEmail(undefined, live({ email_opt_out: true }), true), null); // legacy opt-out: no welcome
});

test("readerEmail: a sandbox skip claims nothing, so the welcome goes out on a later event", () => {
  const sandboxed = step(undefined, checkout(), false);
  const s1 = step(sandboxed.row, subEv({}, 1100, "customer.subscription.created"), false);
  assert.equal(s1.due, null);
  assert.equal(s1.row.welcomed_at, undefined);
  assert.equal(step(s1.row, subEv({}, 1200), true).due.kind, "welcome");
});

test("readerEmail: no welcome for a row that starts ended; no goodbye either", () => {
  const row = play(checkout(), subEv({ status: "canceled" }, 1100, "customer.subscription.deleted"));
  assert.equal(readerEmail(undefined, row, true), null);
  assert.deepEqual(run(checkout(), subEv({ status: "canceled" }, 1100, "customer.subscription.deleted")).dues, [null, null]);
  assert.equal(readerEmail(row, { ...row }, true), null); // a later event on the same ended row
});

test("readerEmail: cancel-scheduled on the event that schedules the cancel, once", () => {
  const { dues } = run(checkout(), subEv({}, 1100, "customer.subscription.created"), subEv({ cancel_at_period_end: true }, 1200), subEv({ cancel_at_period_end: true }, 1300));
  assert.deepEqual(dues, [null, "welcome", "cancel-scheduled", null]);
  assert.deepEqual(readerEmail(undefined, live({ welcomed_at: "t", cancel_at_period_end: true, current_period_end: 999 }), true),
    { kind: "cancel-scheduled", claim: "cancel_noted_at" });
});

test("readerEmail: cancel, resume, cancel again notes twice; a repeated cancel event notes once", () => {
  const { dues } = run(
    checkout(), subEv({}, 1100, "customer.subscription.created"),
    subEv({ cancel_at_period_end: true }, 1200), subEv({ cancel_at_period_end: true }, 1250),
    subEv({ cancel_at_period_end: false }, 1300), subEv({}, 1350),
    subEv({ cancel_at_period_end: true }, 1400), subEv({ cancel_at_period_end: true }, 1450),
  );
  assert.deepEqual(dues, [null, "welcome", "cancel-scheduled", null, null, null, "cancel-scheduled", null]);
});

test("readerEmail: a cancel_at date counts as a scheduled cancel", () => {
  const { dues } = run(checkout(), subEv({}, 1100, "customer.subscription.created"), subEv({ cancel_at: 5000 }, 1200));
  assert.deepEqual(dues, [null, "welcome", "cancel-scheduled"]);
});

test("readerEmail: welcome wins when welcome and cancel-scheduled are both due; the note follows on the next event", () => {
  const { dues } = run(checkout(), subEv({ cancel_at_period_end: true }, 1100, "customer.subscription.created"), subEv({ cancel_at_period_end: true }, 1200));
  assert.deepEqual(dues, [null, "welcome", "cancel-scheduled"]);
});

test("readerEmail: cancel-scheduled needs the paid period's end for the date, and a live plan", () => {
  const row = live({ welcomed_at: "t", cancel_at_period_end: true });
  assert.equal(readerEmail(undefined, row, true), null);
  assert.equal(readerEmail(undefined, { ...row, current_period_end: null }, true), null);
  assert.equal(readerEmail(undefined, { ...row, current_period_end: 9, sub_live: false }, true), null);
  assert.equal(readerEmail(undefined, { ...row, current_period_end: 9, cancel_noted_at: "t" }, true), null);
});

test("readerEmail: goodbye once when a welcomed plan ends", () => {
  const { dues } = run(
    checkout(), subEv({}, 1100, "customer.subscription.created"),
    subEv({ cancel_at_period_end: true }, 1200),
    subEv({ status: "canceled", cancel_at_period_end: true }, 1300, "customer.subscription.deleted"),
    subEv({ status: "canceled", cancel_at_period_end: true }, 1400, "customer.subscription.deleted"),
  );
  assert.deepEqual(dues, [null, "welcome", "cancel-scheduled", "goodbye", null]);
});

test("readerEmail: goodbye for a plan that ends without a cancel note, and for one that went live during the sandbox", () => {
  assert.equal(readerEmail(live(), live({ sub_live: false, status: "canceled" }), true).kind, "goodbye"); // old row was live
  assert.equal(readerEmail(undefined, live({ sub_live: false, status: "incomplete_expired", welcomed_at: "t" }), true).kind, "goodbye");
  assert.equal(readerEmail(live({ status: "past_due" }), live({ sub_live: false, status: "canceled" }), true).kind, "goodbye");
  assert.equal(readerEmail(live(), live({ sub_live: false, status: "canceled", goodbye_at: "t" }), true), null);
  assert.equal(readerEmail(live(), live({ sub_live: false, status: "canceled", email: undefined }), true), null);
  assert.equal(readerEmail(live(), live({ sub_live: false, status: "canceled" }), false), null);
  assert.equal(readerEmail(live({ status: "incomplete" }), live({ sub_live: false, status: "canceled" }), true), null); // never went live
});

test("readerEmail: a new plan after an ended one gets a welcome and, in time, a goodbye again", () => {
  const second = (s, extra = {}) => subEv({ id: "sub_2", ...extra }, s, "customer.subscription.created");
  const { dues } = run(
    checkout(), subEv({}, 1100, "customer.subscription.created"),
    subEv({ status: "canceled" }, 1200, "customer.subscription.deleted"),
    second(1300), subEv({ id: "sub_2", status: "canceled" }, 1400, "customer.subscription.deleted"),
  );
  assert.deepEqual(dues, [null, "welcome", "goodbye", "welcome", "goodbye"]);
});

test("applyEvent: reader-email claims set out of band survive later events and rev-style rewrites", () => {
  const claimed = { ...play(checkout(), subEv({}, 1100, "customer.subscription.created")), welcomed_at: "w", cancel_noted_at: "c", goodbye_at: "g" };
  const next = applyEvent(claimed, subEv({ cancel_at_period_end: true }, 1200), PROD).row;
  assert.equal(next.welcomed_at, "w");
  assert.equal(next.cancel_noted_at, "c");
  assert.equal(next.goodbye_at, "g");
  assert.equal(applyEvent(claimed, checkout("new@x.com", 1300), PROD).row.welcomed_at, "w");
  assert.equal(applyEvent(claimed, ev("customer.updated", { id: "cus_1", email: "n@x.com" }, 1300), PROD).row.welcomed_at, "w");
  // a double subscription (the first still live) is not a new plan
  assert.equal(applyEvent(claimed, subEv({ id: "sub_2" }, 1400), PROD).row.welcomed_at, "w");
});

test("applyEvent: resuming a cancel clears the note; the claim stays while the cancel stays scheduled", () => {
  const noted = { ...play(checkout(), subEv({ cancel_at_period_end: true })), cancel_noted_at: "c" };
  assert.equal(applyEvent(noted, subEv({ cancel_at_period_end: true }, 1300), PROD).row.cancel_noted_at, "c");
  assert.equal("cancel_noted_at" in applyEvent(noted, subEv({ cancel_at_period_end: false }, 1300), PROD).row, false);
});
