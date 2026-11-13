# Plan: paid newsletter on Stripe + AWS SES

Status: built, nothing of the SES half run against live AWS yet. Subscriber sync, Cancel, SES sending, `SendIssue`, reader emails and alarms all exist as code and setup scripts (see **Built so far**); the owner runs the go-live order below, then SES production access decides when real letters can go out. Diagram: [`architecture.html`](architecture.html) (open it in a browser; its source is `architecture.archify.json`).

## Goal

Run the $7/month newsletter without a newsletter tool (Buttondown). Stripe takes the money; AWS keeps the subscriber list in sync and sends the letters.

1. A new paid subscriber is on the send list within seconds of checkout, and gets a welcome email.
2. A Cancel (the Cancel link at the bottom of every letter) or a failed payment ends the reader's letters without manual work: a Cancel ends the plan at the end of the paid period.
3. The author publishes an issue by uploading one Markdown file.

The static site does not change: every Subscribe button already goes to the Stripe Payment Link in `config.js`.

## Architecture

| Part | Job |
|---|---|
| Stripe Payment Link + Billing | Checkout, recurring billing, receipts, failed-payment retries. **The source of truth** for who has paid. |
| `stripe-webhook` Lambda (API Gateway HTTP API, `POST /stripe/webhook`) | Receives Stripe events, checks the `Stripe-Signature` header, writes the subscriber's current state to DynamoDB, sends the welcome and goodbye emails. |
| DynamoDB `subscribers` table | A projection of Stripe state that the sender can read fast. It can be rebuilt from Stripe at any time. |
| S3 `issues` bucket | The author uploads `issue.md`; the upload starts a send. |
| `send-issue` Lambda | Renders the Markdown to HTML and text, reads the active subscribers, sends one email each through SES. |
| `CancelPlan` Lambda (API Gateway, `POST /cancel`) | Sets the reader's Stripe plan to cancel at the end of the paid period, from the id in the Cancel link. Never writes the table: the webhook records the change. |
| Amazon SES | Sends from a verified custom domain with DKIM. The account-level suppression list blocks addresses that bounced or complained. |
| SSM Parameter Store, Secrets Manager | SSM: the webhook signing secret (SecureString). Secrets Manager `applied-ai-letter/stripe`: the one restricted Stripe key, with only **Subscriptions: Write**, read by `CancelPlan` (see the decision "Cancel replaces unsubscribe"). |

All AWS parts live in one account and one region, deployed with one AWS SAM template.

## Facts from the docs that shape the design

Checked on 2026-11-11.

- **SES needs a domain you control.** SES verifies a domain through DNS records, so `kitagrawal.github.io` cannot be a sending domain. Buy or use a custom domain (for example the letter's own name). [SES identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- **The SES sandbox** allows only verified recipients, 200 emails a day and 1 a second. Production access takes a request; AWS answers within about 96 hours. Start this early. [Production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- **Gmail and Yahoo bulk-sender rules**: SPF, DKIM and DMARC (`p=none` is enough), spam rate under 0.3%. Senders above about 5,000 messages a day must also offer one-click unsubscribe (RFC 8058); this plan sends no `List-Unsubscribe` headers (ADR 0002), so revisit that near that size. [Gmail](https://support.google.com/a/answer/81126), [Yahoo](https://senders.yahooinc.com/best-practices/)
- **SES reputation limits**: a bounce rate of 5% puts the account under review, 10% can pause sending; for complaints the levels are 0.1% and 0.5%. [Reputation](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html)
- **Stripe events are not ordered and can repeat.** Dedupe on the event id, and do not trust the order of arrival. Live mode retries a failed delivery for up to 3 days. Verify the signature against the raw body. [Webhooks](https://docs.stripe.com/webhooks)
- **Use `customer.subscription.*` events for status**, not `checkout.session.completed` (that one is for fulfilment). A cancel-at-period-end shows as `cancel_at_period_end: true` on `customer.subscription.updated` while the status stays `active`; `customer.subscription.deleted` fires when it really ends. [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- **SES's own list management** (contact lists) adds `List-Unsubscribe` headers, which this plan does not want (ADR 0002), allows one contact list per account and cannot cancel a Stripe subscription. This plan uses its own `CancelPlan` Lambda instead. [List management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-list-management.html)
- **Price**: SES is $0.10 per 1,000 emails on the pay-as-you-go plan. [Pricing](https://aws.amazon.com/ses/pricing/)

## How each flow works

### Subscribe and billing changes

1. The reader pays through the Payment Link. Stripe creates a Customer and a Subscription.
2. Stripe sends `customer.subscription.created`. The webhook Lambda checks the signature, then skips the event if its id is already in the `events` table.
3. The Lambda **fetches the subscription from Stripe** instead of trusting the event body. This makes late or out-of-order events harmless: it always writes the latest state.
4. It writes the `subscribers` item and, the first time the status is `active`, sends the welcome email (a conditional write on `welcomed_at` stops a second one).

| Stripe event | Effect |
|---|---|
| `customer.subscription.created` / `.updated` | Upsert status, `cancel_at_period_end`, `current_period_end`, email, `email_opt_out` (legacy flag, from subscription metadata). |
| `customer.subscription.deleted` | Status `canceled`; send the goodbye email once. |
| `customer.updated` | Copy a changed email address. |
| `invoice.payment_failed` | Nothing extra: the status change arrives as `subscription.updated`. Stripe's own failed-payment emails handle dunning. |

**Who gets a letter**: status `active`, `trialing` or `past_due`, and the legacy `email_opt_out` flag is false. A scheduled cancel does not stop letters; they stop when Stripe reports the plan canceled. See the full rule below.

### Publish an issue

1. The author uploads `drafts/<date>-<slug>.md` (front matter: `subject`). The send Lambda sends it **only to the author**, as a proof.
2. When it looks right, the author copies it to `issues/<date>-<slug>.md`. That starts the real send.
3. For each reader who receives letters, once per email address, the Lambda first writes a `sends` item `(issue_id, email_lc)` with a condition that it does not exist yet, then calls SES `SendEmail`. A retry after a crash skips everyone already sent. While SES is in the sandbox a real send is refused, logged and alarmed (`Newsletter/RefusedSend`); only proofs go out.
4. Each email carries a plain-text part and the Cancel link at the bottom, `unsubscribe.html?c=<customer id>` built with `cancelPageUrl` (`newsletter/rules.mjs`). It carries **no** `List-Unsubscribe` or `List-Unsubscribe-Post` headers (ADR 0002): a mail app or scanner must never cancel a paid plan without the reader's confirm.

The Lambda paces itself to the account's SES send rate (read it with `GetAccount`). One run of up to 15 minutes covers thousands of readers. Past that, put an SQS queue between the fan-out and the sends.

### Cancel

Path: the reader clicks the **Cancel link** at the bottom of a letter → the hidden `unsubscribe.html` page (the file keeps its old name so old links work) → Confirm → API Gateway → `CancelPlan` → the DynamoDB table (read) and Stripe (`cancel_at_period_end`) → Stripe's webhook → `StripeSync` → the table.

1. The link is `https://kitagrawal.github.io/unsubscribe.html?c=<customer id>`. The id alone is the proof (ADR 0001): no token and no typed email. An old link's `&t=` is ignored. The page strips the query from the address bar and sends no referrer.
2. The page posts `{ c }` to `POST /cancel`. The Lambda reads the row for `c` and asks `cancelDecision` (`rules.mjs`): cancel only for a well-formed `cus_` id whose row has a live plan (`active`, `trialing` or `past_due`) and no scheduled cancel.
3. For that case it POSTs `cancel_at_period_end=true` to the row's subscription in Stripe with the restricted key and answers `200 {done: true, until}` (`until` is the end of the paid period, unix seconds). Letters continue until then and nothing renews.
4. Every other case (unknown id, no row, no plan, already cancelling, ended, Stripe or secret error) answers the same `200 {error: "support"}`, so ids cannot be probed, and the page tells the reader to email support@appliedailetter.com.
5. The Lambda writes nothing to the table. The `customer.subscription.updated` and `.deleted` webhooks bring the change back, and `StripeSync` records it.

The route has its own throttle (2 req/s, burst 5) and CORS allows only the site and `http://localhost:8000`. The reader never signs in to Stripe. The owner can also cancel a plan in the Stripe Dashboard. **Legacy opt-outs** (readers who stopped letters under the old flow but still pay, GLOSSARY: Opt-out) are cancelled at period end by the one-off `newsletter/cancel-opt-outs.sh` (dry run first, then `--confirm`).

**Who gets a letter** (`applyEvent` and `receivesLetters` in `newsletter/rules.mjs`): status `active`, `trialing` or `past_due`, not `pause_collection` or metadata `email_opt_out`, the row not carrying the legacy opt-out, and an email on file. A scheduled cancel (`cancel_at_period_end` or `cancel_at`) does not stop letters: the reader keeps getting them until Stripe reports the plan `canceled`. The table stores the result as `receives_letters`; `send-issue` reads only that, and dedupes by `email_lc` (a Payment Link creates a new customer at each checkout, so one email can have two rows).

**Source of truth.** Billing changes are made in Stripe. DynamoDB is built from signed webhook events only (`StripeSync` uses no Stripe key; the one restricted key belongs to `CancelPlan`, which only reads the table); never edit it by hand. Stripe retries a failed webhook for up to 3 days; there is no reconcile, because that would need an API key.

### Bounces and complaints

The SES account-level suppression list blocks addresses that hard-bounced or complained. CloudWatch alarms on the SES bounce rate (2%) and complaint rate (0.05%) email the author well before the review levels (`setup-alarms.sh`). A Lambda that also marks these readers in DynamoDB can come later if needed.

## Data model (DynamoDB, on-demand)

| Table | Key | Attributes |
|---|---|---|
| `subscribers` | `customer_id` | `email`, `status`, `cancel_at_period_end`, `current_period_end`, `email_opt_out`, `welcomed_at`, `cancel_noted_at`, `goodbye_at`, `updated_at` |
| `sends` | `issue_id`, `email_lc` | `customer_id`, `claimed_at`, `sent_at`, `ses_message_id` |
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
5. **`CancelPlan`** and the Cancel link in each letter (no `List-Unsubscribe` headers).
6. **Welcome and goodbye emails.**
7. **Go live**: live-mode keys and webhook endpoint, a real test subscription, then update `SETUP.md` and `README.md` here.

## Changes to this repo

None for the site. The newsletter section of `SETUP.md` now describes Stripe + SES instead of a newsletter tool.

## Built so far (2026-11-12)

Built with the AWS CLI instead of SAM, in **us-east-2**, because the account's organization policy denies Lambda, SSM, DynamoDB, SES and CloudFormation in us-east-1. Each Lambda sits behind its own API Gateway HTTP API (`$default` stage, 20 req/s, burst 50) with its own least-privilege IAM role. The source is in `newsletter/`; run the tests with `node --test newsletter/*.test.mjs` and push code with `newsletter/deploy.sh` (it runs the tests first).

| Lambda | Endpoint | Does |
|---|---|---|
| `StripeSync` | `POST https://c3ftjhbd19.execute-api.us-east-2.amazonaws.com/stripe/sync` | The only webhook. `checkout.session.completed`, `customer.subscription.created/updated/deleted` and `customer.updated/deleted` → `applyEvent` → `saveRow`. |
| `CancelPlan` | `POST <API>/cancel` (the URL `setup-cancel.sh` prints, stored as `cancelApiUrl` in `config.js`) | See **Cancel** above. |

`NewUser` is retired: its code is deleted, and its Lambda, API, role, Stripe endpoint and `/newsletter/new-user/webhook-secret` are deleted once `StripeSync` receives `customer.subscription.created`.

**`applyEvent(row, event)`** (`newsletter/rules.mjs`, pure and tested) builds the row from events alone: subscription events carry the plan (`isNewsletter` filters on `NEWSLETTER_PRODUCT_ID`, which must be set), `checkout.session.completed` and `customer.updated` carry the email. Each half keeps the time of the event it came from (`sub_event_at`, `email_event_at`), so an older event never overwrites a newer one. With two subscriptions on one customer, the one that gets letters wins. A new subscription created after the reader opted out clears the opt-out (resubscribe). **`saveRow`** (`lib.mjs`) reads the row, applies the change and writes it conditioned on its `rev` counter, retrying on a race.

Existing subscribers from before the webhook appear at their next renewal (`customer.subscription.updated`); until then their Cancel link answers "email support" because there is no row.

The table `stripe-sync-subscription-status` uses the key `username`, which holds the **Stripe customer id**. Attributes: `email`, `email_lc`, `email_event_at`, `subscription_id`, `status`, `cancel_at_period_end`, `current_period_end`, `sub_live`, `sub_event_at`, `email_opt_out` and `opted_out_at` (legacy opt-outs; only Stripe metadata sets them now), `receives_letters`, `rev`, `updated_at`.

Setup scripts (one-off, safe to re-run, all touch live AWS):

- `setup-dynamodb.sh`: table; `NEWSLETTER_PRODUCT_ID` and `TABLE_NAME` on both functions; StripeSync may `GetItem`/`PutItem`/`DeleteItem`; removes `STRIPE_KEY_PARAM`.
- `setup-cancel.sh`: the `CancelPlan` function and role (read on the table and the one secret), the `POST /cancel` route, throttle and CORS; removes `UnsubscribeUser`'s routes (`POST /unsubscribe`, `POST /unsubscribe/one-click`, `GET /unsubscribe`); leaves the old function for you to delete after go-live; prints `cancelApiUrl`.
- `link.sh <cus_id> [page]`: prints a test Cancel link.
- `cancel-opt-outs.sh [--confirm]`: one-off; lists, then with `--confirm` schedules a period-end cancel for each legacy opt-out that still pays. Run it after the Stripe key has **Subscriptions: Write**.

**Test mode** runs as a parameter swap on the same functions: point `WEBHOOK_SECRET_PARAM` and `NEWSLETTER_PRODUCT_ID` at test-mode values (a test-mode newsletter product and price), test, then swap back. `stripe trigger` uses a fixture product the filter ignores, so test with a real checkout of the test product.

**Go-live order** (each step changes live systems): `NEWSLETTER_PRODUCT_ID=prod_… setup-dynamodb.sh` → change the Stripe key to only **Subscriptions: Write** → `setup-cancel.sh` → `deploy.sh` → add the StripeSync endpoint in Stripe with the 6 events and store its `whsec_` in SSM → set `cancelApiUrl` in `config.js` → `cancel-opt-outs.sh` (dry run, then `--confirm`) → delete NewUser and the old `UnsubscribeUser` function (and the unused `/newsletter/unsubscribe-hmac-key` parameter).

Secrets Manager `applied-ai-letter/stripe` (set by hand): the restricted Stripe key (`rk_live_…`) with only **Subscriptions: Write**, plain or in JSON; `CancelPlan` refuses an `sk_` key. Never widen it or add another.

SSM SecureString parameters (set by hand, not in code):

| Parameter | Value |
|---|---|
| `/newsletter/stripe-sync/webhook-secret` | `whsec_` of the Stripe endpoint for StripeSync |

### SES, SendIssue, reader emails and alarms (built, not yet run)

Everything is in `newsletter/`, region us-east-2, profile `newsletter`. The author runs the scripts; they change live AWS. Letters and reader emails come from `letters@appliedailetter.com`, with Reply-To `support@appliedailetter.com` by default, and carry no `List-Unsubscribe` headers (ADR 0002).

- **SES** (`setup-ses.sh`): domain identity `appliedailetter.com` with Easy DKIM (RSA 2048), custom MAIL FROM `bounce.appliedailetter.com`, and one configuration set `newsletter` (reputation metrics on). It prints the five DNS records for IONOS (3 DKIM CNAMEs, MAIL FROM MX and SPF TXT) and polls until SES reports them verified. The root SPF, the IONOS MX records and DMARC `p=none` stay as they are.
- **`SendIssue`** (`send-issue/index.mjs`, 15 minutes, own role `send-issue-role`): S3 `ObjectCreated` on `drafts/*.md` and `issues/*.md` in the articles bucket. `sendPlan` (`rules.mjs`) routes the key. A **Draft** produces one **Proof** to `AUTHOR_EMAIL`. An `issues/` upload goes to every reader who receives letters, deduped by `email_lc`, paced to the SES `MaxSendRate`, one run at a time (reserved concurrency 1), each with their own Cancel link; refused in the sandbox. A missing `subject:` front matter stops the send. `letter.mjs` (with the vendored `marked`) renders the same HTML and text for proof and letter. Proofs sent while SES is still in the sandbox need `AUTHOR_EMAIL` verified as an SES identity, spelled exactly as in `AUTHOR_EMAIL` (the IAM grant uses that identity's ARN).
- **Sends table** (`newsletter-sends`, key `issue_id` + `email_lc`): a conditional put claims each reader before the SES call, so a re-upload or a crash never sends a letter twice. A SES call that fails with a known not-sent error (throttling, sending paused, access denied, bad request and similar: errors SES returns before accepting the message) removes the claim, so a re-upload retries that reader. Any other failure (a timeout, a network error, `MessageRejected`, an unknown error) keeps the claim, because the letter may have gone out, and records the error on the claim row; that reader is skipped on re-upload. Five failures in a row (throttling aside) stop the run (an account-wide problem such as a lapsed DKIM record), and `SendIncomplete` alarms. To retry readers whose claim was kept, fix the cause, delete that issue's sends items that have an `error` attribute (`aws dynamodb query --table-name newsletter-sends --key-condition-expression "issue_id = :i" --filter-expression "attribute_exists(#e)" ...` then `delete-item` each), and upload the letter again.
- **Reader emails** (`stripe-sync/index.mjs`, wording in `newsletter/emails/*.md`): `readerEmail` (`rules.mjs`) decides welcome, cancel-scheduled or goodbye from the row before and after a change. A welcome is due only for a new reader or plan (no row before, a new subscription id, or no email on file before), so a pause then resume, or a reader who was live before reader emails existed, gets none; a cancel note is due only on the change that schedules the cancel, so a cancel scheduled before deploy gets none; a goodbye never goes to a legacy opt-out. There is no backfill. StripeSync claims the field (`welcomed_at`, `cancel_noted_at`, `goodbye_at`) with a conditional update, then sends once; a failure is logged, counted and never retried, and the webhook still answers 200. In the sandbox nothing is claimed or sent, so a welcome or cancel note due then is lost.
- **Bucket**: private. `setup-send.sh` turns on all four public access blocks and adds no bucket policy; `SendIssue`'s role (an IAM policy, not a bucket policy) reads only `drafts/` and `issues/`. It replaces the bucket notification but keeps any entry that is not its own `send-issue-*`.
- **Alarms** (`setup-alarms.sh`): SNS topic `newsletter-alerts` with an email subscription to `ALERT_EMAIL`. Alarms: SES `Reputation.BounceRate` above 0.02 and `Reputation.ComplaintRate` above 0.0005 (account-wide metrics, no dimensions); Lambda `Errors` above 0 for StripeSync, CancelPlan and SendIssue; custom `Newsletter/RefusedSend`, `Newsletter/ReaderEmailFailed` and `Newsletter/SendIncomplete` (a send had failed readers or stopped early for time) above 0. Missing data counts as not breaching.
- **Production access**: the request text is a placeholder in [`production-access.md`](production-access.md). Nothing is submitted.

**Run order for SES** (each step changes live systems; `AUTHOR_EMAIL`, `REPLY_TO` and `ALERT_EMAIL` must not hold `REPLACE`):

1. `setup-ses.sh`: creates the identity and configuration set, prints the DNS records.
2. Paste the records into IONOS (DNS settings for `appliedailetter.com`).
3. Wait until the script reports DKIM and MAIL FROM verified (re-run it, or `--no-wait`, to check).
4. In SES, verify the author address as an email identity: while SES is in the sandbox it can only send to verified addresses, so proofs fail without this.
5. `AUTHOR_EMAIL=… setup-send.sh`: sends table, `SendIssue`, bucket notification and access block, and StripeSync's SES permissions and env vars.
6. `deploy.sh`: runs the tests, then pushes all three Lambdas (StripeSync now sends reader emails once SES has production access).
7. `ALERT_EMAIL=… setup-alarms.sh`.
8. Open the SNS confirmation email and confirm the subscription.
9. Upload a draft to `drafts/` and check the proof.
10. Submit the production-access request from `production-access.md` (filled in); AWS answers in about 96 hours.
11. After approval, publish by uploading the same file to `issues/`.

Until step 10 is approved, an `issues/` upload is refused and alarmed, and reader emails are skipped. Delete NewUser, `UnsubscribeUser` and the old HMAC parameter as listed in the Cancel go-live order.

## Decisions (2026-11-11)

- **Sending domain**: buy a domain for the letter. It is step 1 of the build order.
- **One-click unsubscribe** (superseded by "Cancel replaces unsubscribe" below): letters stop at once and the subscription cancels at the end of the paid period. No refunds.
- **No Stripe API key in AWS** (2026-11-12): Stripe → AWS by webhook only. Unsubscribe stopped letters; the reader cancelled billing themselves in Stripe's customer portal, so there was no owner email. (Narrowed by the two entries below.)
- **No-login cancel** (2026-11-13, narrows the above; superseded below): `UnsubscribeUser` held one restricted key with only "Customer portal: Write" to open the portal on "Cancel subscription" without Stripe's emailed login code.
- **Cancel replaces unsubscribe** (2026-11-12, supersedes the "No-login cancel" portal decision and the one-click bullet): the only way a reader leaves is **Cancel**, which ends the plan at the end of the paid period; letters continue until then. `CancelPlan` replaces `UnsubscribeUser` and sets `cancel_at_period_end` in Stripe directly, so the customer portal, the HMAC token and the typed email are gone. The link's `?c=<customer id>` is the only proof (ADR 0001). The restricted key now holds only **Subscriptions: Write** (it lost "Customer portal: Write"). Letters send no `List-Unsubscribe` headers (ADR 0002); the trade-off is that Gmail and Yahoo expect one-click above about 5,000 messages a day, so revisit near that size. Legacy opt-outs still paying are cancelled at period end by `cancel-opt-outs.sh`. Glossary: `GLOSSARY.md`.
- **Code home**: a `newsletter/` folder in this repo (Lambdas, SAM template, backfill script, its own `package.json`). GitHub Pages will serve these files; they hold no secrets. Update `CLAUDE.md` and `README.md` when it lands, because the repo is no longer "no package manager".
- **PR #8** (formerly #7): keep its unsubscribe help page and the `book.html` script fix; drop the Buttondown docs.
