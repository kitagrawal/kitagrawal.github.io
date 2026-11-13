#!/usr/bin/env bash
# Push code changes to the StripeSync, CancelPlan and SendIssue Lambdas (us-east-2, profile "newsletter").
# Each zip holds the function's index.mjs (at the top) plus the shared lib.mjs and rules.mjs.
# SendIssue also gets letter.mjs and vendor/marked.esm.js; the vendor/ path is kept because
# letter.mjs imports "./vendor/marked.esm.js".
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
node --test ./*.test.mjs >/dev/null || { echo "Tests fail; not deploying (run: node --test newsletter/*.test.mjs)" >&2; exit 1; }
tmp=$(mktemp -d)
for pair in stripe-sync:StripeSync cancel-plan:CancelPlan send-issue:SendIssue; do
  dir=${pair%%:*} fn=${pair##*:}
  stage="$tmp/$dir"
  mkdir -p "$stage"
  cp "$dir/index.mjs" lib.mjs rules.mjs "$stage/"
  if [[ "$dir" == send-issue ]]; then
    mkdir -p "$stage/vendor"
    cp letter.mjs "$stage/"
    cp vendor/marked.esm.js "$stage/vendor/"
  fi
  (cd "$stage" && zip -q -r "$tmp/$dir.zip" .)
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$tmp/$dir.zip" --query LastUpdateStatus --output text
  aws lambda wait function-updated-v2 --function-name "$fn"
  echo "$fn updated"
done
rm -r "$tmp"
