// One-off: cancel, at period end, the plans of readers who opted out under the old opt-out flag but
// still pay (GLOSSARY: Opt-out). Run through cancel-opt-outs.sh, which sets the AWS profile and region.
// Needs the aws CLI and Node 18+; no node_modules (the AWS SDK is not installed locally).
//
// Scans the subscribers table, picks the rows needsCancel() (rules.mjs) accepts, and prints them.
// With --confirm it also sets cancel_at_period_end in Stripe for each, the same call CancelPlan makes
// (cancelForm and cancelReply from rules.mjs; lib.mjs cannot load without the SDK). It never writes the
// table: StripeSync's webhook records each change, after which the row no longer matches.
import { execFileSync } from "node:child_process";
import { needsCancel, cancelForm, cancelReply, restrictedKey } from "./rules.mjs";

const TABLE = "stripe-sync-subscription-status";
const SECRET_ID = "applied-ai-letter/stripe";
const confirm = process.argv.includes("--confirm");
const aws = (...args) => execFileSync("aws", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// DynamoDB attribute-value JSON -> plain object (only the types the rows use).
const plain = (v) =>
  "S" in v ? v.S : "N" in v ? Number(v.N) : "BOOL" in v ? v.BOOL : "NULL" in v ? null
  : "L" in v ? v.L.map(plain) : "M" in v ? Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, plain(x)])) : undefined;

// The CLI follows the scan's pages itself. The filter only narrows the read; needsCancel decides.
const scan = JSON.parse(aws("dynamodb", "scan", "--table-name", TABLE,
  "--filter-expression", "email_opt_out = :t",
  "--expression-attribute-values", '{":t":{"BOOL":true}}', "--output", "json"));
const picked = (scan.Items ?? []).map(plain).filter(needsCancel);

const date = (unix) => (Number.isFinite(unix) ? new Date(unix * 1000).toISOString().slice(0, 10) : "unknown");
for (const r of picked) console.log(`${r.username}\t${r.email ?? "(no email)"}\tperiod ends ${date(r.current_period_end)}`);
console.log(`${picked.length} plan(s) to cancel at period end.`);

if (!confirm) {
  console.log(picked.length ? "Dry run: nothing changed in Stripe. Run again with --confirm to schedule these cancels." : "Nothing to do.");
  process.exit(0);
}

// A restricted key (rk_) only: restrictedKey() returns null for a full sk_ key, and we stop.
const key = picked.length && restrictedKey(aws("secretsmanager", "get-secret-value", "--secret-id", SECRET_ID,
  "--query", "SecretString", "--output", "text"));
if (picked.length && !key) { console.error(`Secret ${SECRET_ID} holds no rk_ restricted key; refusing.`); process.exit(1); }

let failed = 0;
for (const r of picked) {
  let answer;
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(r.subscription_id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
      body: cancelForm(),
      signal: AbortSignal.timeout(15000),
    });
    answer = cancelReply(await res.json());
  } catch (e) {
    answer = { error: e.message };
  }
  if (answer.done) console.log(`cancelled ${r.username} (${r.subscription_id}), ends ${date(answer.until)}`);
  else { failed++; console.error(`FAILED ${r.username} (${r.subscription_id}): ${answer.error}`); }
}
console.log(`${picked.length - failed} scheduled, ${failed} failed. The webhook updates the table; re-run to confirm nobody is left.`);
process.exit(failed ? 1 : 0);
