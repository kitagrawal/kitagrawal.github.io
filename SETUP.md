# Setup: bookings and newsletter

Everything is static and deploys on GitHub Pages. You only edit **`config.js`**.

## 1. Consultations (Cal.com)

1. Create a Cal.com event type (e.g. 60 min).
2. Set `cal.bookLink` to `<cal-username>/<event-slug>`. If your account is on the EU server, set `cal.origin` to `https://cal.eu`.
3. Optional payment: in Cal.com open **Apps -> Stripe**, connect Stripe, then on the event turn on **Accept payments** and set the price. Keep `consultations[0].price` in `config.js` the same.

"Book an appointment" (home page) and "Pick a time" (`book.html`) open the event in a popup. While `bookLink` contains `REPLACE`, they show "Coming soon".

## 2. Newsletter (Stripe, optionally through an email tool)

Every Subscribe button (`data-subscribe`) goes to `newsletter.subscribeUrl`. Use one of:

- **A newsletter tool's paid-subscribe page** (recommended). Tools such as Buttondown, beehiiv or Ghost connect to your Stripe account, run checkout, and keep an up-to-date list of active subscribers for you.
- **A plain Stripe recurring Payment Link.** Works for taking money, but Stripe is then the only subscriber list, and you must email subscribers from an export.

Keep `newsletter.price` in `config.js` equal to the real price. While `subscribeUrl` contains `REPLACE`, the Subscribe buttons are greyed out.

`unsubscribe.html` is where readers unsubscribe. Nothing on the site links to it and it is marked `noindex`; readers reach it only from the Unsubscribe link in a letter, which looks like `https://<your-site>/unsubscribe.html?c=<Stripe customer id>&t=<token>`. The reader types the email the letter was sent to, and the page posts `{ c, t, email }` to the `UnsubscribeUser` Lambda. The Lambda checks the token and the email against the subscribers table, stops letters at once. While the plan still bills, the page shows a "Cancel my plan in Stripe" button: it asks the Lambda for a Stripe customer-portal link that opens on "Cancel subscription" with no login, and the reader confirms there. Stripe's webhook brings the cancellation back into the table. The only Stripe key in AWS is a restricted one that can open portal pages and nothing else; you get no email. Without `c` and `t` the form is shown but disabled. To turn it on:

1. In Stripe turn on the customer portal (Settings → Billing → Customer portal, allow cancelling subscriptions) and copy its login link into `newsletter.portalUrl` in `config.js` (the fallback if the no-login link fails). Create a restricted key (Developers → API keys → Create restricted key) with only **Customer portal: Write**, and store it yourself in Secrets Manager (us-east-2) as `applied-ai-letter/stripe`, either the plain key or JSON holding it. Only an `rk_` key is used; a full `sk_` key is refused. Run `newsletter/setup-unsubscribe.sh` (once); it prints the API URL.
2. Put that URL into `newsletter.unsubscribeApiUrl` in `config.js`. While it contains `REPLACE`, the form is disabled.
3. Test with a link from `newsletter/link.sh <cus_id> http://localhost:8000/unsubscribe.html` under `python3 -m http.server`.

The token is `base64url(HMAC-SHA256(key, customer id))` (`unsubscribeToken` in `newsletter/rules.mjs`), so nobody can unsubscribe someone else. Letters also carry the one-click mail headers that `setup-unsubscribe.sh` prints. Do not list `unsubscribe.html` in `robots.txt`, which is public and would stop search engines seeing the `noindex`.

To unsubscribe a reader yourself, use the Stripe Dashboard: cancel the subscription, or set its metadata `email_opt_out` to `true`. `StripeSync` copies every change into DynamoDB from the webhook. Stripe is the source of truth for billing; never edit the table by hand.

The Stripe webhook: in the Stripe Dashboard → Developers → Webhooks, add an endpoint at `StripeSync`'s URL (`.../stripe/sync`) with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.updated` and `customer.deleted`. Store its signing secret yourself in SSM as `/newsletter/stripe-sync/webhook-secret` (SecureString). Subscribers from before the webhook existed appear in the table at their next renewal.

## 3. Deploy on GitHub Pages

1. Put every file in the root of the repo `<your-username>.github.io` (branch `main`).
2. **Settings -> Pages -> Deploy from a branch -> main -> / (root)**.
3. After a minute or two it is live at `https://<your-username>.github.io`.
