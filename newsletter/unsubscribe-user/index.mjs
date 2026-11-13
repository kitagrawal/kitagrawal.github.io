// UnsubscribeUser: stop letters, with proof. Two routes on the HTTP API:
//
// POST /unsubscribe            JSON { c, t, email } from the hidden unsubscribe.html page.
//   The letter's link is unsubscribe.html?c=<customer id>&t=<token>; the token proves the caller
//   has the letter, and the typed email must match the table row for that customer.
// POST /unsubscribe/one-click?c&t   The mail header List-Unsubscribe-Post (RFC 8058). Token only.
//
// Either way the row gets email_opt_out, so receives_letters is false at once. Billing is not
// changed here: while the plan still bills the answer says so ({billing: true}), and the page's
// "Cancel my plan" button posts { c, t, email, portal: true } for a Stripe customer-portal link that
// opens on "Cancel subscription" with no login. The reader confirms there; the cancel comes back
// through StripeSync's webhook.
// Answers: 200 {done, billing}, 200 {billing, portal: url|null}, 400 {error: "link"|"email"},
// 502 {error: "server"}.
import { param, checkToken, sameEmail, optOut, stillBilling, getRow, saveRow, json, portalCancelUrl } from "./lib.mjs";

function readBody(event) {
  const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8").toString("utf8");
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

export const handler = async (event) => {
  const oneClick = event.rawPath?.endsWith("/one-click");
  const q = event.queryStringParameters ?? {};
  const body = oneClick ? {} : readBody(event);
  const c = oneClick ? q.c : body.c;
  const t = oneClick ? q.t : body.t;

  if (!checkToken(c, t, await param(process.env.HMAC_KEY_PARAM))) return json(400, { error: "link" });

  const row = await getRow(c);
  if (!oneClick && (!row || !sameEmail(row.email, body.email))) return json(400, { error: "email" });
  // The cancel button: same proof as unsubscribing (token + matching email), so it may open the portal.
  if (!oneClick && body.portal === true) {
    const billing = stillBilling(row);
    return json(200, { billing, portal: billing ? await portalCancelUrl(c, row.subscription_id) : null });
  }
  // No row: not a reader we know, so there is nothing to stop.
  if (!row) return json(200, { done: true, billing: false });
  if (row.email_opt_out === true) return json(200, { done: true, billing: stillBilling(row) });

  try {
    await saveRow(c, (old) => (old ? { action: "write", row: optOut(old, Math.floor(Date.now() / 1000)) } : { action: "skip" }));
  } catch (e) {
    console.error(JSON.stringify({ unsubscribe: c, error: e.message }));
    return json(502, { error: "server" });
  }
  console.log(JSON.stringify({ unsubscribed: c, billing: stillBilling(row) }));
  return json(200, { done: true, billing: stillBilling(row) });
};
