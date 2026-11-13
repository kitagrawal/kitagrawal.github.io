"""POST /cancel  {"c": "<Stripe customer id>"} from the hidden unsubscribe.html page.

The letter's Unsubscribe link is unsubscribe.html?c=<customer id>; the id alone is the proof (docs/adr/0001).
For a live plan with no cancel scheduled, sets cancel_at_period_end in Stripe, so letters continue until
the paid period ends. It never writes the table: the webhook records the change.
Answers 200 {"done": true, "until": <unix seconds>}, or 200 {"error": "support"} for every other case,
in one shape so customer ids cannot be probed.
"""
import json
import re

import common as c

SUPPORT = {"error": "support"}
CUSTOMER_ID = re.compile(r"cus_[A-Za-z0-9]+")


def decision(customer_id, rows):
    """-> subscription id to cancel, or None (unknown id, not live, or a cancel already scheduled)."""
    if not isinstance(customer_id, str) or not CUSTOMER_ID.fullmatch(customer_id):
        return None
    for row in rows or []:
        if row.get("subscription_id") and row.get("status") in c.ACTIVE_STATUSES and not row.get("cancel_at_period_end"):
            return row["subscription_id"]
    return None


def period_end(sub):
    end = sub.get("current_period_end")
    if end is None:
        items = (sub.get("items") or {}).get("data") or [{}]
        end = items[0].get("current_period_end")
    return end if isinstance(end, (int, float)) else None


def reply(sub):
    until = period_end(sub) if isinstance(sub, dict) else None
    if isinstance(sub, dict) and sub.get("cancel_at_period_end") is True and until is not None:
        return {"done": True, "until": until}
    return SUPPORT


def handler(event, context):
    customer_id = None
    try:
        customer_id = json.loads(c.body_of(event) or "{}").get("c")
    except (ValueError, AttributeError):
        pass
    try:
        ok = isinstance(customer_id, str) and len(customer_id) < 64 and CUSTOMER_ID.fullmatch(customer_id)
        sub_id = decision(customer_id, c.find_by_customer(customer_id) if ok else [])
        key = c.stripe_key() if sub_id else None
        if not key:
            return c.resp(200, SUPPORT)
        answer = reply(c.stripe_post(f"/v1/subscriptions/{sub_id}", {"cancel_at_period_end": "true"}, key))
        print(json.dumps({"cancel": customer_id, "done": bool(answer.get("done"))}))
        return c.resp(200, answer)
    except Exception as e:  # every failure looks the same to the page
        print(json.dumps({"cancel": customer_id, "error": str(e)}))
        return c.resp(200, SUPPORT)
