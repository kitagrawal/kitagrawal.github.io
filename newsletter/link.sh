#!/usr/bin/env bash
# Print the unsubscribe link a letter would carry for one customer, for testing
# (reads UnsubscribeUser's HMAC key from SSM; us-east-2, profile "newsletter").
#
#   ./link.sh cus_123                                   # the live site page
#   ./link.sh cus_123 http://localhost:8000/unsubscribe.html
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
c=${1:?usage: ./link.sh cus_... [page url]}
page=${2:-https://kitagrawal.github.io/unsubscribe.html}
name=$(aws lambda get-function-configuration --function-name UnsubscribeUser --query Environment.Variables.HMAC_KEY_PARAM --output text)
key=$(aws ssm get-parameter --name "$name" --with-decryption --query Parameter.Value --output text)
KEY="$key" node --input-type=module -e '
  import { unsubscribePageUrl } from "./rules.mjs";
  console.log(unsubscribePageUrl(process.argv[1], process.argv[2], process.env.KEY));
' "$page" "$c"
