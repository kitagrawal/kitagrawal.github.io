# Setup: bookings, payments and the mailing list

Everything is static, so it deploys on GitHub Pages. Three outside services do the parts a static site can't. All have free tiers. On the site you only edit **`config.js`**.

| Need | Service | Cost |
|------|---------|------|
| Take payments | Stripe Payment Links | Per-transaction fee only |
| Pick a time | Cal.com or Calendly | Free tier |
| Store emails (CSV/Excel) | Google Sheet + Apps Script | Free |
| Mark who paid, daily | GitHub Actions + a read-only Stripe key | Free |

## 1. Stripe (payments)

1. Create an account at stripe.com and finish verification.
2. **Payment Links -> New**:
   - **Consultations:** a *one-time* product per session type (price of your choice).
   - **Mailing list:** a *recurring* product billed **monthly**. It renews automatically until the subscriber cancels. The list is paid-only: with no link in `config.js`, sign-ups stay disabled.
   - On the subscription link, enable **Require customers to accept your terms of service** (or add custom text) stating: *monthly auto-renewing subscription, non-refundable, cancel anytime*.
3. For each link, open **After payment -> Don't show confirmation page -> redirect to your website**:
   - Consultations: `https://<your-username>.github.io/thanks.html?type=consult`
   - Mailing list: `https://<your-username>.github.io/thanks.html?type=newsletter`
4. Paste each link into `config.js` (`stripeLink`) and update the displayed `price` text to match.
5. **Cancel-anytime:** go to **Settings -> Billing -> Customer portal**, turn it on, and allow customers to **cancel subscriptions** (choose "at end of billing period" to match the terms on the page). Copy the portal's shareable login link into `config.js` -> `newsletter.manageUrl`. It appears as "Manage or cancel your subscription" on `subscribe.html` and `thanks.html`.
6. **No refunds:** the page states payments are non-refundable and requires subscribers to tick a box acknowledging it. Don't issue refunds from Stripe unless you decide to make an exception. Some countries give consumers statutory cancellation or refund rights that a "no refunds" policy can't override, so check the rules where you sell.

> Never put a Stripe key in a repo file. Payment Links need none. The daily sync (section 4) uses a restricted read-only key stored as a GitHub Actions secret.

## 2. Scheduler (Cal.com or Calendly)

1. Create an event type (e.g. "60-min session").
2. Put its public URL in `config.js` -> `schedulerUrl`.
3. After paying, visitors land on `thanks.html?type=consult`, which embeds the scheduler.

**Heads-up:** that thank-you URL is not secret, so someone who knows it could book without paying. If that matters, use Cal.com's built-in Stripe payments instead. Install the Stripe app in Cal.com, require payment on the event, and leave the consultation's `stripeLink` unset. The "Pick a time" button then opens the scheduler and Cal.com collects payment during booking.

## 3. Mailing-list sheet (emails -> CSV/Excel)

1. Create a new Google Sheet (name it e.g. "Mailing list").
2. **Extensions -> Apps Script**. Delete the starter code and paste the contents of `apps-script/Code.gs`. Save.
3. **Deploy -> New deployment -> Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, authorise when asked, and copy the **Web app URL** (ends in `/exec`).
4. Paste that URL into `config.js` -> `signupEndpoint`.
5. Test: open `subscribe.html` on your live site, submit an email, and a row appears in the **Subscribers** tab.
6. Export any time: **File -> Download -> Comma-separated values (.csv)** or **Microsoft Excel (.xlsx)**.

If you change `Code.gs` later, use **Deploy -> Manage deployments -> Edit -> New version**, or the live URL keeps running the old code.

### What the Status column means

| Status | Meaning |
|--------|---------|
| `pending_payment` | Email saved, visitor sent to Stripe checkout |
| `returned_from_checkout` | Visitor reached the thank-you page after checkout. **Not proof of payment** |
| `active`, `trialing`, `past_due`, `unpaid`, `paused`, `incomplete`, `incomplete_expired`, `canceled` | Set by the daily Stripe sync (section 4). This is Stripe's own subscription status |

Stripe is the source of truth for who actually paid. The daily sync copies its status into the Sheet. Until the next sync runs, a new subscriber shows `pending_payment` or `returned_from_checkout`.

## 4. Daily Stripe sync (who actually paid)

A GitHub Action (`.github/workflows/stripe-sync.yml`) runs `scripts/stripe-sync.mjs` once a day at about 06:17 UTC. It reads every subscription on the newsletter price from Stripe and sends each subscriber's status to the Apps Script. The Apps Script updates only rows whose email is already in the Sheet. A subscriber who changed their email at checkout is skipped, so look them up in Stripe.

1. **Restricted key:** in Stripe, open **Developers -> API keys -> Create restricted key**. Give it **Read** on **Customers** and **Subscriptions** and nothing else. Start in test mode, then repeat in live mode when you go live. The script refuses a full `sk_` key.
2. **Price ID:** open the newsletter product in Stripe and copy its monthly price ID (`price_...`).
3. **Shared token:** make a long random string (for example `openssl rand -hex 32`).
4. In the Apps Script editor, open **Project Settings -> Script Properties** and add `SYNC_TOKEN` = the token. Then publish a new version (**Deploy -> Manage deployments -> Edit -> New version**) so the live URL runs the sync code.
5. In GitHub, open **Settings -> Secrets and variables -> Actions**:
   - Secrets: `STRIPE_KEY` = the restricted key, `SHEET_SYNC_TOKEN` = the token.
   - Variables: `NEWSLETTER_PRICE_ID` = the price ID.
6. Test: open **Actions -> Stripe newsletter sync -> Run workflow**. The log prints counts only (the repo is public, so it never prints emails). For example: `Rows updated: 1. Not in Sheet: 0.`

The Sheet URL comes from `signupEndpoint` in `config.js`, so there's nothing else to set. GitHub pauses scheduled workflows after 60 days with no repo activity, and emails you first. Re-enable it on the Actions tab.

## 5. Deploy on GitHub Pages

1. Put every file in this folder in the root of the repo `<your-username>.github.io` (branch `main`).
2. **Settings -> Pages -> Deploy from a branch -> main -> / (root)**.
3. After a minute or two it's live at `https://<your-username>.github.io`.

```bash
git add .
git commit -m "Add booking and mailing list pages"
git push
```

## Privacy and legal notes

- The sign-up form asks for explicit consent. Consider adding a short privacy policy and an unsubscribe process for your emails (e.g. CAN-SPAM, GDPR).
- Sending the newsletter itself needs an email tool (Buttondown, MailerLite, or Gmail mail-merge from the Sheet).
- Check Stripe's rules for your region and what you're allowed to sell.
