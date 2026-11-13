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

**Cancel**:
The reader ends their plan at the end of the period they have paid for. Letters continue until then, and nothing renews. The only way a reader leaves.
_Avoid_: Unsubscribe, opt out, stop letters

**Cancel link**:
The link at the bottom of every letter that opens the cancel page for that reader.
_Avoid_: Unsubscribe link

**Paid period**:
The stretch of time the reader's last payment covers; a cancelled plan ends when it ends.
_Avoid_: Billing cycle, term

**Opt-out** (legacy):
An older state where a reader stopped letters but kept paying. No longer possible; existing ones are cancelled at period end.
_Avoid_: Using it for new behaviour

**Draft**:
A letter the author has uploaded for checking, not for sending. A draft goes only to the author, as a proof.
_Avoid_: Preview, test send

**Proof**:
The one email a draft produces, sent only to the author, to check how the letter looks before it goes to readers.
_Avoid_: Test letter

**Reader email**:
An email to a single reader about their own plan: the welcome when the plan first goes live, the note when a cancel is scheduled, and the goodbye when the plan ends. Each is sent at most once.
_Avoid_: Lifecycle email, notification, transactional email
