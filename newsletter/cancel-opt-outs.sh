#!/usr/bin/env bash
# One-off: cancel at period end the plans of legacy opt-outs who still pay (us-east-2, profile
# "newsletter"). Run by the owner; this changes LIVE Stripe when given --confirm.
#
#   ./cancel-opt-outs.sh             # dry run: lists customer id, email and period end, changes nothing
#   ./cancel-opt-outs.sh --confirm   # schedules each cancel (cancel_at_period_end) in Stripe
#
# Picks table rows with email_opt_out set, a live plan and no scheduled cancel (needsCancel in
# rules.mjs). Uses the restricted Stripe key in Secrets Manager (applied-ai-letter/stripe); a full sk_
# key is refused. It does not write DynamoDB: StripeSync's webhook records each cancel, so a re-run
# after that picks nobody. Safe to re-run: setting a cancel that is already set changes nothing.
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
exec node cancel-opt-outs.mjs "$@"
