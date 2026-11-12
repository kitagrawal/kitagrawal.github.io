#!/usr/bin/env bash
# One-off, safe to re-run: run StripeSync's reconcile every night and alarm when StripeSync fails
# (us-east-2, profile "newsletter").
#
#   ALARM_EMAIL=you@example.com ./setup-reconcile.sh     # ALARM_EMAIL is optional
#
# The schedule invokes StripeSync with {"reconcile": true} at 07:00 UTC through an IAM role that
# may only invoke StripeSync. The alarm fires on any StripeSync error (a failed webhook or a
# failed reconcile). With ALARM_EMAIL set, it emails through an SNS topic (confirm the
# subscription email AWS sends); without it, the alarm shows only in the CloudWatch console.
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
FN=StripeSync ROLE=newsletter-reconcile-scheduler SCHEDULE=newsletter-reconcile ALARM=StripeSync-errors
FN_ARN=$(aws lambda get-function --function-name "$FN" --query Configuration.FunctionArn --output text)

# 1. Scheduler role
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }'
  echo "Waiting for the new role to propagate..."; sleep 10
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name invoke-stripe-sync --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"lambda:InvokeFunction\", \"Resource\": \"$FN_ARN\"}]
}"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

# 2. Nightly schedule
target="{\"Arn\": \"$FN_ARN\", \"RoleArn\": \"$ROLE_ARN\", \"Input\": \"{\\\"reconcile\\\": true}\", \"RetryPolicy\": {\"MaximumRetryAttempts\": 2}}"
verb=create; aws scheduler get-schedule --name "$SCHEDULE" >/dev/null 2>&1 && verb=update
aws scheduler "$verb-schedule" --name "$SCHEDULE" --schedule-expression "cron(0 7 * * ? *)" \
  --flexible-time-window Mode=OFF --target "$target" --query ScheduleArn --output text
echo "Schedule $SCHEDULE: nightly 07:00 UTC -> $FN {\"reconcile\": true}"

# 3. Alarm on errors
actions=()
if [[ -n "${ALARM_EMAIL:-}" ]]; then
  topic=$(aws sns create-topic --name newsletter-alarms --query TopicArn --output text)
  aws sns subscribe --topic-arn "$topic" --protocol email --notification-endpoint "$ALARM_EMAIL" --query SubscriptionArn --output text
  actions=(--alarm-actions "$topic")
fi
aws cloudwatch put-metric-alarm --alarm-name "$ALARM" \
  --namespace AWS/Lambda --metric-name Errors --dimensions Name=FunctionName,Value="$FN" \
  --statistic Sum --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching ${actions[@]+"${actions[@]}"}
echo "Alarm $ALARM: any $FN error${ALARM_EMAIL:+ -> email $ALARM_EMAIL}"

echo "Run one reconcile now with:"
echo "  aws lambda invoke --function-name $FN --payload '{\"reconcile\":true}' --cli-binary-format raw-in-base64-out /dev/stdout --profile newsletter --region us-east-2"
