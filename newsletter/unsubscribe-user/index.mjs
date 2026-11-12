// UnsubscribeUser: stop letters, with proof. Two routes on the HTTP API:
//
// POST /unsubscribe            JSON { c, t, email } from the hidden unsubscribe.html page.
//   The letter's link is unsubscribe.html?c=<customer id>&t=<token>; the token proves the caller
//   has the letter, and the typed email must match the table row for that customer.
// POST /unsubscribe/one-click?c&t   The mail header List-Unsubscribe-Post (RFC 8058). Token only.
//
// Either way: cancel the customer's newsletter subscriptions at period end and set metadata
// email_opt_out, then syncCustomer so the row reads receives_letters: false at once.
// Answers: 200 {done}, 400 {error: "link"|"email"}, 502 {error: "stripe"}.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  param, stripeList, stripeApi, syncCustomer, checkToken, sameEmail, isNewsletter, isEnded,
  productId, db, TABLE, json,
} from "./lib.mjs";

function readBody(event) {
  const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8").toString("utf8");
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

async function stopLetters(customerId) {
  const prod = productId();
  const subs = await stripeList(`subscriptions?customer=${encodeURIComponent(customerId)}&status=all`);
  let cancelled = 0;
  for (const s of subs) {
    if (!isNewsletter(s, prod) || isEnded(s.status)) continue;
    if (s.cancel_at_period_end && s.metadata?.email_opt_out === "true") continue;
    await stripeApi("POST", `subscriptions/${s.id}`, {
      cancel_at_period_end: "true",
      "metadata[email_opt_out]": "true",
    });
    cancelled++;
  }
  const sync = await syncCustomer(customerId);
  console.log(JSON.stringify({ unsubscribed: customerId, cancelled, ...sync }));
}

export const handler = async (event) => {
  const oneClick = event.rawPath?.endsWith("/one-click");
  const q = event.queryStringParameters ?? {};
  const body = oneClick ? {} : readBody(event);
  const c = oneClick ? q.c : body.c;
  const t = oneClick ? q.t : body.t;

  if (!checkToken(c, t, await param(process.env.HMAC_KEY_PARAM))) return json(400, { error: "link" });

  const { Item: row } = await db.send(new GetCommand({ TableName: TABLE, Key: { username: c } }));
  if (!oneClick && (!row || !sameEmail(row.email, body.email))) return json(400, { error: "email" });
  // No row: not a reader (or the customer was deleted), so there is nothing to stop.
  if (!row) return json(200, { done: true });
  // Already off the list. Only an explicit false counts, so a row from before the
  // receives_letters field existed still goes through Stripe.
  if (row?.receives_letters === false) return json(200, { done: true });

  try {
    await stopLetters(c);
  } catch (e) {
    console.error(JSON.stringify({ unsubscribe: c, error: e.message }));
    return json(502, { error: "stripe" });
  }
  return json(200, { done: true });
};
