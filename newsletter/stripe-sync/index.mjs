// StripeSync: the only Stripe webhook. There is no Stripe API key, so the table row is built from
// the signed events themselves (applyEvent in rules.mjs):
//   checkout.session.completed            the reader's email
//   customer.subscription.created/updated/deleted   the plan (including the owner's cancel)
//   customer.updated / customer.deleted   email change / remove the row
// Each half of the row keeps the time of the event it came from, so repeated or out-of-order
// events are harmless. A missed event is retried by Stripe for up to 3 days.
import { stripeEvent, saveRow, applyEvent, customerOf, productId, reply } from "./lib.mjs";

export const handler = async (event) => {
  const { evt, response } = await stripeEvent(event);
  if (response) return response;

  const customerId = customerOf(evt);
  if (!customerId) return reply(200, `ignored ${evt.type}`);

  const prod = productId(); // throws -> 500 -> Stripe retries until it is set
  const { action, row } = await saveRow(customerId, (old) => applyEvent(old, evt, prod)); // throws -> 500 -> retry
  console.log(JSON.stringify({
    event: evt.id, type: evt.type, customerId, action, receives_letters: row?.receives_letters ?? null,
  }));
  return reply(200, "ok");
};
