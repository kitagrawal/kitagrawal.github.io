#!/usr/bin/env bash
# One-off, safe to re-run: put UnsubscribeUser's two routes on its HTTP API, give them their own
# low throttle, and allow the site's origin through CORS (us-east-2, profile "newsletter").
#
#   ./setup-unsubscribe.sh            # finds the API that already integrates UnsubscribeUser
#   API_ID=abc123 ./setup-unsubscribe.sh
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

base=$(aws apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint --output text)
[[ "$STAGE" == '$default' ]] || base="$base/$STAGE"
echo
echo "Set in config.js:  unsubscribeApiUrl: \"$base/unsubscribe\""
echo "Letter header:     List-Unsubscribe: <$base/unsubscribe/one-click?c=CUS&t=TOKEN>"
echo "                   List-Unsubscribe-Post: List-Unsubscribe=One-Click"
