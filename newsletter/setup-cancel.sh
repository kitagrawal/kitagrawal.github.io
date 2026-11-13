#!/usr/bin/env bash
# One-off, safe to re-run: create the CancelPlan Lambda, put its POST /cancel route on the HTTP API with
# its own low throttle (2 req/s, burst 5), allow the site's origin through CORS, and give it read access
# to the subscribers table and the one Stripe secret (us-east-2, profile "newsletter").
# The owner runs this; it changes live AWS.
#
#   ./setup-cancel.sh                  # finds the API that already carries UnsubscribeUser or StripeSync
#   API_ID=abc123 ./setup-cancel.sh
#
# Stripe key: CancelPlan needs one restricted key (rk_) with only "Subscriptions: Write", which you store
# yourself in Secrets Manager as applied-ai-letter/stripe (plain key, or JSON holding it). The Lambda
# refuses an sk_ key and never writes the table; StripeSync's webhook records the cancel. This script
# lets the Lambda read that one secret.
#
# Removes UnsubscribeUser's routes (POST /unsubscribe, POST /unsubscribe/one-click, GET /unsubscribe).
# The old function itself is left in place: delete it yourself once the new page is live.
# Prints the URL for config.js (cancelApiUrl).
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
FN=CancelPlan
OLD_FN=UnsubscribeUser
TABLE=stripe-sync-subscription-status
SECRET_ID=applied-ai-letter/stripe
ORIGINS="https://kitagrawal.github.io,http://localhost:8000"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 1. The function: role, code, config (created if missing)
ROLE=cancel-plan-role
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }'
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # let the new role propagate before Lambda uses it
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)
TABLE_ARN=$(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableArn --output text)
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" --query ARN --output text 2>/dev/null || true)
[[ -n "$SECRET_ARN" ]] || { echo "Secret $SECRET_ID not found: store the rk_ key there first" >&2; exit 1; }

# Read the table and the one secret, nothing else
aws iam put-role-policy --role-name "$ROLE" --policy-name cancel-plan-reads --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"dynamodb:GetItem\", \"Resource\": \"$TABLE_ARN\"},
    {\"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\", \"Resource\": \"$SECRET_ARN\"}
  ]
}"

ENV="{\"Variables\": {\"TABLE_NAME\": \"$TABLE\", \"STRIPE_SECRET_ID\": \"$SECRET_ID\"}}"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-configuration --function-name "$FN" --environment "$ENV" --timeout 15 \
    --query LastUpdateStatus --output text >/dev/null
else
  tmp=$(mktemp -d)
  zip -q -j "$tmp/cancel-plan.zip" cancel-plan/index.mjs lib.mjs rules.mjs
  runtime=$(aws lambda get-function-configuration --function-name StripeSync --query Runtime --output text)
  arch=$(aws lambda get-function-configuration --function-name StripeSync --query 'Architectures[0]' --output text)
  aws lambda create-function --function-name "$FN" --runtime "$runtime" --architectures "$arch" \
    --role "$ROLE_ARN" --handler index.handler --timeout 15 --environment "$ENV" \
    --zip-file "fileb://$tmp/cancel-plan.zip" --query FunctionArn --output text
  rm -r "$tmp"
fi
aws lambda wait function-updated-v2 --function-name "$FN"
echo "$FN: reads $TABLE and secret $SECRET_ID"

# 2. The API: the HTTP API that already carries the old function or StripeSync
find_api() { # function name -> api id, or nothing
  for id in $(aws apigatewayv2 get-apis --query 'Items[?ProtocolType==`HTTP`].ApiId' --output text); do
    if aws apigatewayv2 get-integrations --api-id "$id" --output json |
      python3 -c 'import json,sys; fn=sys.argv[1]; sys.exit(0 if any(i.get("IntegrationUri","").split(":function:")[-1].split(":")[0].split("/")[0]==fn for i in json.load(sys.stdin)["Items"]) else 1)' "$1"; then
      echo "$id"; return
    fi
  done
}
if [[ -z "${API_ID:-}" ]]; then API_ID=$(find_api "$OLD_FN"); fi
if [[ -z "${API_ID:-}" ]]; then API_ID=$(find_api StripeSync); fi
[[ -n "${API_ID:-}" ]] || { echo "No HTTP API carries $OLD_FN or StripeSync; set API_ID" >&2; exit 1; }
FN_ARN=$(aws lambda get-function --function-name "$FN" --query Configuration.FunctionArn --output text)
INTEGRATION=$(aws apigatewayv2 get-integrations --api-id "$API_ID" --output json |
  python3 -c 'import json,sys; arn=sys.argv[1]; print(next((i["IntegrationId"] for i in json.load(sys.stdin)["Items"] if i.get("IntegrationUri")==arn), ""))' "$FN_ARN")
if [[ -z "$INTEGRATION" ]]; then
  INTEGRATION=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "$FN_ARN" --payload-format-version 2.0 --query IntegrationId --output text)
fi
echo "API $API_ID, integration $INTEGRATION"

# 3. Routes: POST /cancel on, UnsubscribeUser's routes off
route_id() { aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='$1'].RouteId" --output text; }
if [[ -z "$(route_id "POST /cancel")" ]]; then
  aws apigatewayv2 create-route --api-id "$API_ID" --route-key "POST /cancel" --target "integrations/$INTEGRATION" --query RouteKey --output text
else
  aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$(route_id "POST /cancel")" --target "integrations/$INTEGRATION" --query RouteKey --output text
fi
for key in "POST /unsubscribe" "POST /unsubscribe/one-click" "GET /unsubscribe"; do
  old=$(route_id "$key")
  [[ -n "$old" ]] && aws apigatewayv2 delete-route --api-id "$API_ID" --route-id "$old" && echo "Removed $key"
done
[[ -n "$(route_id "ANY /unsubscribe")" ]] && echo "Note: ANY /unsubscribe still exists; delete it if nothing needs it"

# 4. API Gateway may invoke the function on that route
aws lambda add-permission --function-name "$FN" --statement-id apigw-cancel-route \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$AWS_REGION:$ACCOUNT:$API_ID/*/POST/cancel" >/dev/null 2>&1 \
  && echo "Added invoke permission" || echo "Invoke permission exists"

# 5. CORS: only the site (and the local preview) may call the API from a browser
aws apigatewayv2 update-api --api-id "$API_ID" \
  --cors-configuration "AllowOrigins=$ORIGINS,AllowMethods=POST,AllowHeaders=content-type,MaxAge=600" \
  --query CorsConfiguration.AllowOrigins --output text

# 6. Route throttle, separate from the API's default. Other routes' settings are kept; the old
# unsubscribe routes' are dropped.
STAGE=$(aws apigatewayv2 get-stages --api-id "$API_ID" --query 'Items[0].StageName' --output text)
# update-stage merges route settings, so the old routes' settings must be deleted on their own.
for key in "POST /unsubscribe" "POST /unsubscribe/one-click"; do
  aws apigatewayv2 delete-route-settings --api-id "$API_ID" --stage-name "$STAGE" --route-key "$key" >/dev/null 2>&1 \
    && echo "Removed throttle for $key" || true
done
settings=$(aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE" --query RouteSettings --output json |
  python3 -c 'import json,sys; raw=sys.stdin.read().strip(); s=(json.loads(raw) if raw else None) or {}; [s.pop(k, None) for k in ("POST /unsubscribe", "POST /unsubscribe/one-click")]; s["POST /cancel"]={"ThrottlingRateLimit": 2, "ThrottlingBurstLimit": 5}; print(json.dumps(s))')
aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name "$STAGE" --route-settings "$settings" \
  --query 'keys(RouteSettings)' --output text
if [[ "$(aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE" --query AutoDeploy --output text)" != "True" ]]; then
  aws apigatewayv2 create-deployment --api-id "$API_ID" --stage-name "$STAGE" --query DeploymentStatus --output text
fi

base=$(aws apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint --output text)
[[ "$STAGE" == '$default' ]] || base="$base/$STAGE"
echo
echo "Set in config.js:  cancelApiUrl: \"$base/cancel\""
echo "Then delete the old $OLD_FN function once the new page is live."
