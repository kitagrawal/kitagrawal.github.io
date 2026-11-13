"""Dependency-free tests: python3 -I tests/test_local.py  (boto3 not required; AWS calls are faked)."""
import hashlib
import hmac
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
os.environ.update(TABLE_NAME="t", FROM_ADDRESS="n <n@x.com>", NEWSLETTER_PRODUCT_ID="prod_NEWS")
import common as c  # noqa: E402
import stripe_webhook as sw  # noqa: E402
import send_newsletter as sn  # noqa: E402
import cancel as cx  # noqa: E402

_real = {k: getattr(c, k) for k in ("apply_subscription", "find_by_customer", "send_email", "table", "secret", "webhook_secret", "stripe_key")}

SECRET = "whsec_test"


def sign(payload, ts=None, secret=SECRET):
    ts = ts or int(time.time())
    return f"t={ts},v1=" + hmac.new(secret.encode(), f"{ts}.{payload}".encode(), hashlib.sha256).hexdigest()


def test_signature():
    p = '{"a":1}'
    assert c.verify_stripe_signature(p, sign(p), SECRET)
    assert not c.verify_stripe_signature(p, sign(p, secret="other"), SECRET)
    assert not c.verify_stripe_signature(p + " ", sign(p), SECRET)
    assert not c.verify_stripe_signature(p, sign(p, ts=int(time.time()) - 1000), SECRET)
    assert not c.verify_stripe_signature(p, None, SECRET)
    assert not c.verify_stripe_signature(p, "garbage", SECRET)


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        i = self.items.get(Key["email"])
        return {"Item": i} if i else {}


def test_webhook_flow():
    tbl, sent = FakeTable(), []
    c.webhook_secret = lambda: SECRET
    c.table = lambda: tbl
    bodies = []
    c.send_email = lambda to, subj, **kw: (sent.append(to), bodies.append(kw.get("text")))

    def fake_apply(sub, ts):
        email = sub["customer"]["email"]
        old = tbl.items.get(email)
        tbl.items[email] = {"email": email, "status": sub["status"], "stripe_customer_id": "cus_1"}
        return email, True, old

    c.apply_subscription = fake_apply

    def call(status):
        evt = {"type": "customer.subscription.updated", "created": 1,
               "data": {"object": {"id": "sub_1", "status": status, "customer": {"id": "cus_1", "email": "A@x.com"}}}}
        body = json.dumps(evt)
        return sw.handler({"body": body, "headers": {"stripe-signature": sign(body)}}, None)

    assert call("active")["statusCode"] == 200 and sent == ["A@x.com"] or sent == ["a@x.com"]
    assert "unsubscribe.html?c=cus_1" in bodies[0]
    n = len(sent)
    call("active")                       # duplicate -> no second welcome
    assert len(sent) == n
    call("canceled")
    assert not c.is_deliverable(tbl.items["A@x.com"])
    # bad signature rejected
    assert sw.handler({"body": "{}", "headers": {"stripe-signature": "t=1,v1=00"}}, None)["statusCode"] == 400


def test_deliverable_and_auth():
    assert c.is_deliverable({"status": "trialing"})
    assert not c.is_deliverable({"status": "active", "opted_out": True})
    assert not c.is_deliverable({"status": "active", "suppressed": True})
    assert c.is_deliverable({"status": "past_due"})  # letters continue while Stripe retries the card
    assert not c.is_deliverable({"status": "unpaid"})
    c.secret = lambda name: "adminkey"
    r = sn.handler({"headers": {"x-api-key": "nope"}, "body": "{}"}, None)
    assert r["statusCode"] == 401


def sub(product="prod_NEWS", status="active", cancel=False):
    return {"id": "sub_1", "status": status, "cancel_at_period_end": cancel, "current_period_end": 1800000000,
            "customer": {"id": "cus_1", "email": "A@x.com"},
            "items": {"data": [{"price": {"id": "price_1", "product": product}}]}}


def test_product_filter():
    c.apply_subscription = _real["apply_subscription"]
    writes = []
    c.upsert_subscriber = lambda email, fields, ts: (writes.append((email, fields)), (True, None))[1]
    c.drop_stale_emails = lambda *a: None
    assert c.apply_subscription(sub(product="prod_OTHER"), 1) == (None, False, None)
    assert writes == []
    email, applied, _ = c.apply_subscription(sub(product={"id": "prod_NEWS"}), 1)
    assert email == "a@x.com" and applied and writes[0][1]["price_id"] == "price_1"
    old = c.PRODUCT_ID
    c.PRODUCT_ID = ""
    assert not c.is_newsletter(sub())  # unset product id: nothing matches
    c.PRODUCT_ID = old


def test_secret_fields():
    real = c._stripe_secret
    c.webhook_secret, c.stripe_key = _real["webhook_secret"], _real["stripe_key"]
    c._stripe_secret = lambda: json.dumps({"STRIPE_SECRET_KEY": "pk_live_x", "STRIPE_WEBHOOK_SECRET": "whsec_y"})
    assert c.stripe_key() is None          # a publishable key is never used
    assert c.webhook_secret() == "whsec_y"
    c._stripe_secret = lambda: json.dumps({"STRIPE_SECRET_KEY": "rk_live_z", "STRIPE_WEBHOOK_SECRET": "nope"})
    assert c.stripe_key() == "rk_live_z" and c.webhook_secret() is None
    c._stripe_secret = real


def test_restricted_key():
    assert c.restricted_key("rk_live_abc") == "rk_live_abc"
    assert c.restricted_key('{"key": " rk_test_x1 "}') == "rk_test_x1"
    assert c.restricted_key("sk_live_abc") is None
    assert c.restricted_key('{"k": "sk_live_abc"}') is None
    assert c.restricted_key("") is None


def test_no_list_unsubscribe_headers():
    calls = []

    class SES:
        def send_email(self, **kw):
            calls.append(kw)

    c.send_email = _real["send_email"]
    old = c._client
    c._client = lambda name: SES()
    c.send_email("a@x.com", "S", html="<p>h</p>", text="t")
    c._client = old
    assert "Headers" not in calls[0]["Content"]["Simple"]


def test_cancel_decision_and_reply():
    live = {"subscription_id": "sub_1", "status": "active"}
    assert cx.decision("cus_1", [live]) == "sub_1"
    assert cx.decision("cus_1", [{**live, "status": "past_due"}]) == "sub_1"
    assert cx.decision("cus_1", [{**live, "cancel_at_period_end": True}]) is None
    assert cx.decision("cus_1", [{**live, "status": "canceled"}]) is None
    assert cx.decision("cus_1", []) is None
    assert cx.decision("evil", [live]) is None
    assert cx.reply({"cancel_at_period_end": True, "current_period_end": 5}) == {"done": True, "until": 5}
    assert cx.reply({"cancel_at_period_end": True, "items": {"data": [{"current_period_end": 6}]}}) == {"done": True, "until": 6}
    assert cx.reply({"error": {"message": "x"}}) == {"error": "support"}
    assert cx.reply(None) == {"error": "support"}


def test_cancel_handler():
    posted = []
    c.find_by_customer = lambda cid: [{"subscription_id": "sub_9", "status": "active"}] if cid == "cus_1" else []
    c.stripe_key = lambda: "rk_live_k"
    c.stripe_post = lambda path, form, key: (posted.append((path, form, key)), {"cancel_at_period_end": True, "current_period_end": 7})[1]
    call = lambda body: json.loads(cx.handler({"body": json.dumps(body)}, None)["body"])
    assert call({"c": "cus_1"}) == {"done": True, "until": 7}
    assert posted == [("/v1/subscriptions/sub_9", {"cancel_at_period_end": "true"}, "rk_live_k")]
    assert call({"c": "cus_2"}) == {"error": "support"}
    assert call({"c": "x" * 80}) == {"error": "support"}
    assert cx.handler({"body": "not json"}, None)["statusCode"] == 200
    def boom(*a):
        raise RuntimeError("stripe down")
    c.stripe_post = boom
    assert call({"c": "cus_1"}) == {"error": "support"}
    assert len(posted) == 1
    c.stripe_key = lambda: None  # no rk_ key in the secret
    assert call({"c": "cus_1"}) == {"error": "support"}


def test_send_personalises_cancel_link():
    rows = [{"email": "a@x.com", "status": "active", "stripe_customer_id": "cus_A"},
            {"email": "b@x.com", "status": "canceled", "stripe_customer_id": "cus_B"},
            {"email": "c@x.com", "status": "active"}]

    class T:
        def scan(self, **kw):
            return {"Items": rows}

    c.table = lambda: T()
    out = []
    c.send_email = lambda to, subj, html=None, text=None: out.append((to, html, text))

    class Ctx:
        def get_remaining_time_in_millis(self):
            return 60000

    os.environ["SEND_RATE"] = "1000"
    job = {"subject": "S", "html": "<a href='{{cancel_url}}'>x</a>", "text": "Unsubscribe: {{cancel_url}}", "test_to": ""}
    assert sn.run_job(job, Ctx()) == {"sent": 1, "failed": 0}
    assert out == [("a@x.com", "<a href='https://kitagrawal.github.io/unsubscribe.html?c=cus_A'>x</a>",
                    "Unsubscribe: https://kitagrawal.github.io/unsubscribe.html?c=cus_A")]
    out.clear()
    sn.run_job({**job, "test_to": "p@x.com"}, Ctx())
    assert out[0][0] == "p@x.com" and "c=cus_PROOF" in out[0][2]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
