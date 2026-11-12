# Plan: paid newsletter on Stripe + AWS SES

Status: proposal, nothing built yet. Diagram: [`architecture.html`](architecture.html) (open it in a browser; its source is `architecture.archify.json`).

## Goal

Run the $7/month newsletter without a newsletter tool (Buttondown). Stripe takes the money; AWS keeps the subscriber list in sync and sends the letters.

1. A new paid subscriber is on the send list within seconds of checkout, and gets a welcome email.
2. A cancellation, a failed payment or an unsubscribe takes the reader off the list without manual work.
3. The author publishes an issue by uploading one Markdown file.

The static site does not change: every Subscribe button already goes to the Stripe Payment Link in `config.js`.

## Architecture

| Part | Job |
|---|---|
| Stripe Payment Link + Billing | Checkout, recurring billing, receipts, failed-payment retries, customer portal. **The source of truth** for who has paid. |
| `stripe-webhook` Lambda (Function URL) | Receives Stripe events, checks the `Stripe-Signature` header, writes the subscriber's current state to DynamoDB, sends the welcome and goodbye emails. |
| DynamoDB `subscribers` table | A projection of Stripe state that the sender can read fast. It can be rebuilt from Stripe at any time. |
| S3 `issues` bucket | The author uploads `issue.md`; the upload starts a send. |
| `send-issue` Lambda | Renders the Markdown to HTML and text, reads the active subscribers, sends one email each through SES. |
| `unsubscribe` Lambda (Function URL) | The one-click unsubscribe target. Tells Stripe to cancel at period end; the webhook then removes the reader from the list. |
| Amazon SES | Sends from a verified custom domain with DKIM. The account-level suppression list blocks addresses that bounced or complained. |
| SSM Parameter Store | Stripe secret key, webhook signing secret, unsubscribe HMAC key (SecureString). |

All AWS parts live in one account and one region, deployed with one AWS SAM template.

## Facts from the docs that shape the design

Checked on 2026-11-11.

- **SES needs a domain you control.** SES verifies a domain through DNS records, so `kitagrawal.github.io` cannot be a sending domain. Buy or use a custom domain (for example the letter's own name). [SES identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- **The SES sandbox** allows only verified recipients, 200 emails a day and 1 a second. Production access takes a request; AWS answers within about 96 hours. Start this early. [Production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- **Gmail and Yahoo bulk-sender rules**: SPF, DKIM and DMARC (`p=none` is enough), one-click unsubscribe (RFC 8058), spam rate under 0.3%. Yahoo asks that unsubscribes take effect within 2 days. [Gmail](https://support.google.com/a/answer/81126), [Yahoo](https://senders.yahooinc.com/best-practices/)
- **SES reputation limits**: a bounce rate of 5% puts the account under review, 10% can pause sending; for complaints the levels are 0.1% and 0.5%. [Reputation](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html)
- **Stripe events are not ordered and can repeat.** Dedupe on the event id, and do not trust the order of arrival. Live mode retries a failed delivery for up to 3 days. Verify the signature against the raw body. [Webhooks](https://docs.stripe.com/webhooks)
- **Use `customer.subscription.*` events for status**, not `checkout.session.completed` (that one is for fulfilment). A cancel-at-period-end shows as `cancel_at_period_end: true` on `customer.subscription.updated` while the status stays `active`; `customer.subscription.deleted` fires when it really ends. [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- **SES's own list management** (contact lists) adds the unsubscribe headers for you, but allows one contact list per account and cannot cancel a Stripe subscription. This plan sets the headers itself and uses its own `unsubscribe` Lambda instead. [List management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-list-management.html)
- **Price**: SES is $0.10 per 1,000 emails on the pay-as-you-go plan. [Pricing](https://aws.amazon.com/ses/pricing/)

## How each flow works

### Subscribe and billing changes

1. The reader pays through the Payment Link. Stripe creates a Customer and a Subscription.
2. Stripe sends `customer.subscription.created`. The webhook Lambda checks the signature, then skips the event if its id is already in the `events` table.
3. The Lambda **fetches the subscription from Stripe** instead of trusting the event body. This makes late or out-of-order events harmless: it always writes the latest state.
4. It writes the `subscribers` item and, the first time the status is `active`, sends the welcome email (a conditional write on `welcomed_at` stops a second one).

| Stripe event | Effect |
|---|---|
| `customer.subscription.created` / `.updated` | Upsert status, `cancel_at_period_end`, `current_period_end`, email, `email_opt_out` (from subscription metadata). |
| `customer.subscription.deleted` | Status `canceled`; send the goodbye email once. |
| `customer.updated` | Copy a changed email address. |
| `invoice.payment_failed` | Nothing extra: the status change arrives as `subscription.updated`. Stripe's own failed-payment emails handle dunning. |

**Who gets a letter**: status `active` or `trialing`, and `email_opt_out` is false. Proposed default for `past_due`: keep sending while Stripe retries the card, stop when it cancels.

### Publish an issue

1. The author uploads `drafts/<date>-<slug>.md` (front matter: `subject`). The send Lambda sends it **only to the author**, as a proof.
2. When it looks right, the author copies it to `issues/<date>-<slug>.md`. That starts the real send.
3. For each active subscriber, the Lambda first writes a `sends` item `(issue, customer)` with a condition that it does not exist yet, then calls SES `SendEmail`. A retry after a crash skips everyone already sent.
4. Each email carries a plain-text part, a "Manage billing" link to the Stripe customer portal, and `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.

The Lambda paces itself to the account's SES send rate (read it with `GetAccount`). One run of up to 15 minutes covers thousands of readers. Past that, put an SQS queue between the fan-out and the sends.

### Unsubscribe

1. The unsubscribe URL is `https://<function-url>/?c=<customer id>&t=<HMAC of the id>`. The token stops anyone from unsubscribing someone else.
2. A `POST` (the one-click header, or the button on the page) sets `cancel_at_period_end: true` and metadata `email_opt_out: true` on the subscription. A `GET` only shows a confirm page, because link scanners fetch every URL in an email.
3. Stripe sends `customer.subscription.updated`; the webhook writes `email_opt_out` and the reader gets no further letters. Billing stops at the end of the paid period.

### Bounces and complaints

The SES account-level suppression list blocks addresses that hard-bounced or complained. A CloudWatch alarm on the SES bounce and complaint rates warns well before the review levels. A Lambda that also marks these readers in DynamoDB can come later if needed.

## Data model (DynamoDB, on-demand)

| Table | Key | Attributes |
|---|---|---|
| `subscribers` | `customer_id` | `email`, `status`, `cancel_at_period_end`, `current_period_end`, `email_opt_out`, `welcomed_at`, `goodbye_at`, `updated_at` |
| `sends` | `issue_id`, `customer_id` | `sent_at`, `ses_message_id` |
| `events` | `event_id` | TTL of 30 days |

The list is small, so the send Lambda scans `subscribers` and filters. Add an index on `status` only if that gets slow.

## Cost at 200 readers, 4 issues a month

About 800 emails: $0.08 for SES. Lambda, DynamoDB, S3 and SSM stay inside the free tier. The domain costs about $10–15 a year; a Route 53 hosted zone adds $0.50 a month if DNS moves there.

## Build order

Each step can ship on its own.

1. **Domain and SES** (human steps): get the domain, add the SES Easy DKIM CNAMEs, a custom MAIL FROM, SPF and a DMARC `p=none` record. Request production access.
2. **Infrastructure skeleton**: SAM template with the three tables, the S3 bucket, the SSM parameters, and an alarm on Lambda errors.
3. **`stripe-webhook`**, in Stripe test mode. Test with `stripe listen --forward-to <function url>` and `stripe trigger customer.subscription.created`. Add a one-off **backfill script** that lists the existing live subscriptions and writes them to `subscribers`.
4. **`send-issue`** with the drafts-only path first, then the real path.
5. **`unsubscribe`** and the headers.
6. **Welcome and goodbye emails.**
7. **Go live**: live-mode keys and webhook endpoint, a real test subscription, then update `SETUP.md` and `README.md` here.

## Changes to this repo

None for the site. When the system is live, rewrite the newsletter section of `SETUP.md` to describe Stripe + SES instead of a newsletter tool.

## Decisions (2026-11-11)

- **Sending domain**: buy a domain for the letter. It is step 1 of the build order.
- **One-click unsubscribe**: letters stop at once and the subscription cancels at the end of the paid period. No refunds.
- **Code home**: a `newsletter/` folder in this repo (Lambdas, SAM template, backfill script, its own `package.json`). GitHub Pages will serve these files; they hold no secrets. Update `CLAUDE.md` and `README.md` when it lands, because the repo is no longer "no package manager".
- **PR #8** (formerly #7): keep its unsubscribe help page and the `book.html` script fix; drop the Buttondown docs.
