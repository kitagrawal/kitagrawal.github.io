#!/usr/bin/env bash
# One-off, safe to re-run: set up publishing, the SendIssue Lambda that sends a letter when Markdown is
# uploaded to the articles bucket (us-east-2, profile "newsletter"). The owner runs this; it changes live AWS.
#
#   AUTHOR_EMAIL=you@example.com ./setup-send.sh
#   AUTHOR_EMAIL=you@example.com REPLY_TO=other@example.com ./setup-send.sh
#
# AUTHOR_EMAIL is where proofs go. REPLY_TO is where readers' replies go (default support@appliedailetter.com).
# A value containing REPLACE is refused. Run ./setup-ses.sh first: this script needs the SES identity and
# configuration set. While SES is in the sandbox, verify AUTHOR_EMAIL as an SES email identity or proofs fail.
#
# Creates or updates:
#   - the DynamoDB table newsletter-sends, key (issue_id, email_lc), on-demand: one row per letter sent to a reader
#   - the role send-issue-role, least privilege: read drafts/* and issues/* in the bucket, scan the subscribers
#     table, write the sends table, send from the SES identity and configuration set, read the SES account,
#     put metrics in the Newsletter namespace, write logs
#   - the function SendIssue (900 s, 256 MB) with the code from this folder
#   - the bucket's public access block (all four on), the S3 permission to invoke SendIssue, and the bucket
#     notification for ObjectCreated on drafts/*.md and issues/*.md
#   - StripeSync's reader emails (section 7, last): an extra role policy "reader-emails" on StripeSync's role
#     (ses:SendEmail on the identity and configuration set, ses:GetAccount, dynamodb:UpdateItem on the
#     subscribers table for the claim fields, cloudwatch:PutMetricData in the Newsletter namespace) and the
#     env vars FROM, REPLY_TO, CONFIG_SET, CANCEL_PAGE merged into StripeSync's existing ones. It lives here,
#     not in a script of its own, because it needs the same sender, reply-to and refusal of REPLACE values.
#     The policy has its own name, so setup-dynamodb.sh's "dynamodb-subscribers" policy is left alone.
#     StripeSync only starts sending once ./deploy.sh has pushed the code that does it.
#
# Bucket notification: put-bucket-notification-configuration replaces the bucket's whole notification
# configuration. This script reads the current one first, drops only its own "send-issue-*" entries and
# keeps everything else, but check the output if the bucket has other triggers.
# Later code changes (and the StripeSync code that sends reader emails): ./deploy.sh
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
FN=SendIssue
ROLE=send-issue-role
BUCKET=ain-articles-391712294679-us-east-2-an
TABLE=stripe-sync-subscription-status
SENDS=newsletter-sends
DOMAIN=appliedailetter.com
CONFIG_SET=newsletter
FROM="The Applied AI Letter <letters@$DOMAIN>"
CANCEL_PAGE=https://kitagrawal.github.io/unsubscribe.html
AUTHOR_EMAIL=${AUTHOR_EMAIL:-REPLACE-author-email}
REPLY_TO=${REPLY_TO:-support@$DOMAIN}

for name in AUTHOR_EMAIL REPLY_TO; do
  value=${!name}
  if [[ "$value" == *REPLACE* ]]; then
    echo "$name is not set (it is \"$value\"): run  $name=you@example.com ./setup-send.sh" >&2
    exit 1
  fi
  [[ "$value" =~ ^[^[:space:]\"\\\<\>,]+@[^[:space:]\"\\\<\>,]+$ ]] || { echo "$name \"$value\" is not a plain email address" >&2; exit 1; }
done

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 || { echo "Bucket $BUCKET not found or not accessible" >&2; exit 1; }
TABLE_ARN=$(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableArn --output text)
aws lambda get-function --function-name StripeSync >/dev/null 2>&1 || { echo "Lambda StripeSync not found: run ./setup-dynamodb.sh first" >&2; exit 1; }
aws sesv2 get-email-identity --email-identity "$DOMAIN" >/dev/null 2>&1 || { echo "SES identity $DOMAIN not found: run ./setup-ses.sh first" >&2; exit 1; }
aws sesv2 get-configuration-set --configuration-set-name "$CONFIG_SET" >/dev/null 2>&1 || { echo "SES configuration set $CONFIG_SET not found: run ./setup-ses.sh first" >&2; exit 1; }

# 1. The sends table
if aws dynamodb describe-table --table-name "$SENDS" >/dev/null 2>&1; then
  echo "Table $SENDS exists"
else
  aws dynamodb create-table --table-name "$SENDS" \
    --attribute-definitions AttributeName=issue_id,AttributeType=S AttributeName=email_lc,AttributeType=S \
    --key-schema AttributeName=issue_id,KeyType=HASH AttributeName=email_lc,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --deletion-protection-enabled \
    --tags Key=project,Value=newsletter \
    --query TableDescription.TableStatus --output text
  aws dynamodb wait table-exists --table-name "$SENDS"
  echo "Table $SENDS created"
fi
key=$(aws dynamodb describe-table --table-name "$SENDS" --query 'Table.KeySchema[*].[AttributeName,KeyType]' --output text)
[[ "$key" == $'issue_id\tHASH\nemail_lc\tRANGE' ]] || { echo "Table $SENDS has key '$key', expected 'issue_id HASH, email_lc RANGE'; SendIssue will fail" >&2; exit 1; }
SENDS_ARN=$(aws dynamodb describe-table --table-name "$SENDS" --query Table.TableArn --output text)

# 2. The role (created if missing), then its policy (always put, so edits here take effect)
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }'
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # let the new role propagate before Lambda uses it
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)
aws iam put-role-policy --role-name "$ROLE" --policy-name send-issue-access --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"s3:GetObject\",
     \"Resource\": [\"arn:aws:s3:::$BUCKET/drafts/*\", \"arn:aws:s3:::$BUCKET/issues/*\"]},
    {\"Effect\": \"Allow\", \"Action\": \"dynamodb:Scan\", \"Resource\": \"$TABLE_ARN\"},
    {\"Effect\": \"Allow\", \"Action\": [\"dynamodb:PutItem\", \"dynamodb:UpdateItem\", \"dynamodb:DeleteItem\"], \"Resource\": \"$SENDS_ARN\"},
    {\"Effect\": \"Allow\", \"Action\": \"ses:SendEmail\",
     \"Resource\": [\"arn:aws:ses:$AWS_REGION:$ACCOUNT:identity/$DOMAIN\", \"arn:aws:ses:$AWS_REGION:$ACCOUNT:configuration-set/$CONFIG_SET\"]},
    {\"Effect\": \"Allow\", \"Action\": \"ses:GetAccount\", \"Resource\": \"*\"},
    {\"Effect\": \"Allow\", \"Action\": \"cloudwatch:PutMetricData\", \"Resource\": \"*\",
     \"Condition\": {\"StringEquals\": {\"cloudwatch:namespace\": \"Newsletter\"}}}
  ]
}"
echo "Role $ROLE: least-privilege policy set"

# 3. The function: created with the code zipped from this folder, or its configuration updated
ENV="{\"Variables\": {\"TABLE_NAME\": \"$TABLE\", \"SENDS_TABLE\": \"$SENDS\", \"AUTHOR_EMAIL\": \"$AUTHOR_EMAIL\", \"REPLY_TO\": \"$REPLY_TO\", \"FROM\": \"$FROM\", \"CONFIG_SET\": \"$CONFIG_SET\", \"CANCEL_PAGE\": \"$CANCEL_PAGE\"}}"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-configuration --function-name "$FN" --environment "$ENV" --timeout 900 --memory-size 256 \
    --role "$ROLE_ARN" --query LastUpdateStatus --output text >/dev/null
else
  tmp=$(mktemp -d)
  mkdir -p "$tmp/stage/vendor"
  cp send-issue/index.mjs lib.mjs rules.mjs letter.mjs "$tmp/stage/"
  cp vendor/marked.esm.js "$tmp/stage/vendor/"
  (cd "$tmp/stage" && zip -q -r "$tmp/send-issue.zip" .)
  runtime=$(aws lambda get-function-configuration --function-name StripeSync --query Runtime --output text)
  arch=$(aws lambda get-function-configuration --function-name StripeSync --query 'Architectures[0]' --output text)
  aws lambda create-function --function-name "$FN" --runtime "$runtime" --architectures "$arch" \
    --role "$ROLE_ARN" --handler index.handler --timeout 900 --memory-size 256 --environment "$ENV" \
    --zip-file "fileb://$tmp/send-issue.zip" --query FunctionArn --output text
  rm -r "$tmp"
fi
aws lambda wait function-updated-v2 --function-name "$FN"
FN_ARN=$(aws lambda get-function --function-name "$FN" --query Configuration.FunctionArn --output text)
echo "$FN: ready (author $AUTHOR_EMAIL, replies to $REPLY_TO)"

# 4. The bucket stays private: block every kind of public access
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "Bucket $BUCKET: public access blocked"

# 5. S3 may invoke the function (this must exist before the notification is put)
aws lambda add-permission --function-name "$FN" --statement-id s3-articles-bucket \
  --action lambda:InvokeFunction --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::$BUCKET" --source-account "$ACCOUNT" >/dev/null 2>&1 \
  && echo "Added invoke permission" || echo "Invoke permission exists"

# 6. The bucket notification: drafts/*.md and issues/*.md. put-bucket-notification-configuration replaces
# the whole configuration, so keep whatever else is there and swap only the send-issue-* entries.
current=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET" --output json || true)
merged=$(python3 -c '
import json, sys
fn_arn = sys.argv[1]
raw = sys.stdin.read().strip()
cfg = json.loads(raw) if raw else {}
others = [c for c in cfg.get("LambdaFunctionConfigurations", []) if not str(c.get("Id", "")).startswith("send-issue-")]
def rule(prefix):
    return {"Id": "send-issue-" + prefix.strip("/"), "LambdaFunctionArn": fn_arn, "Events": ["s3:ObjectCreated:*"],
            "Filter": {"Key": {"FilterRules": [{"Name": "prefix", "Value": prefix}, {"Name": "suffix", "Value": ".md"}]}}}
cfg["LambdaFunctionConfigurations"] = others + [rule("drafts/"), rule("issues/")]
print(json.dumps(cfg))
' "$FN_ARN" <<<"$current")
aws s3api put-bucket-notification-configuration --bucket "$BUCKET" --notification-configuration "$merged"
echo "Bucket $BUCKET: ObjectCreated on drafts/*.md and issues/*.md invokes $FN"

# 7. StripeSync's reader emails: permissions and env vars. The policy has its own name; the env vars are
# merged into the existing ones because update-function-configuration --environment replaces them all.
SS_ROLE=$(aws lambda get-function-configuration --function-name StripeSync --query Role --output text)
SS_ROLE=${SS_ROLE##*/}
aws iam put-role-policy --role-name "$SS_ROLE" --policy-name reader-emails --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"ses:SendEmail\",
     \"Resource\": [\"arn:aws:ses:$AWS_REGION:$ACCOUNT:identity/$DOMAIN\", \"arn:aws:ses:$AWS_REGION:$ACCOUNT:configuration-set/$CONFIG_SET\"]},
    {\"Effect\": \"Allow\", \"Action\": \"ses:GetAccount\", \"Resource\": \"*\"},
    {\"Effect\": \"Allow\", \"Action\": \"dynamodb:UpdateItem\", \"Resource\": \"$TABLE_ARN\"},
    {\"Effect\": \"Allow\", \"Action\": \"cloudwatch:PutMetricData\", \"Resource\": \"*\",
     \"Condition\": {\"StringEquals\": {\"cloudwatch:namespace\": \"Newsletter\"}}}
  ]
}"
echo "Role $SS_ROLE: reader-emails policy set"
aws lambda wait function-updated-v2 --function-name StripeSync
ss_vars=$(aws lambda get-function-configuration --function-name StripeSync --query Environment.Variables --output json)
ss_env=$(python3 - "$ss_vars" "$FROM" "$REPLY_TO" "$CONFIG_SET" "$CANCEL_PAGE" <<'PY'
import json, sys
v = json.loads(sys.argv[1]) or {}
for k, val in zip(["FROM", "REPLY_TO", "CONFIG_SET", "CANCEL_PAGE"], sys.argv[2:]):
    if "REPLACE" in val:
        sys.exit(f"{k} still holds a REPLACE placeholder")
    v[k] = val
print(json.dumps({"Variables": v}))
PY
)
aws lambda update-function-configuration --function-name StripeSync --environment "$ss_env" --query LastUpdateStatus --output text >/dev/null
aws lambda wait function-updated-v2 --function-name StripeSync
echo "StripeSync: env $(aws lambda get-function-configuration --function-name StripeSync --query 'Environment.Variables | keys(@)' --output text)"

echo
echo "Next:"
echo "  - While SES is in the sandbox, verify $AUTHOR_EMAIL as an SES email identity (it can only send to verified addresses)."
echo "  - Upload a Markdown file with a 'subject:' front matter to drafts/ to get a proof; copy it to issues/ to publish."
echo "  - Run ./deploy.sh to push the code: StripeSync then sends reader emails (welcome, cancel-scheduled, goodbye) once SES has production access."
echo "  - Code changes later: ./deploy.sh"
