#!/usr/bin/env bash
# Push code changes to the two newsletter Lambdas (us-east-2, profile "newsletter").
# Each zip holds the function's index.mjs plus the shared lib.mjs and rules.mjs.
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
node --test ./*.test.mjs >/dev/null || { echo "Tests fail; not deploying (run: node --test newsletter/*.test.mjs)" >&2; exit 1; }
tmp=$(mktemp -d)
for pair in stripe-sync:StripeSync unsubscribe-user:UnsubscribeUser; do
  dir=${pair%%:*} fn=${pair##*:}
  zip -q -j "$tmp/$dir.zip" "$dir/index.mjs" lib.mjs rules.mjs
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$tmp/$dir.zip" --query LastUpdateStatus --output text
  aws lambda wait function-updated-v2 --function-name "$fn"
  echo "$fn updated"
done
rm -r "$tmp"
