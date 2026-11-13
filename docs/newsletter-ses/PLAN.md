# Plan: paid newsletter on Stripe + AWS SES

Status: subscriber sync and unsubscribe built (see **Built so far**); SES sending, `send-issue` and the welcome email are not. Diagram: [`architecture.html`](architecture.html) (open it in a browser; its source is `architecture.archify.json`).

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
| `stripe-webhook` Lambda (API Gateway HTTP API, `POST /stripe/webhook`) | Receives Stripe events, checks the `Stripe-Signature` header, writes the subscriber's current state to DynamoDB, sends the welcome and goodbye emails. |
| DynamoDB `subscribers` table | A projection of Stripe state that the sender can read fast. It can be rebuilt from Stripe at any time. |
| S3 `issues` bucket | The author uploads `issue.md`; the upload starts a send. |
| `send-issue` Lambda | Renders the Markdown to HTML and text, reads the active subscribers, sends one email each through SES. |
| `unsubscribe` Lambda (API Gateway) | Stops letters at once and emails the owner, who cancels the plan in the Stripe Dashboard; the webhook then records the cancellation. |
| Amazon SES | Sends from a verified custom domain with DKIM. The account-level suppression list blocks addresses that bounced or complained. |
| SSM Parameter Store | Webhook signing secret and unsubscribe HMAC key (SecureString). No Stripe API key (decision 2026-11-12). |

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
4. Each email carries a plain-text part, the Unsubscribe link to `unsubscribe.html?c=&t=`, and `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.

The Lambda paces itself to the account's SES send rate (read it with `GetAccount`). One run of up to 15 minutes covers thousands of readers. Past that, put an SQS queue between the fan-out and the sends.

### Unsubscribe

Path: the reader clicks **Unsubscribe** in a letter → the hidden `unsubscribe.html` page → types their email → API Gateway → `UnsubscribeUser` → the DynamoDB table, plus an SNS email to the owner → the owner cancels in Stripe → Stripe's webhook → `StripeSync` → the table.

1. The link is `https://kitagrawal.github.io/unsubscribe.html?c=<customer id>&t=<HMAC of the id>`. The token proves the caller has the letter; the page removes it from the address bar and sends no referrer.
2. The page posts `{ c, t, email }` to `POST /unsubscribe`. The Lambda checks the token, reads the row for `c` and compares the email (case and spaces ignored). A bad token answers `400 link`, a wrong email `400 email`, an already-off reader `200` and no email.
3. Otherwise, while the plan still bills, it publishes to the SNS topic `newsletter-unsubscribes` (the owner's email: reader, subscription, Dashboard link), then sets `email_opt_out` on the row so `receives_letters` is false at once. If SNS fails it answers `502` and changes nothing, so a retry sends the email again.
4. The owner cancels the plan in the Stripe Dashboard within 2 days (the page promises this). The `customer.subscription.updated`/`deleted` webhooks bring the change back; the opt-out stays.
5. The mail headers point at `POST /unsubscribe/one-click?c&t` (RFC 8058): token only, same effect. Link scanners do not send POSTs, so there is no GET route.

Both routes have their own throttle (2 req/s, burst 5) and CORS allows only the site and `http://localhost:8000`. There is no Stripe portal sign-in. The owner can also unsubscribe a reader in the Stripe Dashboard (cancel, or metadata `email_opt_out=true`).

**Who gets a letter** (`applyEvent` and `receivesLetters` in `newsletter/rules.mjs`): status `active`, `trialing` or `past_due`, not `cancel_at_period_end`, `cancel_at`, `pause_collection` or metadata `email_opt_out`, the row not opted out on the page, and an email on file. The table stores the result as `receives_letters`; `send-issue` reads only that, and dedupes by `email_lc` (a Payment Link creates a new customer at each checkout, so one email can have two rows).

**Source of truth.** Billing changes are made in Stripe. DynamoDB is built from signed webhook events only (AWS holds no Stripe API key), plus the reader's opt-out; never edit it by hand. Stripe retries a failed webhook for up to 3 days; there is no reconcile, because that would need an API key.

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

## Built so far (2026-11-12)

Built with the AWS CLI instead of SAM, in **us-east-2**, because the account's organization policy denies Lambda, SSM, DynamoDB, SES and CloudFormation in us-east-1. Each Lambda sits behind its own API Gateway HTTP API (`$default` stage, 20 req/s, burst 50) with its own least-privilege IAM role. The source is in `newsletter/`; run the tests with `node --test newsletter/*.test.mjs` and push code with `newsletter/deploy.sh` (it runs the tests first).

| Lambda | Endpoint | Does |
|---|---|---|
| `StripeSync` | `POST https://c3ftjhbd19.execute-api.us-east-2.amazonaws.com/stripe/sync` | The only webhook. `checkout.session.completed`, `customer.subscription.created/updated/deleted` and `customer.updated/deleted` → `applyEvent` → `saveRow`. |
| `UnsubscribeUser` | `POST https://c7d3yimc7d.execute-api.us-east-2.amazonaws.com/unsubscribe` and `/unsubscribe/one-click` | See **Unsubscribe** above. |

`NewUser` is retired: its code is deleted, and its Lambda, API, role, Stripe endpoint and `/newsletter/new-user/webhook-secret` are deleted once `StripeSync` receives `customer.subscription.created`.

**`applyEvent(row, event)`** (`newsletter/rules.mjs`, pure and tested) builds the row from events alone: subscription events carry the plan (`isNewsletter` filters on `NEWSLETTER_PRODUCT_ID`, which must be set), `checkout.session.completed` and `customer.updated` carry the email. Each half keeps the time of the event it came from (`sub_event_at`, `email_event_at`), so an older event never overwrites a newer one. With two subscriptions on one customer, the one that gets letters wins. A new subscription created after the reader opted out clears the opt-out (resubscribe). **`saveRow`** (`lib.mjs`) reads the row, applies the change and writes it conditioned on its `rev` counter, retrying on a race.

Existing subscribers from before the webhook appear at their next renewal (`customer.subscription.updated`); until then they unsubscribe through the LinkedIn fallback.

The table `stripe-sync-subscription-status` uses the key `username`, which holds the **Stripe customer id**. Attributes: `email`, `email_lc`, `email_event_at`, `subscription_id`, `status`, `cancel_at_period_end`, `current_period_end`, `sub_live`, `sub_event_at`, `email_opt_out`, `opted_out_at`, `receives_letters`, `rev`, `updated_at`.

Setup scripts (one-off, safe to re-run, all touch live AWS):

- `setup-dynamodb.sh`: table; `NEWSLETTER_PRODUCT_ID` and `TABLE_NAME` on both functions; StripeSync may `GetItem`/`PutItem`/`DeleteItem`, UnsubscribeUser may `GetItem`/`PutItem`; removes `STRIPE_KEY_PARAM`.
- `setup-unsubscribe.sh`: the two POST routes, the route throttle, CORS; removes `GET /unsubscribe`; the SNS topic `newsletter-unsubscribes` with `OWNER_EMAIL` subscribed, and `sns:Publish` for UnsubscribeUser.
- `link.sh <cus_id> [page]`: prints a test unsubscribe link.

**Test mode** runs as a parameter swap on the same functions: point `WEBHOOK_SECRET_PARAM` and `NEWSLETTER_PRODUCT_ID` at test-mode values (a test-mode newsletter product and price), test, then swap back. `stripe trigger` uses a fixture product the filter ignores, so test with a real checkout of the test product.

**Go-live order** (each step changes live systems): `NEWSLETTER_PRODUCT_ID=prod_… setup-dynamodb.sh` → `OWNER_EMAIL=… setup-unsubscribe.sh` (confirm the SNS email) → `deploy.sh` → add the StripeSync endpoint in Stripe with the 6 events and store its `whsec_` in SSM → set `unsubscribeApiUrl` in `config.js` → delete NewUser.

SSM SecureString parameters (set by hand, not in code):

| Parameter | Value |
|---|---|
| `/newsletter/stripe-sync/webhook-secret` | `whsec_` of the Stripe endpoint for StripeSync |
| `/newsletter/unsubscribe-hmac-key` | Random string, e.g. `openssl rand -base64 32` |

Not built yet: SES domain, `send-issue` (it builds each letter's link with `unsubscribePageUrl` and the one-click headers), welcome and goodbye emails.

## Decisions (2026-11-11)

- **Sending domain**: buy a domain for the letter. It is step 1 of the build order.
- **One-click unsubscribe**: letters stop at once and the subscription cancels at the end of the paid period. No refunds.
- **No Stripe API key in AWS** (2026-11-12): Stripe → AWS by webhook only. Unsubscribe stops letters and emails the owner, who cancels the plan in the Stripe Dashboard within 2 days.
- **Code home**: a `newsletter/` folder in this repo (Lambdas, SAM template, backfill script, its own `package.json`). GitHub Pages will serve these files; they hold no secrets. Update `CLAUDE.md` and `README.md` when it lands, because the repo is no longer "no package manager".
- **PR #8** (formerly #7): keep its unsubscribe help page and the `book.html` script fix; drop the Buttondown docs.
