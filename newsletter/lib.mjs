// Shared by the StripeSync and UnsubscribeUser Lambdas (zipped next to each index.mjs with rules.mjs).
// AWS SDK v3 ships with the Lambda Node runtime, so there is nothing to install.
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { verifySignature, projectCustomer, rowChanged, ROW_FIELDS } from "./rules.mjs";

export * from "./rules.mjs";

// projectCustomer reads the response shape of this version; change it only with the tests.
export const STRIPE_VERSION = "2025-03-31.basil";

const ssm = new SSMClient();
export const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export const TABLE = process.env.TABLE_NAME;
const cache = new Map();

export const reply = (statusCode, body, headers) => ({ statusCode, body, headers });
export const json = (statusCode, obj) =>
  reply(statusCode, JSON.stringify(obj), { "content-type": "application/json", "cache-control": "no-store" });

// Throws when unset: an empty product filter would mark every reader as not receiving letters.
export function productId() {
  const id = process.env.NEWSLETTER_PRODUCT_ID;
  if (!id || !id.startsWith("prod_")) throw new Error("NEWSLETTER_PRODUCT_ID is not set");
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

export async function stripeApi(method, path, form) {
  const key = await param(process.env.STRIPE_KEY_PARAM);
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: form && new URLSearchParams(form),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(`Stripe ${method} ${path.split("?")[0]}: ${res.status} ${body.error?.message}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Every item of a Stripe list, following has_more / starting_after.
export async function stripeList(path) {
  const all = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let after; ;) {
    const page = await stripeApi("GET", `${path}${sep}limit=100${after ? `&starting_after=${after}` : ""}`);
    all.push(...page.data);
    if (!page.has_more || !page.data.length) return all;
    after = page.data.at(-1).id;
  }
}

// Write a projected row (or delete it when row is null). fetchedAt is when the Stripe data was
// read: a write from an older read never replaces a newer one, so racing webhooks are harmless.
// Returns "changed" | "unchanged" | "stale" | "deleted".
export async function writeRow(customerId, row, fetchedAt) {
  if (!row) {
    const r = await db.send(new DeleteCommand({ TableName: TABLE, Key: { username: customerId }, ReturnValues: "ALL_OLD" }));
    return r.Attributes ? "deleted" : "unchanged";
  }
  const names = {}, values = { ":at": fetchedAt }, sets = ["#synced_at = :at"];
  names["#synced_at"] = "synced_at";
  for (const k of ROW_FIELDS) {
    names[`#${k}`] = k;
    values[`:${k}`] = row[k] ?? null;
    sets.push(`#${k} = :${k}`);
  }
  try {
    const r = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { username: customerId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_not_exists(#synced_at) OR #synced_at < :at",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_OLD",
    }));
    return rowChanged(r.Attributes, row) ? "changed" : "unchanged";
  } catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    return "stale";
  }
}

async function getCustomer(customerId) {
  try {
    return await stripeApi("GET", `customers/${encodeURIComponent(customerId)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// The one way Stripe state reaches the table: fetch the customer and all its subscriptions,
// project them to a row, write it. Safe to call any number of times, in any order.
export async function syncCustomer(customerId) {
  const prod = productId();
  const fetchedAt = new Date().toISOString();
  const customer = await getCustomer(customerId);
  const subs = customer && !customer.deleted
    ? await stripeList(`subscriptions?customer=${encodeURIComponent(customerId)}&status=all`)
    : [];
  const row = projectCustomer(customer, subs, prod);
  const result = await writeRow(customerId, row, fetchedAt);
  return { customerId, result, receives_letters: row?.receives_letters ?? null };
}
