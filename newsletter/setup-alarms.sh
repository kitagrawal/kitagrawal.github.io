#!/usr/bin/env bash
# One-off, safe to re-run: email the author when something goes wrong with the letter (us-east-2, profile
# "newsletter"). The owner runs this; it changes live AWS.
#
#   ALERT_EMAIL=you@example.com ./setup-alarms.sh
#
# ALERT_EMAIL is where alerts go. A value containing REPLACE, or one that is not a plain email address, is
# refused. After the first run SNS emails that address a confirmation link: no alert arrives until it is clicked.
#
# Creates or updates (put-metric-alarm replaces an alarm of the same name, so a re-run is harmless):
#   - the SNS topic newsletter-alerts, and one email subscription to ALERT_EMAIL (not added twice; a still
#     unconfirmed one is left as it is, so no second confirmation email is sent)
#   - SES bounce rate above 2% and complaint rate above 0.05% (AWS/SES Reputation.BounceRate and
#     Reputation.ComplaintRate). SES publishes these account-wide with no dimensions, as fractions
#     (0.02 = 2%), so the alarms use no dimensions. SES reviews an account at 5% and 0.1%; these fire first.
#     Hourly average; missing data is fine (SES publishes nothing until it has sent mail).
#   - Lambda Errors above 0 (Sum over 5 minutes) for StripeSync, CancelPlan and SendIssue
#   - Newsletter/RefusedSend above 0 (a real send was refused, in practice because SES is still in the
#     sandbox) and Newsletter/ReaderEmailFailed above 0 (a reader email failed); both are custom metrics that
#     SendIssue and StripeSync write through countMetric in lib.mjs
#   - Newsletter/SendIncomplete above 0 (a real send had failed readers or stopped early for time; SendIssue
#     logs which, and a re-upload of the same issues/ file retries the readers whose claim was removed)
# Every alarm notifies the topic only when it goes into ALARM. Missing data counts as not breaching.
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
cd "$(dirname "$0")"
TOPIC=newsletter-alerts
ALERT_EMAIL=${ALERT_EMAIL:-REPLACE-alert-email}

if [[ "$ALERT_EMAIL" == *REPLACE* ]]; then
  echo "ALERT_EMAIL is not set (it is \"$ALERT_EMAIL\"): run  ALERT_EMAIL=you@example.com ./setup-alarms.sh" >&2
  exit 1
fi
[[ "$ALERT_EMAIL" =~ ^[^[:space:]\"\\\<\>,]+@[^[:space:]\"\\\<\>,]+$ ]] || { echo "ALERT_EMAIL \"$ALERT_EMAIL\" is not a plain email address" >&2; exit 1; }

# 1. The topic and the email subscription
TOPIC_ARN=$(aws sns create-topic --name "$TOPIC" --tags Key=project,Value=newsletter --query TopicArn --output text)
echo "Topic $TOPIC_ARN"
found=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
  --query "length(Subscriptions[?Protocol=='email' && Endpoint=='$ALERT_EMAIL'])" --output text)
if [[ "$found" == 0 ]]; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
  echo "Subscribed $ALERT_EMAIL (SNS has emailed it a confirmation link)"
else
  echo "$ALERT_EMAIL is already subscribed"
fi

# 2. The alarms. put-metric-alarm creates or replaces by name.
alarm() { # name, description, then the rest of the put-metric-alarm arguments
  local name=$1 desc=$2
  shift 2
  aws cloudwatch put-metric-alarm --alarm-name "$name" --alarm-description "$desc" \
    --alarm-actions "$TOPIC_ARN" --treat-missing-data notBreaching --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 --datapoints-to-alarm 1 "$@"
  echo "Alarm $name"
}

alarm newsletter-ses-bounce-rate "SES bounce rate above 2% (SES reviews the account at 5%)" \
  --namespace AWS/SES --metric-name Reputation.BounceRate --statistic Average --period 3600 --threshold 0.02
alarm newsletter-ses-complaint-rate "SES complaint rate above 0.05% (SES reviews the account at 0.1%)" \
  --namespace AWS/SES --metric-name Reputation.ComplaintRate --statistic Average --period 3600 --threshold 0.0005

for fn in StripeSync CancelPlan SendIssue; do
  aws lambda get-function --function-name "$fn" >/dev/null 2>&1 || echo "Note: Lambda $fn does not exist yet; its alarm is created anyway and starts working once it does" >&2
  alarm "newsletter-lambda-errors-$fn" "Lambda $fn reported an error (see its CloudWatch logs)" \
    --namespace AWS/Lambda --metric-name Errors --dimensions "Name=FunctionName,Value=$fn" \
    --statistic Sum --period 300 --threshold 0
done

alarm newsletter-refused-send "A real send was refused: SES is probably still in the sandbox (request production access)" \
  --namespace Newsletter --metric-name RefusedSend --statistic Sum --period 300 --threshold 0
alarm newsletter-reader-email-failed "A reader email (welcome, cancel note or goodbye) failed to send; follow up by hand" \
  --namespace Newsletter --metric-name ReaderEmailFailed --statistic Sum --period 300 --threshold 0
alarm newsletter-send-incomplete "A send finished with failed readers or stopped early (see the SendIssue logs; re-upload the issue to retry)" \
  --namespace Newsletter --metric-name SendIncomplete --statistic Sum --period 300 --threshold 0

echo
echo "Next:"
echo "  - Open the email SNS sent to $ALERT_EMAIL and click Confirm subscription. Until you do, no alert reaches you."
echo "    Check:  aws sns list-subscriptions-by-topic --topic-arn $TOPIC_ARN --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output text"
echo "    (an unconfirmed one shows PendingConfirmation instead of an ARN)"
echo "  - Then upload a draft and submit the production-access request: docs/newsletter-ses/production-access.md"
