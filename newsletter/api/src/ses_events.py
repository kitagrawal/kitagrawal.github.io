"""SNS -> Lambda: suppress addresses that hard-bounce or file a complaint (protects SES reputation)."""
import json

import common as c


def handler(event, context):
    from botocore.exceptions import ClientError

    for record in event["Records"]:
        msg = json.loads(record["Sns"]["Message"])
        kind = msg.get("eventType") or msg.get("notificationType")
        if kind == "Bounce":
            if msg["bounce"].get("bounceType") != "Permanent":
                continue
            emails = [r["emailAddress"] for r in msg["bounce"]["bouncedRecipients"]]
        elif kind == "Complaint":
            emails = [r["emailAddress"] for r in msg["complaint"]["complainedRecipients"]]
        else:
            continue
        for email in emails:
            try:
                c.table().update_item(
                    Key={"email": c.norm_email(email)},
                    UpdateExpression="SET suppressed = :t, suppress_reason = :r, updated_at = :now",
                    ConditionExpression="attribute_exists(email)",
                    ExpressionAttributeValues={":t": True, ":r": kind.lower(), ":now": c.now_iso()},
                )
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    raise
    return {"ok": True}
