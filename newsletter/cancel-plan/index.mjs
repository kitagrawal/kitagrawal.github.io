// CancelPlan: end a reader's plan at the end of the paid period. One route on the HTTP API:
//
// POST /cancel   JSON { c } from the hidden unsubscribe.html page. The letter's Cancel link is
//   unsubscribe.html?c=<Stripe customer id>; the id alone is the proof (docs/adr/0001).
//
// Reads the reader's row, asks cancelDecision (rules.mjs) what to do, and for a live plan with no
// scheduled cancel sets cancel_at_period_end in Stripe. It never writes the table: StripeSync's
// webhook records the change. Answers 200 {done: true, until} (period end, unix seconds), or
// 200 {error: "support"} for every other case, in one shape so customer ids cannot be probed.
import { getRow, cancelDecision, cancelReply, cancelSubscription, json } from "./lib.mjs";

const SUPPORT = { error: "support" };

export const handler = async (event) => {
  let c;
  try {
    c = JSON.parse(Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8").toString("utf8"))?.c;
  } catch {}
  try {
    const row = typeof c === "string" && c.length < 64 ? await getRow(c) : undefined;
    const decision = cancelDecision(c, row);
    if (decision.action !== "cancel") return json(200, SUPPORT);
    const answer = cancelReply(await cancelSubscription(decision.subscription));
    console.log(JSON.stringify({ cancel: c, done: Boolean(answer.done) }));
    return json(200, answer);
  } catch (e) {
    console.error(JSON.stringify({ cancel: c, error: e.message }));
    return json(200, SUPPORT);
  }
};
