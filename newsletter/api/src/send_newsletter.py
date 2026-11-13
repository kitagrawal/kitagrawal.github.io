"""POST /send - send an issue to all active subscribers.

Auth:  header  x-api-key: <value of SSM /newsletter/admin-api-key>
Body:  {"subject": "...", "html": "...", "text": "...",
        "dry_run": true,            # count recipients, send nothing
        "test_to": "me@x.com"}      # send to one address only (a Proof)
{{cancel_url}} in html/text becomes each reader's Unsubscribe link (unsubscribe.html?c=<customer id>).
The HTTP request returns 202 immediately; this same function is re-invoked
asynchronously to do the (slow) sending, because HTTP API requests cap at 30s.
"""
import hmac
import json
import os
import time

import common as c


def handler(event, context):
    if "job" in event:                      # async worker invocation
        return run_job(event["job"], context)

    key = (event.get("headers") or {}).get("x-api-key", "")
    if not hmac.compare_digest(key, c.secret("admin-api-key")):
        return c.resp(401, {"error": "unauthorized"})

    try:
        req = json.loads(c.body_of(event) or "{}")
    except json.JSONDecodeError:
        return c.resp(400, {"error": "invalid JSON"})
    if not req.get("subject") or not (req.get("html") or req.get("text")):
        return c.resp(400, {"error": "subject and html/text required"})

    job = {
        "subject": req["subject"],
        "html": req.get("html"),
        "text": req.get("text"),
        "test_to": c.norm_email(req.get("test_to")),
    }
    if req.get("dry_run"):
        n = len(list(recipients(job)))
        return c.resp(200, {"dry_run": True, "recipients": n})

    c._client("lambda").invoke(
        FunctionName=context.function_name, InvocationType="Event", Payload=json.dumps({"job": job})
    )
    return c.resp(202, {"queued": True})


def recipients(job):
    if job.get("test_to"):
        yield {"email": job["test_to"], "stripe_customer_id": "cus_PROOF"}
        return
    kwargs = {}
    while True:
        page = c.table().scan(**kwargs)
        for item in page["Items"]:
            if c.is_deliverable(item) and item.get("stripe_customer_id"):
                yield item
        if "LastEvaluatedKey" not in page:
            return
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def personal(body, link, html=False):
    if not body:
        return body
    return body.replace("{{cancel_url}}", link.replace("&", "&amp;") if html else link)


def run_job(job, context):
    delay = 1.0 / float(os.environ.get("SEND_RATE", "10"))
    sent = failed = 0
    for item in recipients(job):
        email = item["email"]
        if context.get_remaining_time_in_millis() < 15000:
            print(f"out of time; stopped after {sent} sent - rerun is NOT idempotent, check logs")
            break
        try:
            link = c.cancel_url(item["stripe_customer_id"])
            c.send_email(email, job["subject"], personal(job.get("html"), link, html=True), personal(job.get("text"), link))
            sent += 1
        except Exception as e:
            failed += 1
            print(f"send failed for {email}: {e}")
        time.sleep(delay)
    print(f"done: sent={sent} failed={failed}")
    return {"sent": sent, "failed": failed}
