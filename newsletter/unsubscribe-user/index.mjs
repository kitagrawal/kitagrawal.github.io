// UnsubscribeUser: stop letters, with proof. Two routes on the HTTP API:
//
// POST /unsubscribe            JSON { c, t, email } from the hidden unsubscribe.html page.
//   The letter's link is unsubscribe.html?c=<customer id>&t=<token>; the token proves the caller
//   has the letter, and the typed email must match the table row for that customer.
// POST /unsubscribe/one-click?c&t   The mail header List-Unsubscribe-Post (RFC 8058). Token only.
//
// Either way the row gets email_opt_out, so receives_letters is false at once. There is no Stripe
// API key, so billing is not touched here: while the plan still bills, the owner gets an SNS email
// and cancels it in the Stripe Dashboard; that change comes back through StripeSync's webhook.
// Answers: 200 {done}, 400 {error: "link"|"email"}, 502 {error: "server"}.
import { param, checkToken, sameEmail, optOut, stillBilling, getRow, saveRow, notifyOwner, json } from "./lib.mjs";

function readBody(event) {
  const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8").toString("utf8");
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

const ownerNote = (c, row) => [
  `${row.email ?? "(no email)"} unsubscribed from The Applied AI Letter. Letters have stopped.`,
  "",
  "Their plan still bills. Cancel it in Stripe (at period end):",
  row.subscription_id ? `https://dashboard.stripe.com/subscriptions/${row.subscription_id}` : `https://dashboard.stripe.com/customers/${c}`,
  "",
  `Customer: ${c}`,
  `Subscription: ${row.subscription_id ?? "-"} (${row.status ?? "-"})`,
].join("\n");

export const handler = async (event) => {
  const oneClick = event.rawPath?.endsWith("/one-click");
  const q = event.queryStringParameters ?? {};
  const body = oneClick ? {} : readBody(event);
  const c = oneClick ? q.c : body.c;
  const t = oneClick ? q.t : body.t;

  if (!checkToken(c, t, await param(process.env.HMAC_KEY_PARAM))) return json(400, { error: "link" });

  const row = await getRow(c);
  if (!oneClick && (!row || !sameEmail(row.email, body.email))) return json(400, { error: "email" });
  // No row: not a reader we know, so there is nothing to stop.
  if (!row || row.email_opt_out === true) return json(200, { done: true });

  try {
    // Tell the owner first: if the email fails, the reader's retry sends it again.
    if (stillBilling(row)) await notifyOwner(`Cancel newsletter plan: ${row.email ?? c}`, ownerNote(c, row));
    await saveRow(c, (old) => (old ? { action: "write", row: optOut(old, Math.floor(Date.now() / 1000)) } : { action: "skip" }));
  } catch (e) {
    console.error(JSON.stringify({ unsubscribe: c, error: e.message }));
    return json(502, { error: "server" });
  }
  console.log(JSON.stringify({ unsubscribed: c, notified: stillBilling(row) }));
  return json(200, { done: true });
};
