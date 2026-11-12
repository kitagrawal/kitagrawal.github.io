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

`unsubscribe.html` is where readers unsubscribe. Nothing on the site links to it and it is marked `noindex`; readers reach it only from the Unsubscribe link in a letter, which looks like `https://<your-site>/unsubscribe.html?c=<Stripe customer id>&t=<token>`. The reader types the email the letter was sent to, and the page posts `{ c, t, email }` to the `UnsubscribeUser` Lambda. The Lambda checks the token, checks the email against the subscribers table, then cancels the newsletter subscription in Stripe at the end of the paid period and stops letters at once. The reader never signs in to Stripe. Without `c` and `t` the page shows no form. To turn it on:

1. Run `newsletter/setup-unsubscribe.sh` (once). It prints the API URL.
2. Put that URL into `newsletter.unsubscribeApiUrl` in `config.js`. While it contains `REPLACE`, the form is disabled.
3. Test with a link from `newsletter/link.sh <cus_id> http://localhost:8000/unsubscribe.html` under `python3 -m http.server`.

The token is `base64url(HMAC-SHA256(key, customer id))` (`unsubscribeToken` in `newsletter/rules.mjs`), so nobody can unsubscribe someone else. Letters also carry the one-click mail headers that `setup-unsubscribe.sh` prints. Do not list `unsubscribe.html` in `robots.txt`, which is public and would stop search engines seeing the `noindex`.

To unsubscribe a reader yourself, use the Stripe Dashboard: cancel the subscription, or set its metadata `email_opt_out` to `true`. `StripeSync` copies every change into DynamoDB. Stripe is the source of truth; never edit the table by hand.

## 3. Deploy on GitHub Pages

1. Put every file in the root of the repo `<your-username>.github.io` (branch `main`).
2. **Settings -> Pages -> Deploy from a branch -> main -> / (root)**.
3. After a minute or two it is live at `https://<your-username>.github.io`.
