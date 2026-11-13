// Shared by the StripeSync, CancelPlan and SendIssue Lambdas (zipped next to each index.mjs with rules.mjs).
// AWS SDK v3 ships with the Lambda Node runtime, so there is nothing to install.
// Rows are built from signed webhook events only (see applyEvent). The one Stripe key is a restricted
// key (rk_) with only "Subscriptions: Write"; CancelPlan uses it to schedule a cancel (cancelSubscription).
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { verifySignature, cancelForm, restrictedKey } from "./rules.mjs";

export * from "./rules.mjs";

const ssm = new SSMClient();
const secrets = new SecretsManagerClient();
export const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export const TABLE = process.env.TABLE_NAME;
const cache = new Map();

export const reply = (statusCode, body, headers) => ({ statusCode, body, headers });
export const json = (statusCode, obj) =>
  reply(statusCode, JSON.stringify(obj), { "content-type": "application/json", "cache-control": "no-store" });

// Throws when unset: an empty product filter would skip every newsletter event.
export function productId() {
  const id = process.env.NEWSLETTER_PRODUCT_ID;
  if (!id || !id.startsWith("prod_") || id === "prod_XXXX") throw new Error("NEWSLETTER_PRODUCT_ID is not set");
  return id;
}

// SecureString from SSM, cached per warm container; fresh = true re-reads it.
export async function param(name, fresh = false) {
  if (fresh || !cache.has(name)) {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    cache.set(name, r.Parameter.Value);
  }
  return cache.get(name);
}

// Returns { evt } for a correctly signed Stripe event, or { response } to send back.
export async function stripeEvent(event) {
  const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  const header = event.headers?.["stripe-signature"];
  const name = process.env.WEBHOOK_SECRET_PARAM;
  let ok;
  try {
    // On a mismatch, re-read the secret once so a rotated secret works without a cold start.
    ok = verifySignature(raw, header, await param(name)) || verifySignature(raw, header, await param(name, true));
  } catch (e) {
    console.error("Cannot read", name, e.name);
    return { response: reply(500, "Webhook secret not configured") }; // Stripe retries
  }
  if (!ok) return { response: reply(400, "Bad signature") };
  return { evt: JSON.parse(raw.toString("utf8")) };
}

// The restricted Stripe key from Secrets Manager (STRIPE_SECRET_ID), cached per warm container.
let stripeKeyCache;
async function stripeKey(id, fresh) {
  if (fresh || !stripeKeyCache) {
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
    stripeKeyCache = restrictedKey(r.SecretString);
  }
  if (!stripeKeyCache) throw new Error("secret holds no rk_ restricted key");
  return stripeKeyCache;
}

// Ask Stripe to end a subscription at the end of its paid period. The key is a restricted key (rk_)
// with only "Subscriptions: Write"; a full sk_ key is refused. Returns Stripe's reply (the updated
// subscription, or its error object), or null when the key is missing or the call fails.
export async function cancelSubscription(subscription) {
  const id = process.env.STRIPE_SECRET_ID;
  if (!id) return null;
  const call = async (fresh) => fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscription)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await stripeKey(id, fresh)}`, "content-type": "application/x-www-form-urlencoded" },
    body: cancelForm(),
    signal: AbortSignal.timeout(8000),
  });
  try {
    let res = await call(false);
    if (res.status === 401) res = await call(true); // key rotated: re-read the secret once
    return await res.json();
  } catch (e) {
    console.error(JSON.stringify({ cancel: subscription, error: e.message }));
    return null;
  }
}

export async function getRow(customerId) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: { username: customerId } }));
  return Item;
}

// Read-modify-write of one row. change(row) returns { action: "write", row } | { action: "delete" }
// | { action: "skip" }. The write is conditioned on the row's rev, so two Lambdas changing the
// same row at once never lose an update: the loser re-reads and re-applies.
// Returns { action, row, old }: row is the row as now stored, old the row before this call (undefined
// when there was none), so a caller can tell what changed.
export async function saveRow(customerId, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const old = await getRow(customerId);
    const out = change(old);
    const same = old
      ? { ConditionExpression: "#rev = :rev", ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": old.rev ?? 0 } }
      : { ConditionExpression: "attribute_not_exists(username)" };
    if (old && old.rev === undefined) { // rows written before rev existed
      same.ConditionExpression = "attribute_not_exists(#rev)";
      delete same.ExpressionAttributeValues;
    }
    try {
      if (out.action === "write") {
        const { username: _u, rev: _r, ...fields } = out.row;
        const item = { ...fields, username: customerId, rev: (old?.rev ?? 0) + 1, updated_at: new Date().toISOString() };
        await db.send(new PutCommand({ TableName: TABLE, Item: item, ...same }));
        return { action: "write", row: item, old };
      }
      if (out.action === "delete" && old) {
        await db.send(new DeleteCommand({ TableName: TABLE, Key: { username: customerId }, ...same }));
        return { action: "delete", old };
      }
      return { action: "skip", row: old, old };
    } catch (e) {
      if (e.name !== "ConditionalCheckFailedException") throw e;
    }
  }
  throw new Error(`saveRow ${customerId}: too many concurrent updates`);
}

// Add 1 to a custom CloudWatch metric in namespace "Newsletter" (alarms read these, e.g. RefusedSend,
// ReaderEmailFailed). The role needs cloudwatch:PutMetricData for that namespace. Never throws: a
// metric that cannot be written is logged and must not hide the problem it reports.
export async function countMetric(name) {
  try {
    const { CloudWatchClient, PutMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
    await new CloudWatchClient().send(new PutMetricDataCommand({
      Namespace: "Newsletter",
      MetricData: [{ MetricName: name, Value: 1, Unit: "Count" }],
    }));
  } catch (e) {
    console.error(JSON.stringify({ metric: name, error: e.message }));
  }
}
