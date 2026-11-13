# The Applied AI Letter

A paid newsletter. Every reader pays for a plan in Stripe, and getting letters and paying for them are the same thing.

## Language

**Reader**:
A person with a paid newsletter plan, known by their Stripe customer id.
_Avoid_: Subscriber, user, member

**Plan**:
The reader's recurring Stripe subscription to the newsletter. A reader gets letters exactly while their plan is live.
_Avoid_: Subscription (in reader-facing copy), membership

**Letter**:
One issue of the newsletter, emailed to every reader whose plan is live.
_Avoid_: Issue, email, newsletter (for a single send)

**Unsubscribe**:
The reader ends their paid plan at the end of the period they have paid for. Letters continue until then, and nothing renews. The only way a reader leaves. In code and Stripe it is still called cancel (`/cancel`, `cancel_at_period_end`).
_Avoid_: Cancel (in reader-facing text), opt out, stop letters

**Unsubscribe link**:
The link at the bottom of every letter that opens the unsubscribe page for that reader (`{{cancel_url}}` in code).
_Avoid_: Cancel link

**Paid period**:
The stretch of time the reader's last payment covers; an unsubscribed reader's plan ends when it ends.
_Avoid_: Billing cycle, term

**Opt-out** (legacy):
An older state where a reader stopped letters but kept paying. No longer possible; existing ones are unsubscribed at period end.
_Avoid_: Using it for new behaviour
