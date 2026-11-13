// StripeSync: the only Stripe webhook. There is no Stripe API key, so the table row is built from
// the signed events themselves (applyEvent in rules.mjs):
//   checkout.session.completed            the reader's email
//   customer.subscription.created/updated/deleted   the plan (including the owner's cancel)
//   customer.updated / customer.deleted   email change / remove the row
// Each half of the row keeps the time of the event it came from, so repeated or out-of-order
// events are harmless. A missed event is retried by Stripe for up to 3 days.
//
// After a write it may send a reader email (readerEmail in rules.mjs: welcome, cancel-scheduled,
// goodbye), each at most once: it claims the row's field (welcomed_at, cancel_noted_at, goodbye_at) with a
// conditional UpdateItem, then sends the Markdown in emails/ through SES. A failed send is logged and
// counted (ReaderEmailFailed), the claim is never undone and nothing retries, and the webhook still answers
// 200: nothing in the reader-email path can fail it. While SES is in the sandbox nothing is claimed or sent.
// Env for reader emails: FROM, REPLY_TO, CONFIG_SET, CANCEL_PAGE (set by setup-send.sh). Without them a
// due email is logged and skipped. No List-Unsubscribe headers (docs/adr/0002).
import { readFile } from "node:fs/promises";
import { SESv2Client, SendEmailCommand, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, TABLE, stripeEvent, saveRow, applyEvent, customerOf, productId, reply, readerEmail, cancelPageUrl, countMetric } from "./lib.mjs";
import { parseLetter, renderLetter } from "./letter.mjs";

const ses = new SESv2Client();
const ACCESS_TTL_MS = 10 * 60 * 1000;
let access; // { value, at }: SES production access, cached per warm container

// True only when SES says production access is on. A failed lookup counts as no access (logged).
async function productionAccess() {
  if (access && Date.now() - access.at < ACCESS_TTL_MS) return access.value;
  try {
    const account = await ses.send(new GetAccountCommand({}));
    access = { value: account.ProductionAccessEnabled === true, at: Date.now() };
    return access.value;
  } catch (e) {
    console.error(JSON.stringify({ readerEmail: "GetAccount failed, treated as no production access", error: e.name, message: e.message }));
    return false;
  }
}

// The claim, per kind: the field is unset and the row still is what made the email due. A write that
// lands in between (a resumed cancel, say) fails the claim and nothing is sent. rev goes up by one so a
// saveRow that read the row before the claim retries and keeps the claim field.
const GUARD = {
  welcome: "attribute_not_exists(#c) AND #live = :t",
  "cancel-scheduled": "attribute_not_exists(#c) AND #live = :t AND #cancel = :t",
  goodbye: "attribute_not_exists(#c) AND (#status = :canceled OR #status = :expired)",
};

async function claim(customerId, due) {
  const names = { "#c": due.claim, "#rev": "rev" };
  const values = { ":now": new Date().toISOString(), ":one": 1 };
  if (due.kind === "goodbye") {
    names["#status"] = "status";
    Object.assign(values, { ":canceled": "canceled", ":expired": "incomplete_expired" });
  } else {
    names["#live"] = "sub_live";
    values[":t"] = true;
    if (due.kind === "cancel-scheduled") names["#cancel"] = "cancel_at_period_end";
  }
  try {
    await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { username: customerId },
      UpdateExpression: "SET #c = :now ADD #rev :one",
      ConditionExpression: GUARD[due.kind],
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

// Never throws: the webhook must answer 200 whatever happens here.
async function readerEmails(customerId, old, row) {
  let due;
  try {
    // Cheap check first, so most events never call SES: is anything due if production access is on?
    due = readerEmail(old, row, true);
    if (!due) return;
    if (!(await productionAccess())) return console.log(JSON.stringify({ customerId, readerEmail: due.kind, skipped: "SES sandbox" }));
    const cfg = Object.fromEntries(["FROM", "REPLY_TO", "CONFIG_SET", "CANCEL_PAGE"].map((k) => [k, process.env[k]]));
    const missing = Object.keys(cfg).filter((k) => !cfg[k] || cfg[k].includes("REPLACE"));
    if (missing.length) throw new Error(`Not configured: ${missing.join(", ")}`);

    // Render before claiming: a broken copy file burns no claim, so the email goes out once it is fixed.
    const copy = parseLetter(await readFile(new URL(`./emails/${due.kind}.md`, import.meta.url), "utf8"));
    const fields = Number.isFinite(row.current_period_end) ? { until: row.current_period_end } : {};
    const { subject, html, text } = renderLetter({ ...copy, cancelUrl: cancelPageUrl(cfg.CANCEL_PAGE, customerId), fields });

    if (!(await claim(customerId, due))) return console.log(JSON.stringify({ customerId, readerEmail: due.kind, skipped: "claimed or no longer due" }));
    try { // from here the claim stays whatever happens: at most once
      const sent = await ses.send(new SendEmailCommand({
        FromEmailAddress: cfg.FROM,
        Destination: { ToAddresses: [row.email] },
        ReplyToAddresses: [cfg.REPLY_TO],
        ConfigurationSetName: cfg.CONFIG_SET,
        Content: { Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } },
        } },
      }));
      console.log(JSON.stringify({ customerId, readerEmail: due.kind, messageId: sent.MessageId }));
    } catch (e) {
      console.error(JSON.stringify({ customerId, readerEmail: due.kind, claimed: true, error: e.name, message: e.message }));
      await countMetric("ReaderEmailFailed");
    }
  } catch (e) {
    console.error(JSON.stringify({ customerId, readerEmail: due?.kind ?? null, error: e.name, message: e.message }));
    await countMetric("ReaderEmailFailed");
  }
}

export const handler = async (event) => {
  const { evt, response } = await stripeEvent(event);
  if (response) return response;

  const customerId = customerOf(evt);
  if (!customerId) return reply(200, `ignored ${evt.type}`);

  const prod = productId(); // throws -> 500 -> Stripe retries until it is set
  const { action, row, old } = await saveRow(customerId, (cur) => applyEvent(cur, evt, prod)); // throws -> 500 -> retry
  console.log(JSON.stringify({
    event: evt.id, type: evt.type, customerId, action, receives_letters: row?.receives_letters ?? null,
  }));
  if (action === "write") await readerEmails(customerId, old, row);
  return reply(200, "ok");
};
