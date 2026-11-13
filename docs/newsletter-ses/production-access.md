# SES production-access request (placeholder)

> **NOT SUBMITTED. This is a placeholder.** Nothing here has been sent to AWS. SES for `appliedailetter.com` is still in the sandbox (200 emails a day, 1 a second, verified recipients only). The author submits the request when ready, after `setup-ses.sh` reports the domain verified and `setup-alarms.sh` has run. Replace every `REPLACE` value first.

AWS usually answers within about 96 hours (see `PLAN.md`, "Facts from the docs").

## Request fields

| Field | Value |
|---|---|
| Mail type | Marketing (the paid letter is a newsletter; its account emails are sent alongside it). Readers opted in by paying. |
| Website URL | https://kitagrawal.github.io |
| Sending domain | appliedailetter.com (verified, Easy DKIM, MAIL FROM `bounce.appliedailetter.com`) |
| Additional contact address | REPLACE-author-email |
| Preferred contact language | English |
| Region | us-east-2 |

## Use-case description (paste this)

```
The Applied AI Letter is a paid email newsletter by Ankit Agrawal (https://kitagrawal.github.io). Readers subscribe by paying through a Stripe Payment Link; there is no free sign-up form and no purchased, rented or imported list. The only people we email are readers whose Stripe subscription is live (active, trialing or past due) and who gave their email address at Stripe checkout.

Volume: about 4 letters a month to a list that is currently small (hundreds of readers at most), so roughly 1,000 emails a month and never more than a few thousand in a day. Letters go out in one batch on publish day, paced to the account's send rate. Peak need: 5 emails a second.

What we send, from letters@appliedailetter.com:
1. The letter itself (HTML and plain text), about weekly.
2. Three account emails per reader, each at most once: a welcome when the plan starts, a note when the reader schedules a cancel ("letters continue until <date>"), and a goodbye when the plan ends.
We send no promotions, no third-party mail and no cold email.

How the list is built and kept clean: Stripe is the source of truth. A signed Stripe webhook updates our subscriber table within seconds of checkout, cancel or end of plan. A reader whose plan ended, or who has no live plan, is never mailed. Duplicate addresses are collapsed so a reader gets one copy of each letter, and each letter is recorded per address so a retry never sends it twice.

Unsubscribing: every letter has a Cancel link at the bottom that leads to a one-confirm page which ends the reader's plan at the end of the paid period. Readers can also reply to any letter (replies reach a monitored inbox, REPLACE-reply-to-email) or write to support@appliedailetter.com.

Bounces and complaints: we send through a verified domain with DKIM, a custom MAIL FROM domain and SPF, with a DMARC policy published. SES's account-level suppression list is on for bounces and complaints, so an address that hard-bounces or complains is never mailed again. SES reputation metrics are enabled on our configuration set, and CloudWatch alarms email the author when the bounce rate passes 2% or the complaint rate passes 0.05% (well below the SES review levels of 5% and 0.1%). Lambda errors and refused sends also alarm. Because every recipient paid and is expected to receive the letter, we expect very low complaint and bounce rates.

Before sending a letter to readers, the author receives a proof copy to check it.
```

## How to submit later

Console: SES (us-east-2) > Account dashboard > "Request production access", paste the text above into the use-case description.

CLI (changes live AWS; the author runs it, profile `newsletter`). Save the text from the code block above into a file first, for example `/tmp/use-case.txt`, with the `REPLACE` values filled in:

```bash
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type MARKETING \
  --website-url https://kitagrawal.github.io \
  --use-case-description file:///tmp/use-case.txt \
  --additional-contact-email-addresses REPLACE-author-email \
  --contact-language EN
```

Then check the outcome:

```bash
aws sesv2 get-account --query '[ProductionAccessEnabled, SendQuota]'
```

When `ProductionAccessEnabled` is true, real sends through `issues/` start working. Until then they are refused and alarmed, and only proofs go out.
