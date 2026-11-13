// SendIssue: publishing a letter. The author uploads Markdown to the articles bucket; S3 invokes this
// for ObjectCreated on drafts/*.md and issues/*.md. sendPlan (rules.mjs) decides what the key means:
//   drafts/<name>.md  one proof to AUTHOR_EMAIL (subject "[Proof] ...", a sample Cancel link)
//   issues/<name>.md  the letter to every reader who receives letters, once per email address, each
//                     with their own Cancel link; refused (logged + metric RefusedSend) while SES is
//                     in the sandbox
// Before each SES send it claims (issue_id, email_lc) in the sends table with a conditional put, so a
// re-upload or a crashed run never sends a reader the same letter twice; a reader whose SES call
// fails with a known not-sent error (NOT_SENT below) has the claim removed, so a re-upload retries just
// that reader; any other failure (a timeout, a network error, MessageRejected, an unknown one) keeps the
// claim, because the letter may already be out, and records the error on the claim. A crash between the
// claim and the SES call leaves a claim with no message id: that reader is skipped on re-upload (at most
// once, never twice). A send that ends with failures or stops early for time counts the SendIncomplete
// metric (alarm newsletter-send-incomplete). No List-Unsubscribe headers (docs/adr/0002).
// Env: TABLE_NAME (subscribers), SENDS_TABLE, AUTHOR_EMAIL, REPLY_TO, FROM, CONFIG_SET, CANCEL_PAGE.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { ScanCommand, PutCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { db, TABLE, sendPlan, cancelPageUrl, countMetric } from "./lib.mjs";
import { parseLetter, renderLetter, SAMPLE_CANCEL_URL } from "./letter.mjs";

const s3 = new S3Client();
const ses = new SESv2Client();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFETY_MS = 20000; // stop sending this long before the timeout; a re-upload resumes

// Errors SES returns before it accepts a message: nothing was sent, so the claim is removed and a re-upload
// retries the reader. Anything else (timeout, network error, MessageRejected, unknown) may have been sent, so
// the claim stays: a reader skipped by mistake is better than a letter sent twice.
const NOT_SENT = new Set([
  "TooManyRequestsException", "LimitExceededException", "ThrottlingException", "SendingPausedException",
  "MailFromDomainNotVerifiedException", "NotFoundException", "BadRequestException", "AccessDeniedException",
  "AccountSuspendedException",
]);
// Several failures in a row point at an account-wide problem (identity, DKIM, account): stop the run so it
// does not claim the whole list. SendIncomplete alarms; see PLAN.md for clearing the failed claims.
const MAX_FAILURES_IN_A_ROW = 5;
const THROTTLED = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException"]);

const env = () => {
  const e = Object.fromEntries(["SENDS_TABLE", "AUTHOR_EMAIL", "REPLY_TO", "FROM", "CONFIG_SET", "CANCEL_PAGE"].map((k) => [k, process.env[k]]));
  const missing = Object.keys(e).filter((k) => !e[k] || e[k].includes("REPLACE"));
  if (!TABLE) missing.push("TABLE_NAME");
  if (missing.length) throw new Error(`Not configured: ${missing.join(", ")}`);
  return e;
};

// S3 event keys are URL-encoded, with "+" for a space.
const decodeKey = (k) => decodeURIComponent(k.replace(/\+/g, " "));

const send = (cfg, to, { subject, html, text }) =>
  ses.send(new SendEmailCommand({
    FromEmailAddress: cfg.FROM,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: [cfg.REPLY_TO],
    ConfigurationSetName: cfg.CONFIG_SET,
    Content: { Simple: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } },
    } },
  }));

async function readers() {
  const rows = [];
  let key;
  do {
    const r = await db.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: "#u, #e, #l, #r",
      FilterExpression: "#r = :t",
      ExpressionAttributeNames: { "#u": "username", "#e": "email", "#l": "email_lc", "#r": "receives_letters" },
      ExpressionAttributeValues: { ":t": true },
      ExclusiveStartKey: key,
    }));
    rows.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return rows;
}

async function publish(cfg, bucket, key, context) {
  const first = sendPlan(key, [], false); // routes the key; proofs and ignored keys need no account or table read
  if (first.mode === "ignore") return console.warn(JSON.stringify({ key, mode: "ignore", note: "key is not drafts/<name>.md or issues/<name>.md" }));

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const letter = parseLetter(await obj.Body.transformToString("utf8")); // throws without a subject: nothing is sent

  if (first.mode === "proof") {
    const mail = renderLetter({ ...letter, subject: `[Proof] ${letter.subject}`, cancelUrl: SAMPLE_CANCEL_URL });
    await send(cfg, cfg.AUTHOR_EMAIL, mail);
    return console.log(JSON.stringify({ key, mode: "proof", issueId: first.issueId }));
  }

  const account = await ses.send(new GetAccountCommand({}));
  const production = account.ProductionAccessEnabled === true;
  const plan = production ? sendPlan(key, await readers(), true) : first;
  if (plan.mode === "refuse") {
    console.error(JSON.stringify({ key, mode: "refuse", issueId: plan.issueId, reason: plan.reason }));
    return countMetric("RefusedSend");
  }

  const issueId = plan.issueId;
  const interval = 1000 / (account.SendQuota?.MaxSendRate > 0 ? account.SendQuota.MaxSendRate : 1);
  const stats = { sent: 0, skipped: 0, failed: 0, stopped: false };
  let failuresInARow = 0;
  let next = Date.now();
  for (const r of plan.recipients) {
    if (context?.getRemainingTimeInMillis?.() < SAFETY_MS) { stats.stopped = true; break; }
    const Key = { issue_id: issueId, email_lc: r.emailLc };
    try {
      await db.send(new PutCommand({
        TableName: cfg.SENDS_TABLE,
        Item: { ...Key, customer_id: r.customerId, claimed_at: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(email_lc)",
      }));
    } catch (e) {
      if (e.name === "ConditionalCheckFailedException") { stats.skipped++; continue; }
      throw e;
    }
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    next = Math.max(next, Date.now()) + interval;
    let id;
    try {
      const mail = renderLetter({ ...letter, cancelUrl: cancelPageUrl(cfg.CANCEL_PAGE, r.customerId) });
      id = (await send(cfg, r.email, mail)).MessageId;
    } catch (e) {
      stats.failed++;
      // Throttling is the rate, not the account: it does not count toward the stop (the claim is removed anyway).
      if (!THROTTLED.has(e.name)) failuresInARow++;
      console.error(JSON.stringify({ issueId, customerId: r.customerId, error: e.name, message: e.message }));
      try {
        if (NOT_SENT.has(e.name)) await db.send(new DeleteCommand({ TableName: cfg.SENDS_TABLE, Key })); // a re-upload retries this reader
        else {
          await db.send(new UpdateCommand({
            TableName: cfg.SENDS_TABLE, Key,
            UpdateExpression: "SET #e = :e",
            ExpressionAttributeNames: { "#e": "error" },
            ExpressionAttributeValues: { ":e": `${e.name}: ${e.message}`.slice(0, 500) },
          }));
          console.error(JSON.stringify({ issueId, customerId: r.customerId, claimKept: true, note: "the letter may have been sent; a re-upload skips this reader" }));
        }
      } catch (e2) {
        console.error(JSON.stringify({ issueId, customerId: r.customerId, error: "could not update the claim", message: e2.message }));
      }
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        stats.stopped = true;
        console.error(JSON.stringify({ issueId, error: `stopped after ${failuresInARow} failures in a row` }));
        break;
      }
      continue;
    }
    failuresInARow = 0;
    stats.sent++;
    try {
      await db.send(new UpdateCommand({
        TableName: cfg.SENDS_TABLE, Key,
        UpdateExpression: "SET ses_message_id = :m, sent_at = :t",
        ExpressionAttributeValues: { ":m": id, ":t": new Date().toISOString() },
      }));
    } catch (e) { // the letter is out and the claim stays, so it is never sent twice
      console.error(JSON.stringify({ issueId, customerId: r.customerId, messageId: id, error: "could not store message id", message: e.message }));
    }
  }
  console.log(JSON.stringify({ key, mode: "send", issueId, recipients: plan.recipients.length, ...stats }));
  if (stats.failed > 0 || stats.stopped) {
    console.error(JSON.stringify({ key, issueId, error: "send incomplete", failed: stats.failed, stopped: stats.stopped, note: "re-upload retries readers whose claim was removed" }));
    await countMetric("SendIncomplete");
  }
}

export const handler = async (event, context) => {
  const cfg = env(); // throws when a placeholder is unset -> Lambda error -> alarm
  for (const rec of event.Records ?? []) {
    await publish(cfg, rec.s3.bucket.name, decodeKey(rec.s3.object.key), context);
  }
};
