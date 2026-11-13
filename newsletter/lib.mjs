// Shared by the StripeSync and UnsubscribeUser Lambdas (zipped next to each index.mjs with rules.mjs).
// AWS SDK v3 ships with the Lambda Node runtime, so there is nothing to install.
// There is no Stripe API key: rows are built from signed webhook events only (see applyEvent).
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { verifySignature } from "./rules.mjs";

export * from "./rules.mjs";

const ssm = new SSMClient();
const sns = new SNSClient();
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

export async function getRow(customerId) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: { username: customerId } }));
  return Item;
}

// Read-modify-write of one row. change(row) returns { action: "write", row } | { action: "delete" }
// | { action: "skip" }. The write is conditioned on the row's rev, so two Lambdas changing the
// same row at once never lose an update: the loser re-reads and re-applies.
// Returns { action, row }.
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
        return { action: "write", row: item };
      }
      if (out.action === "delete" && old) {
        await db.send(new DeleteCommand({ TableName: TABLE, Key: { username: customerId }, ...same }));
        return { action: "delete" };
      }
      return { action: "skip", row: old };
    } catch (e) {
      if (e.name !== "ConditionalCheckFailedException") throw e;
    }
  }
  throw new Error(`saveRow ${customerId}: too many concurrent updates`);
}

// Email the owner through the unsubscribe SNS topic.
export async function notifyOwner(subject, text) {
  await sns.send(new PublishCommand({
    TopicArn: process.env.UNSUBSCRIBE_TOPIC_ARN,
    Subject: subject.slice(0, 100),
    Message: text,
  }));
}
