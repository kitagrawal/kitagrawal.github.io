# Setup: bookings, newsletter and topic requests

Everything is static and deploys on GitHub Pages. You only edit **`config.js`**.

## 1. Consultations (Cal.com)

1. Create a Cal.com event type (e.g. 60 min).
2. Set `cal.bookLink` to `<cal-username>/<event-slug>`. If your account is on the EU server, set `cal.origin` to `https://cal.eu`.
3. Optional payment: in Cal.com open **Apps -> Stripe**, connect Stripe, then on the event turn on **Accept payments** and set the price. Keep `consultations[0].price` in `config.js` the same.

"Book an appointment" (home page) and "Pick a time" (`book.html`) open the event in a popup. While `bookLink` contains `REPLACE`, they show "Coming soon".

## 2. Newsletter (Buttondown + Stripe)

Buttondown keeps the subscriber list, sends the letters, runs checkout through your Stripe account and handles unsubscribes. Nothing runs on this site: every Subscribe button (`data-subscribe`) links to your Buttondown subscribe page.

1. Create a Buttondown account and newsletter named **The Applied AI Letter**. Paid letters need a paid Buttondown plan; check [buttondown.com/pricing](https://buttondown.com/pricing).
2. Connect Stripe: in Buttondown open **Settings -> Paid subscriptions** and approve the connection in Stripe ([docs](https://docs.buttondown.com/stripe)). A Stripe account serves one Buttondown newsletter.
3. On the **Paid subscriptions** page, choose the Stripe product, USD and a monthly price equal to `newsletter.price` in `config.js` ($7) ([docs](https://docs.buttondown.com/paid-subscriptions)).
4. Set your sending domain in Buttondown (for example `letter@yourdomain.com`) and add the DNS records it shows, so letters do not land in spam.
5. Copy your newsletter's public subscribe page link from Buttondown into `newsletter.subscribeUrl`. It must start with `https://`.
6. Test with a real card: Buttondown does not support Stripe test mode, so subscribe once yourself, then refund and cancel it in Stripe.

Subscribers cancel through the Unsubscribe link in every letter; for a paid subscriber that also stops billing at the end of the current period ([docs](https://docs.buttondown.com/paid-subscriptions)). `unsubscribe.html` explains this to readers. No page on the site links to it and it is marked `noindex`, so readers reach it only from the letters: add a link to `https://<your-site>/unsubscribe.html` in your Buttondown email footer, next to the Unsubscribe link. Do not list it in `robots.txt`, which is public and would stop search engines seeing the `noindex`. Buttondown no longer lets you redirect its unsubscribe confirmation to your own page, so readers land on Buttondown's page after they click the link. While `subscribeUrl` contains `REPLACE`, the Subscribe buttons are greyed out.

Buttondown's list is the source of truth for who gets the letter, and Stripe is the source of truth for who paid. Do not keep a second subscriber list in this repo or in a Sheet.

## 3. Topic requests (Formspree)

`topics.html` lets visitors vote for topics from `topics.list` in `config.js` and suggest their own. Requests go to a Formspree form.

1. Sign up at formspree.io and create a form. Copy its endpoint (`https://formspree.io/f/<id>`) into `topics.formEndpoint`.
2. In the form's settings, add your site's domain under **Restrict to domain** so other sites can't post to it.
3. Edit `topics.list` to the topics you are weighing. Keep the wording fixed once votes come in: the ranking counts by the exact text.

While `formEndpoint` contains `REPLACE`, the page shows "Setup needed" and the button is disabled.

**Find the most requested topic.** In Formspree open the form, choose **Export -> CSV**, then run:

```bash
node scripts/rank-topics.mjs ~/Downloads/<export>.csv
```

It prints each topic's votes and share of requests, groups similar free-text suggestions, and names the most requested topic. A person who gives the same email more than once counts once (their latest request). Keep the export out of the repo: it holds emails, and the repo is public (`.gitignore` skips `*.csv`).

Formspree's free plan accepts 50 submissions a month. Past that, upgrade, or point `formEndpoint` at another service that takes a form POST and returns JSON (Getform, Basin).

## 4. Deploy on GitHub Pages

1. Put every file in the root of the repo `<your-username>.github.io` (branch `main`).
2. **Settings -> Pages -> Deploy from a branch -> main -> / (root)**.
3. After a minute or two it is live at `https://<your-username>.github.io`.
