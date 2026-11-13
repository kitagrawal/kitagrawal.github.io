# The cancel link is proved by the Stripe customer id alone

The cancel link carries only `?c=<Stripe customer id>`; the cancel Lambda sets the plan to cancel at period end for whoever holds that id, with no HMAC token and no typed email. We chose the fewest possible steps for the reader over forge-proof links. The risk is bounded: a customer id is hard to guess, a cancel only takes effect at period end and can be reversed in the Stripe dashboard, and the page gives the same answer for unknown, already-cancelled and failed cases, so it cannot be used to probe which ids exist.

## Considered Options

- Customer id + HMAC token (the old `t=` parameter): invisible to the reader and unforgeable, rejected to keep the link to one identifier. Old links still carry `t`; it is ignored.
- Token + typed email (the old unsubscribe form): rejected as an extra step.

## Consequences

- The Stripe restricted key gains "Subscriptions: Write" (and loses "Customer portal: Write"), so the Lambda can schedule a cancel for any customer id it is given.
- If abuse appears, put the token check back: `unsubscribeToken` and existing links already carry it.
