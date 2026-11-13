# Newsletter API (Stripe → DynamoDB → SES)

AWS SAM stack `newsletter`, us-east-2, AWS profile `newsletter`.

```
Stripe ──webhook──► POST /stripe/webhook ► stripe_webhook λ ─┐
Stripe ◄──API read── reconcile λ (daily + manual) ───────────┼─► DynamoDB (subscribers, key: email)
publish.mjs ► POST /send ► send λ (async worker) ────────────┘        ▲
unsubscribe.html?c= ► POST /cancel ► cancel λ ► Stripe (cancel at period end)
                         SES (config set newsletter-events) ► bounces/complaints ► SNS ► ses_events λ ┘ suppress
```

Subscriber row: `email` (key), `status` (Stripe status), `stripe_customer_id` (GSI `customer-index`), `subscription_id`, `price_id`, `cancel_at_period_end`, `current_period_end`, `opted_out`, `suppressed`. Letters go to rows whose status is `active`, `trialing` or `past_due` and that are neither `opted_out` nor `suppressed`. Only subscriptions to the `NewsletterProductId` product are recorded.

Unsubscribe (ADR 0001; `/cancel` in code): every letter's footer links `https://kitagrawal.github.io/unsubscribe.html?c=<customer id>`. That page posts `{c}` to `/cancel`, which sets `cancel_at_period_end` in Stripe; the webhook then records it. Letters continue until the paid period ends. There are no `List-Unsubscribe` headers (ADR 0002).

## Secrets (you create these; never paste them in chat)

| Where | Name | What |
|---|---|---|
| Secrets Manager JSON `applied-ai-letter/stripe` | field `STRIPE_SECRET_KEY` | Stripe **restricted** key (`rk_live_…`) with **Subscriptions: Write** and **Customers: Read**. `sk_` and `pk_` keys are refused |
| same secret | field `STRIPE_WEBHOOK_SECRET` | the webhook endpoint's signing secret (`whsec_…`) |
| SSM SecureString | `/newsletter/admin-api-key` | `openssl rand -hex 32`; `publish.mjs` reads it |

Lambdas cache the secret per container: after changing it, the next cold start picks it up (or redeploy).

```bash
aws ssm put-parameter --profile newsletter --region us-east-2 --type SecureString --name /newsletter/admin-api-key --value "$(openssl rand -hex 32)"
```

## Deploy

```bash
cd newsletter/api && sam build && sam deploy --profile newsletter --region us-east-2 --stack-name newsletter --resolve-s3 --capabilities CAPABILITY_IAM \
  --parameter-overrides FromAddress="The Applied AI Letter <letters@appliedailetter.com>" SesDomain=appliedailetter.com CreateSesIdentity=false NewsletterProductId=prod_…
```

Then:

1. Stripe Dashboard → Developers → Webhooks: point the endpoint at the `ApiUrl` output + `/stripe/webhook`, with the events `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `customer.updated`. Put its signing secret in the `STRIPE_WEBHOOK_SECRET` field of `applied-ai-letter/stripe`.
2. Backfill once: `aws lambda invoke --function-name <ReconcileFunctionName output> out.json`. It then runs daily.
3. Put the `CancelApiUrl` output into `newsletter.cancelApiUrl` in `config.js` and push the site.

## Sending a letter

Write Markdown with `subject:` front matter (see `newsletter/drafts/sample.md`), then from the repo root:

```bash
node newsletter/publish.mjs newsletter/drafts/sample.md --preview    # local HTML only
node newsletter/publish.mjs newsletter/drafts/sample.md --dry-run    # count readers
node newsletter/publish.mjs newsletter/drafts/sample.md --proof      # one copy to support@appliedailetter.com
node newsletter/publish.mjs newsletter/drafts/sample.md --all        # every reader (asks you to type "send")
```

The send runs in the background; the `SendFunctionName` output's logs end with `done: sent=… failed=…`.

## Notes and limits

- One send run handles about 9k readers at 10/s within Lambda's 15-minute cap. A run that times out is not resumable, and a re-run sends again; add a per-reader claim table before the list gets near that size.
- Tests: `python3 -I tests/test_local.py` (AWS is faked). Validate the template with `sam validate`.
