"""Shared helpers: SSM secrets, Stripe API + webhook verification, DynamoDB upserts, SES sending.

Stripe values live in one Secrets Manager JSON secret (env STRIPE_SECRET_ID, default applied-ai-letter/stripe):
  STRIPE_SECRET_KEY      a restricted key (rk_ only; sk_ and pk_ keys are refused) with Subscriptions: Write
                         (cancel) and Customers: Read (reconcile, webhook email lookup)
  STRIPE_WEBHOOK_SECRET  the webhook endpoint's signing secret (whsec_)
SSM <prefix>/admin-api-key holds the key publish.mjs sends to POST /send.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from functools import lru_cache

# Letters go to these statuses; past_due keeps letters going while Stripe retries the card.
ACTIVE_STATUSES = {"active", "trialing", "past_due"}
TABLE_NAME = os.environ.get("TABLE_NAME", "")
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/newsletter")
PRODUCT_ID = os.environ.get("NEWSLETTER_PRODUCT_ID", "")
CANCEL_PAGE = "https://kitagrawal.github.io/unsubscribe.html"


# ---------- AWS clients (lazy so tests can run without boto3) ----------
@lru_cache(maxsize=None)
def _client(name):
    import boto3
    return boto3.client(name)


@lru_cache(maxsize=1)
def table():
    import boto3
    return boto3.resource("dynamodb").Table(TABLE_NAME)


@lru_cache(maxsize=None)
def secret(name):
    """Read a SecureString from SSM (cached for the life of the container)."""
    resp = _client("ssm").get_parameter(Name=f"{SSM_PREFIX}/{name}", WithDecryption=True)
    return resp["Parameter"]["Value"]


# ---------- Generic ----------
def norm_email(email):
    return (email or "").strip().lower()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def body_of(event):
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return body


def resp(status, body="", content_type="application/json"):
    if not isinstance(body, str):
        body = json.dumps(body)
    return {"statusCode": status, "headers": {"Content-Type": content_type}, "body": body}


def is_deliverable(item):
    return (
        item.get("status") in ACTIVE_STATUSES
        and not item.get("opted_out")
        and not item.get("suppressed")
    )


def cancel_url(customer_id):
    """The letter's Unsubscribe link (ADR 0001: the customer id alone is the proof)."""
    return f"{CANCEL_PAGE}?{urllib.parse.urlencode({'c': customer_id})}"


# ---------- Stripe ----------
def restricted_key(secret_string):
    """A Secrets Manager value -> the rk_ key in it (plain or any JSON field), else None. Never an sk_ key."""
    s = (secret_string or "").strip()
    values = [s]
    try:
        o = json.loads(s)
        if isinstance(o, dict):
            values = list(o.values())
    except ValueError:
        pass
    for v in values:
        if isinstance(v, str) and re.fullmatch(r"rk_(live|test)_\w+", v.strip()):
            return v.strip()
    return None


@lru_cache(maxsize=1)
def _stripe_secret():
    raw = _client("secretsmanager").get_secret_value(SecretId=os.environ.get("STRIPE_SECRET_ID", "applied-ai-letter/stripe"))
    return raw["SecretString"]


def stripe_key():
    """The rk_ key from the secret, or None when the secret holds no restricted key."""
    return restricted_key(_stripe_secret())


def webhook_secret():
    try:
        value = json.loads(_stripe_secret()).get("STRIPE_WEBHOOK_SECRET", "")
    except (ValueError, AttributeError):
        value = ""
    return value.strip() if isinstance(value, str) and value.strip().startswith("whsec_") else None


def stripe_post(path, form, key):
    req = urllib.request.Request(
        "https://api.stripe.com" + path,
        data=urllib.parse.urlencode(form).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read())


def product_of(item):
    prod = ((item or {}).get("price") or {}).get("product")
    return prod.get("id") if isinstance(prod, dict) else prod


def is_newsletter(sub):
    """True when one of the subscription's items is the newsletter product. Unset product id -> nothing matches."""
    items = (sub.get("items") or {}).get("data") or []
    return bool(PRODUCT_ID) and any(product_of(i) == PRODUCT_ID for i in items)

def verify_stripe_signature(payload, header, signing_secret, tolerance=300, now=None):
    """Verify a Stripe-Signature header (t=...,v1=...). No stripe SDK needed."""
    if not header:
        return False
    parts = {}
    for piece in header.split(","):
        k, _, v = piece.partition("=")
        parts.setdefault(k.strip(), []).append(v.strip())
    try:
        ts = int(parts["t"][0])
    except (KeyError, ValueError):
        return False
    if abs((now or time.time()) - ts) > tolerance:
        return False
    expected = hmac.new(
        signing_secret.encode(), f"{ts}.{payload}".encode(), hashlib.sha256
    ).hexdigest()
    return any(hmac.compare_digest(expected, sig) for sig in parts.get("v1", []))


def stripe_get(path, params=None):
    url = "https://api.stripe.com" + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    key = stripe_key()
    if not key:
        raise RuntimeError("no rk_ STRIPE_SECRET_KEY in the Stripe secret")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


# ---------- DynamoDB ----------
def upsert_subscriber(email, fields, event_ts):
    """Idempotent, out-of-order-safe upsert.

    Skips the write if a newer Stripe event has already been applied.
    Returns (applied, old_item_or_None).
    """
    from botocore.exceptions import ClientError

    email = norm_email(email)
    names = {"#ts": "last_event_ts", "#u": "updated_at", "#c": "created_at"}
    values = {":ts": int(event_ts), ":now": now_iso()}
    sets = ["#ts = :ts", "#u = :now", "#c = if_not_exists(#c, :now)"]
    for i, (k, v) in enumerate(fields.items()):
        if v is None:
            continue
        names[f"#f{i}"] = k
        values[f":f{i}"] = v
        sets.append(f"#f{i} = :f{i}")
    try:
        r = table().update_item(
            Key={"email": email},
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression="attribute_not_exists(#ts) OR #ts <= :ts",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_OLD",
        )
        return True, r.get("Attributes")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False, None
        raise


def find_by_customer(customer_id):
    from boto3.dynamodb.conditions import Key
    r = table().query(
        IndexName="customer-index", KeyConditionExpression=Key("stripe_customer_id").eq(customer_id)
    )
    return r.get("Items", [])


def drop_stale_emails(customer_id, keep_email):
    """If a customer changed their email in Stripe, remove the old row so it can't keep receiving mail."""
    for item in find_by_customer(customer_id):
        if item["email"] != keep_email:
            table().delete_item(Key={"email": item["email"]})


def apply_subscription(sub, event_ts):
    """Write a Stripe subscription object into the table. Returns (email, applied, old_item)."""
    if not is_newsletter(sub):
        return None, False, None
    cust = sub["customer"]
    cust_id = cust["id"] if isinstance(cust, dict) else cust
    email = cust.get("email") if isinstance(cust, dict) else None
    if not email:
        existing = find_by_customer(cust_id)
        email = existing[0]["email"] if existing else stripe_get(f"/v1/customers/{cust_id}").get("email")
    if not email:
        return None, False, None
    email = norm_email(email)
    items = (sub.get("items") or {}).get("data") or []
    item = [i for i in items if product_of(i) == PRODUCT_ID] or [{}]
    fields = {
        "status": sub["status"],
        "stripe_customer_id": cust_id,
        "subscription_id": sub["id"],
        "price_id": (item[0].get("price") or {}).get("id"),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "current_period_end": sub.get("current_period_end") or (item[0] or {}).get("current_period_end"),
    }
    applied, old = upsert_subscriber(email, fields, event_ts)
    if applied:
        drop_stale_emails(cust_id, email)
    return email, applied, old


# ---------- SES ----------
def send_email(to, subject, html=None, text=None):
    """No List-Unsubscribe headers (ADR 0002): every reader pays, and leaving means cancelling the plan."""
    body = {}
    if text:
        body["Text"] = {"Data": text, "Charset": "UTF-8"}
    if html:
        body["Html"] = {"Data": html, "Charset": "UTF-8"}
    simple = {"Subject": {"Data": subject, "Charset": "UTF-8"}, "Body": body}
    return _client("sesv2").send_email(
        FromEmailAddress=os.environ["FROM_ADDRESS"],
        Destination={"ToAddresses": [to]},
        Content={"Simple": simple},
        ConfigurationSetName=os.environ.get("CONFIG_SET"),
    )
