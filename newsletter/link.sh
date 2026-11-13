#!/usr/bin/env bash
# Print the Cancel link a letter would carry for one customer, for testing. No AWS call: the link is
# just the page plus ?c=<customer id>.
#
#   ./link.sh cus_123                                   # the live site page
#   ./link.sh cus_123 http://localhost:8000/unsubscribe.html
set -euo pipefail
cd "$(dirname "$0")"
c=${1:?usage: ./link.sh cus_... [page url]}
page=${2:-https://kitagrawal.github.io/unsubscribe.html}
node --input-type=module -e '
  import { cancelPageUrl } from "./rules.mjs";
  console.log(cancelPageUrl(process.argv[1], process.argv[2]));
' "$page" "$c"
