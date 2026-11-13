#!/usr/bin/env bash
# One-off, safe to re-run: put UnsubscribeUser's two routes on its HTTP API, give them their own
# low throttle, and allow the site's origin through CORS (us-east-2, profile "newsletter").
#
#   ./setup-unsubscribe.sh                  # finds the API that integrates UnsubscribeUser
#   API_ID=abc123 ./setup-unsubscribe.sh
#
# No owner email: while a plan still bills, the page's cancel button gets a Stripe customer-portal link
# from the Lambda that opens on "Cancel subscription" with no login, and StripeSync's webhook records
# the cancel. That needs one restricted Stripe key (rk_) with only "Customer portal: Write", which you
# store yourself in Secrets Manager as applied-ai-letter/stripe (plain key, or JSON holding it). This
# script points the Lambda at it and lets it read that one secret. It also removes the earlier SNS owner-email wiring if it exists.
#
# Routes: POST /unsubscribe (the hidden page), POST /unsubscribe/one-click (List-Unsubscribe-Post).
# The old GET /unsubscribe confirm page is removed. Prints the URL for config.js.
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
FN=UnsubscribeUser
ORIGINS="https://kitagrawal.github.io,http://localhost:8000"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 1. The API and the integration that already point at UnsubscribeUser
find_integration() { # api-id -> integration id, or nothing
  aws apigatewayv2 get-integrations --api-id "$1" --output json |
    python3 -c 'import json,sys; fn=sys.argv[1]; print(next((i["IntegrationId"] for i in json.load(sys.stdin)["Items"] if i.get("IntegrationUri","").split(":function:")[-1].split(":")[0].split("/")[0]==fn), ""))' "$FN"
}
if [[ -z "${API_ID:-}" ]]; then
  for id in $(aws apigatewayv2 get-apis --query 'Items[?ProtocolType==`HTTP`].ApiId' --output text); do
    [[ -n "$(find_integration "$id")" ]] && { API_ID=$id; break; }
  done
fi
[[ -n "${API_ID:-}" ]] || { echo "No HTTP API integrates $FN; set API_ID" >&2; exit 1; }
INTEGRATION=$(find_integration "$API_ID")
[[ -n "$INTEGRATION" ]] || { echo "API $API_ID has no integration for $FN" >&2; exit 1; }
echo "API $API_ID, integration $INTEGRATION"

# 2. Routes
route_id() { aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='$1'].RouteId" --output text; }
for key in "POST /unsubscribe" "POST /unsubscribe/one-click"; do
  if [[ -z "$(route_id "$key")" ]]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$key" --target "integrations/$INTEGRATION" --query RouteKey --output text
  else
    aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$(route_id "$key")" --target "integrations/$INTEGRATION" --query RouteKey --output text
  fi
done
old=$(route_id "GET /unsubscribe")
[[ -n "$old" ]] && aws apigatewayv2 delete-route --api-id "$API_ID" --route-id "$old" && echo "Removed GET /unsubscribe"
[[ -n "$(route_id "ANY /unsubscribe")" ]] && echo "Note: ANY /unsubscribe still exists; the POST routes take precedence"

# 3. API Gateway may invoke the function on both routes
aws lambda add-permission --function-name "$FN" --statement-id apigw-unsubscribe-routes \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$AWS_REGION:$ACCOUNT:$API_ID/*/POST/unsubscribe*" >/dev/null 2>&1 \
  && echo "Added invoke permission" || echo "Invoke permission exists"

# 4. CORS: only the site (and the local preview) may call the API from a browser
aws apigatewayv2 update-api --api-id "$API_ID" \
  --cors-configuration "AllowOrigins=$ORIGINS,AllowMethods=POST,AllowHeaders=content-type,MaxAge=600" \
  --query CorsConfiguration.AllowOrigins --output text

# 5. Route throttle, separate from the API's default
STAGE=$(aws apigatewayv2 get-stages --api-id "$API_ID" --query 'Items[0].StageName' --output text)
aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name "$STAGE" --route-settings '{
  "POST /unsubscribe": {"ThrottlingRateLimit": 2, "ThrottlingBurstLimit": 5},
  "POST /unsubscribe/one-click": {"ThrottlingRateLimit": 2, "ThrottlingBurstLimit": 5}
}' --query 'keys(RouteSettings)' --output text
if [[ "$(aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE" --query AutoDeploy --output text)" != "True" ]]; then
  aws apigatewayv2 create-deployment --api-id "$API_ID" --stage-name "$STAGE" --query DeploymentStatus --output text
fi

# 6. The portal key: the Lambda may read the /newsletter/unsubscribe* parameters and the one Stripe
# secret, and its env names the secret and where Stripe returns the reader. Also removes the old
# owner-email wiring (safe if never there).
PORTAL_SECRET_ID=applied-ai-letter/stripe
RETURN_URL=https://kitagrawal.github.io/
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$PORTAL_SECRET_ID" --query ARN --output text 2>/dev/null || true)
role=$(aws lambda get-function-configuration --function-name "$FN" --query Role --output text)
aws iam delete-role-policy --role-name "${role##*/}" --policy-name sns-unsubscribes 2>/dev/null || true
aws iam put-role-policy --role-name "${role##*/}" --policy-name ssm-unsubscribe-params --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"ssm:GetParameter\",
    \"Resource\": \"arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter/newsletter/unsubscribe*\"}]
}"
if [[ -n "$SECRET_ARN" ]]; then
  aws iam put-role-policy --role-name "${role##*/}" --policy-name stripe-portal-secret --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\", \"Resource\": \"$SECRET_ARN\"}]
  }"
else
  echo "Note: secret $PORTAL_SECRET_ID not found; until it exists, the cancel button falls back to the portal login link"
fi
vars=$(aws lambda get-function-configuration --function-name "$FN" --query Environment.Variables --output json)
env=$(python3 -c 'import json,sys; v=json.loads(sys.argv[1]) or {}; v.pop("UNSUBSCRIBE_TOPIC_ARN", None); v.pop("STRIPE_PORTAL_KEY_PARAM", None); v["STRIPE_PORTAL_SECRET_ID"]=sys.argv[2]; v["PORTAL_RETURN_URL"]=sys.argv[3]; print(json.dumps({"Variables": v}))' "$vars" "$PORTAL_SECRET_ID" "$RETURN_URL")
aws lambda update-function-configuration --function-name "$FN" --environment "$env" --query LastUpdateStatus --output text >/dev/null
aws lambda wait function-updated-v2 --function-name "$FN"
echo "$FN: no SNS topic; portal key from secret $PORTAL_SECRET_ID"

base=$(aws apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint --output text)
[[ "$STAGE" == '$default' ]] || base="$base/$STAGE"
echo
echo "Set in config.js:  unsubscribeApiUrl: \"$base/unsubscribe\""
echo "Letter header:     List-Unsubscribe: <$base/unsubscribe/one-click?c=CUS&t=TOKEN>"
echo "                   List-Unsubscribe-Post: List-Unsubscribe=One-Click"
