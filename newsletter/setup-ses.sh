#!/usr/bin/env bash
# One-off, safe to re-run: verify appliedailetter.com as the SES sending domain (us-east-2, profile "newsletter").
# The owner runs this; it changes live AWS. DNS stays at IONOS: the script prints the records to paste there.
#
#   ./setup-ses.sh              # create or reuse everything, print the DNS records, wait for verification
#   ./setup-ses.sh --no-wait    # same, but do not poll for verification (run it again later to check)
#
# Creates or reuses:
#   - the domain identity with Easy DKIM (RSA 2048 bit)
#   - the custom MAIL FROM domain bounce.<domain>, behaviour on MX failure "use default"
#   - one configuration set (reputation metrics on) for letters and reader emails, set as the identity's default
# SES stays in the sandbox until production access is granted (docs/newsletter-ses/production-access.md).
set -euo pipefail
export AWS_PROFILE=newsletter AWS_REGION=us-east-2
DOMAIN=appliedailetter.com
MAIL_FROM_DOMAIN="bounce.$DOMAIN"
CONFIG_SET=newsletter
POLL_TRIES=30     # x POLL_SECONDS = 10 minutes at most
POLL_SECONDS=20

WAIT=1
case "${1:-}" in
  "") ;;
  --no-wait) WAIT=0 ;;
  *) echo "Usage: $0 [--no-wait]" >&2; exit 1 ;;
esac

# 1. Domain identity with Easy DKIM
if aws sesv2 get-email-identity --email-identity "$DOMAIN" >/dev/null 2>&1; then
  echo "Identity $DOMAIN exists"
  # Only touch the key length when it differs, so a re-run never starts a needless key rotation.
  if [[ "$(aws sesv2 get-email-identity --email-identity "$DOMAIN" --query DkimAttributes.Origin --output text)" == AWS_SES ]]; then
    length=$(aws sesv2 get-email-identity --email-identity "$DOMAIN" --query DkimAttributes.CurrentSigningKeyLength --output text)
    if [[ "$length" != RSA_2048_BIT ]]; then
      aws sesv2 put-email-identity-dkim-signing-attributes --email-identity "$DOMAIN" \
        --signing-attributes-origin AWS_SES --signing-attributes NextSigningKeyLength=RSA_2048_BIT >/dev/null
      echo "DKIM key length was $length: switching to RSA_2048_BIT"
    fi
  else
    echo "Note: $DOMAIN does not use Easy DKIM (origin is not AWS_SES); the DKIM records below may not apply" >&2
  fi
else
  aws sesv2 create-email-identity --email-identity "$DOMAIN" \
    --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT \
    --tags Key=project,Value=newsletter \
    --query VerifiedForSendingStatus --output text >/dev/null
  echo "Identity $DOMAIN created"
fi

# 2. Custom MAIL FROM (bounces and SPF alignment come from this subdomain, not the root domain)
aws sesv2 put-email-identity-mail-from-attributes --email-identity "$DOMAIN" \
  --mail-from-domain "$MAIL_FROM_DOMAIN" --behavior-on-mx-failure USE_DEFAULT_VALUE
echo "MAIL FROM $MAIL_FROM_DOMAIN set (behaviour on MX failure: use default)"

# 3. Configuration set: one for letters and reader emails, reputation metrics on
if aws sesv2 get-configuration-set --configuration-set-name "$CONFIG_SET" >/dev/null 2>&1; then
  echo "Configuration set $CONFIG_SET exists"
else
  aws sesv2 create-configuration-set --configuration-set-name "$CONFIG_SET" \
    --reputation-options ReputationMetricsEnabled=true --sending-options SendingEnabled=true \
    --tags Key=project,Value=newsletter
  echo "Configuration set $CONFIG_SET created"
fi
aws sesv2 put-configuration-set-reputation-options --configuration-set-name "$CONFIG_SET" --reputation-metrics-enabled
aws sesv2 put-configuration-set-sending-options --configuration-set-name "$CONFIG_SET" --sending-enabled
aws sesv2 put-email-identity-configuration-set-attributes --email-identity "$DOMAIN" --configuration-set-name "$CONFIG_SET"
echo "Configuration set $CONFIG_SET: reputation metrics on, default for $DOMAIN"

# 4. The DNS records for IONOS
tokens=$(aws sesv2 get-email-identity --email-identity "$DOMAIN" --query 'DkimAttributes.Tokens' --output text)
[[ -n "$tokens" && "$tokens" != None ]] || { echo "No DKIM tokens for $DOMAIN yet; run this script again" >&2; exit 1; }

echo
echo "============================================================"
echo "Add these records in IONOS (DNS settings for $DOMAIN)."
echo "In IONOS the host name is the part before .$DOMAIN."
echo "============================================================"
echo
echo "1-3. DKIM, three CNAME records:"
for t in $tokens; do
  printf '  CNAME  host: %-34s value: %s\n' "${t}._domainkey" "${t}.dkim.amazonses.com"
done
echo
echo "4. MAIL FROM, MX record:"
printf '  MX     host: %-34s value: %s   priority: 10\n' bounce "feedback-smtp.$AWS_REGION.amazonses.com"
echo
echo "5. MAIL FROM, SPF TXT record:"
printf '  TXT    host: %-34s value: %s\n' bounce '"v=spf1 include:amazonses.com ~all"'
echo
echo "Full names, for tools that want them:"
for t in $tokens; do
  echo "  ${t}._domainkey.$DOMAIN  CNAME  ${t}.dkim.amazonses.com"
done
echo "  $MAIL_FROM_DOMAIN  MX   10 feedback-smtp.$AWS_REGION.amazonses.com"
echo "  $MAIL_FROM_DOMAIN  TXT  \"v=spf1 include:amazonses.com ~all\""
echo
echo "Leave these alone: the root SPF TXT, the root MX records (IONOS mailboxes such as support@) and the"
echo "DMARC TXT (_dmarc, p=none) stay exactly as they are. DMARC passes through DKIM alignment, and the"
echo "SPF and MX records above sit on the bounce subdomain, so they never touch the root's mail."
echo

# 5. Verification status
status() {
  aws sesv2 get-email-identity --email-identity "$DOMAIN" \
    --query '[DkimAttributes.Status, MailFromAttributes.MailFromDomainStatus]' --output text
}
if [[ "$WAIT" == 0 ]]; then
  read -r dkim mailfrom <<<"$(status)"
  echo "Status now: DKIM $dkim, MAIL FROM $mailfrom (run ./setup-ses.sh again to re-check)"
  exit 0
fi
echo "Add the records, then this waits up to $((POLL_TRIES * POLL_SECONDS / 60)) minutes for SES to see them (Ctrl-C is safe; re-run to check again)."
for ((i = 1; i <= POLL_TRIES; i++)); do
  read -r dkim mailfrom <<<"$(status)"
  echo "[$i/$POLL_TRIES] DKIM $dkim, MAIL FROM $mailfrom"
  if [[ "$dkim" == SUCCESS && "$mailfrom" == SUCCESS ]]; then
    echo "Verified: $DOMAIN can send from letters@$DOMAIN. SES is still in the sandbox until production access is granted."
    echo "Next: ./setup-send.sh"
    exit 0
  fi
  if [[ "$dkim" == FAILED || "$mailfrom" == FAILED || "$mailfrom" == TEMPORARY_FAILURE ]]; then
    echo "SES reports a failure: check the records above for typos (IONOS may append .$DOMAIN to a full name)" >&2
  fi
  sleep "$POLL_SECONDS"
done
echo "Not verified yet. DNS can take longer: run ./setup-ses.sh again later, or ./setup-ses.sh --no-wait for a quick check." >&2
exit 1
