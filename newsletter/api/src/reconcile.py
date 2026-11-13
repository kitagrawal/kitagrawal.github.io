"""Scheduled safety net: pull every subscription from Stripe and re-apply it.

Webhooks can be missed (outage, misconfig). This heals drift daily and is also
how you backfill existing subscribers on first deploy: invoke it once manually.
"""
import time

import common as c


def handler(event, context):
    started = int(time.time())
    seen = 0
    params = {"status": "all", "limit": 100, "expand[]": ["data.customer"]}
    while True:
        page = c.stripe_get("/v1/subscriptions", params)
        for sub in page["data"]:
            c.apply_subscription(sub, started)
            seen += 1
        if not page.get("has_more"):
            break
        params["starting_after"] = page["data"][-1]["id"]
    print(f"reconciled {seen} subscriptions")
    return {"reconciled": seen}
