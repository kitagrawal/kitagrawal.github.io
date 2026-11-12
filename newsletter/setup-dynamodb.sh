#!/usr/bin/env bash
# One-off, safe to re-run: create the subscribers table and wire StripeSync and UnsubscribeUser
# to it (us-east-2, profile "newsletter").
#
#   NEWSLETTER_PRODUCT_ID=prod_... ./setup-dynamodb.sh
#
# NEWSLETTER_PRODUCT_ID is the Stripe product of the newsletter. It may be left out on a re-run
# if both functions already have it. Use the test-mode product id while testing in test mode.
#
# Table: key "username" (string) = Stripe customer id. Other attributes are written by
# syncCustomer() in lib.mjs and need no schema. On-demand billing, point-in-time recovery and
# deletion protection are on.
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
TABLE=stripe-sync-subscription-status

# 1. Table
if aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  echo "Table $TABLE exists"
else
  aws dynamodb create-table --table-name "$TABLE" \
    --attribute-definitions AttributeName=username,AttributeType=S \
    --key-schema AttributeName=username,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --deletion-protection-enabled \
    --tags Key=project,Value=newsletter \
    --query TableDescription.TableStatus --output text
  aws dynamodb wait table-exists --table-name "$TABLE"
  echo "Table $TABLE created"
fi
key=$(aws dynamodb describe-table --table-name "$TABLE" --query 'Table.KeySchema[*].[AttributeName,KeyType]' --output text)
[[ "$key" == $'username\tHASH' ]] || { echo "Table $TABLE has key '$key', expected 'username HASH'; the Lambdas will fail" >&2; exit 1; }
aws dynamodb update-continuous-backups --table-name "$TABLE" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text
ARN=$(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableArn --output text)

# 2. Each function: its table actions, timeout, and TABLE_NAME + NEWSLETTER_PRODUCT_ID added to
# its existing env vars. StripeSync needs Scan and 5 minutes for the nightly reconcile.
configure() {
  local fn=$1 actions=$2 timeout=$3
  local role
  role=$(aws lambda get-function-configuration --function-name "$fn" --query Role --output text)
  role=${role##*/}
  aws iam put-role-policy --role-name "$role" --policy-name dynamodb-subscribers --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{\"Effect\": \"Allow\", \"Action\": $actions, \"Resource\": \"$ARN\"}]
  }"
  echo "$fn: role $role may $actions on $TABLE"

  local vars env
  vars=$(aws lambda get-function-configuration --function-name "$fn" --query Environment.Variables --output json)
  env=$(python3 - "$vars" "$TABLE" "${NEWSLETTER_PRODUCT_ID:-}" "$fn" <<'PY'
import json, sys
v = json.loads(sys.argv[1]) or {}
v["TABLE_NAME"] = sys.argv[2]
if sys.argv[3]:
    v["NEWSLETTER_PRODUCT_ID"] = sys.argv[3]
if not v.get("NEWSLETTER_PRODUCT_ID", "").startswith("prod_"):
    sys.exit(f"{sys.argv[4]}: NEWSLETTER_PRODUCT_ID is not set; run NEWSLETTER_PRODUCT_ID=prod_... {sys.argv[0]}")
print(json.dumps({"Variables": v}))
PY
)
  aws lambda update-function-configuration --function-name "$fn" --environment "$env" --timeout "$timeout" \
    --query LastUpdateStatus --output text >/dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  echo "$fn: timeout ${timeout}s, env $(aws lambda get-function-configuration --function-name "$fn" --query 'Environment.Variables | keys(@)' --output text)"
}

configure StripeSync '["dynamodb:UpdateItem","dynamodb:DeleteItem","dynamodb:Scan"]' 300
configure UnsubscribeUser '["dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:DeleteItem"]' 30

echo "Done. Next: ./deploy.sh, then ./setup-reconcile.sh"
