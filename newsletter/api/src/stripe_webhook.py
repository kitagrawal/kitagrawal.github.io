"""POST /stripe/webhook - keeps the DynamoDB subscriber table in sync with Stripe."""
import json

import common as c

WELCOME_SUBJECT = "Welcome to the Applied AI Letter"
WELCOME_TEXT = """Thank you for joining the Applied AI Letter. Your plan is live.

A new letter lands in your inbox whenever there is something worth your time. Replies to any letter reach me directly, so tell me what you are working on.

Your plan runs on a paid period, and you can unsubscribe any time with the link below. Letters then continue until the paid period ends.

--
Unsubscribe: {cancel_url}
Questions or trouble with your plan? Email support@appliedailetter.com.
"""


def handler(event, context):
    payload = c.body_of(event)
    sig = (event.get("headers") or {}).get("stripe-signature")
    signing = c.webhook_secret()
    if not signing or not c.verify_stripe_signature(payload, sig, signing):
        return c.resp(400, {"error": "invalid signature"})

    evt = json.loads(payload)
    obj = evt["data"]["object"]
    ts = evt.get("created", 0)
    etype = evt["type"]

    email = applied = old = None

    # checkout.session.completed is not handled: it carries no product, and the
    # customer.subscription.created event that follows it records the plan.
    if etype in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        email, applied, old = c.apply_subscription(obj, ts)

    elif etype == "customer.updated":
        # email change: find the row by customer id and re-key it
        cust_id, new_email = obj["id"], c.norm_email(obj.get("email"))
        rows = c.find_by_customer(cust_id)
        if rows and new_email and rows[0]["email"] != new_email:
            row = rows[0]
            fields = {k: v for k, v in row.items() if k not in ("email", "last_event_ts", "created_at", "updated_at")}
            applied, _ = c.upsert_subscriber(new_email, fields, ts)
            if applied:
                c.drop_stale_emails(cust_id, new_email)

    # Welcome email only on the transition into an active state, so duplicate/out-of-order events don't resend.
    if applied and email:
        was_active = bool(old) and old.get("status") in c.ACTIVE_STATUSES
        row = c.table().get_item(Key={"email": email}).get("Item", {})
        if not was_active and c.is_deliverable(row):
            try:
                c.send_email(email, WELCOME_SUBJECT, text=WELCOME_TEXT.format(cancel_url=c.cancel_url(row["stripe_customer_id"])))
            except Exception as e:  # never fail the webhook over a welcome email
                print(f"welcome email failed for {email}: {e}")

    return c.resp(200, {"received": True, "type": etype})
