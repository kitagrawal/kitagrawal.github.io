// StripeSync: the only Stripe webhook, and the nightly reconcile.
// Webhook: every handled event names a customer; syncCustomer re-reads it from Stripe and writes
// the table row, so repeated, missed or out-of-order events are harmless.
// Reconcile: a direct invoke with {"reconcile": true} (EventBridge Scheduler, nightly) repairs any
// row a missed webhook left wrong.
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  stripeEvent, syncCustomer, stripeList, writeRow, projectCustomer, isNewsletter, isEnded,
  productId, db, TABLE, reply,
} from "./lib.mjs";

const CUSTOMER_OF = {
  "customer.subscription.created": (o) => o.customer,
  "customer.subscription.updated": (o) => o.customer,
  "customer.subscription.deleted": (o) => o.customer,
  "customer.updated": (o) => o.id,
  "customer.deleted": (o) => o.id,
};

async function scanTable() {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: "username, receives_letters, #status",
      ExpressionAttributeNames: { "#status": "status" },
      ExclusiveStartKey,
    }));
    rows.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function reconcile() {
  const prod = productId();
  const fetchedAt = new Date().toISOString();
  const counts = { live: 0, scanned: 0, changed: 0, unchanged: 0, stale: 0, deleted: 0, errors: 0 };
  const tally = (result) => { counts[result] = (counts[result] ?? 0) + 1; };

  // 1. Every customer with a live newsletter subscription, projected from the list itself.
  const byCustomer = new Map();
  for (const status of ["active", "trialing", "past_due"]) {
    for (const s of await stripeList(`subscriptions?status=${status}&expand[]=data.customer`)) {
      if (!isNewsletter(s, prod)) continue;
      const id = typeof s.customer === "string" ? s.customer : s.customer.id;
      const entry = byCustomer.get(id) ?? { customer: s.customer, subs: [] };
      entry.subs.push(s);
      byCustomer.set(id, entry);
    }
  }
  counts.live = byCustomer.size;
  for (const [id, { customer, subs }] of byCustomer) {
    try {
      tally(await writeRow(id, projectCustomer(customer, subs, prod), fetchedAt));
    } catch (e) {
      counts.errors++;
      console.error(JSON.stringify({ reconcile: id, error: e.message }));
    }
  }

  // 2. Rows not in that list: re-read the ones that could still be wrong. A row already marked
  // ended and not receiving letters is final (a resubscribe is a new, live subscription above).
  const rows = await scanTable();
  counts.scanned = rows.length;
  for (const row of rows) {
    if (byCustomer.has(row.username)) continue;
    if (row.receives_letters === false && isEnded(row.status)) continue;
    try {
      tally((await syncCustomer(row.username)).result);
    } catch (e) {
      counts.errors++;
      console.error(JSON.stringify({ reconcile: row.username, error: e.message }));
    }
  }

  console.log(JSON.stringify({ reconcile: counts }));
  // Throwing marks the invocation failed, which the StripeSync-errors alarm watches.
  if (counts.errors) throw new Error(`Reconcile: ${counts.errors} customer(s) failed`);
  return counts;
}

export const handler = async (event) => {
  if (!event?.requestContext) {
    if (event?.reconcile === true) return reconcile();
    throw new Error("Direct invoke needs {\"reconcile\": true}");
  }

  const { evt, response } = await stripeEvent(event);
  if (response) return response;

  const customerOf = CUSTOMER_OF[evt.type];
  if (!customerOf) return reply(200, `ignored ${evt.type}`);
  const customerId = customerOf(evt.data.object);
  if (!customerId) return reply(200, "no customer");

  const result = await syncCustomer(customerId); // throws -> 500 -> Stripe retries
  console.log(JSON.stringify({ event: evt.id, type: evt.type, ...result }));
  return reply(200, "ok");
};
