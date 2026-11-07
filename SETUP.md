# Setup: bookings, newsletter and topic requests

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

For either: in Stripe, enable **Settings -> Billing -> Customer portal** so subscribers can cancel themselves. Keep `newsletter.price` in `config.js` equal to the real price. While `subscribeUrl` contains `REPLACE`, the Subscribe buttons are greyed out.

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
