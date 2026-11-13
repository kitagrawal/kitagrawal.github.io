#!/usr/bin/env node
// Send a Markdown letter through the newsletter stack's POST /send (newsletter/api).
//
//   node newsletter/publish.mjs <letter.md> --dry-run   count the readers it would go to; sends nothing
//   node newsletter/publish.mjs <letter.md> --proof     send a Proof to PROOF_TO (default support@appliedailetter.com)
//   node newsletter/publish.mjs <letter.md> --all       send to every reader (asks you to type "send")
//   node newsletter/publish.mjs <letter.md> --preview   only write <letter>.html next to the file (no AWS);
//                                                       add it to another mode to do both
//
// The letter starts with front matter `subject: ...`. The footer's Unsubscribe link is left as {{cancel_url}};
// the send Lambda fills in each reader's own link. Uses AWS profile "newsletter" (us-east-2): the API URL
// from the CloudFormation stack STACK (default "newsletter"), the admin key from SSM /newsletter/admin-api-key.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseLetter, renderLetter } from "./letter.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const mode = ["--dry-run", "--proof", "--all"].filter((m) => args.includes(m));
const previewOnly = args.includes("--preview") && mode.length === 0;
if (!file || (mode.length !== 1 && !previewOnly)) {
  console.error("usage: node newsletter/publish.mjs <letter.md> --dry-run|--proof|--all [--preview]");
  process.exit(2);
}
const PROOF_TO = process.env.PROOF_TO || "support@appliedailetter.com";
const STACK = process.env.STACK || "newsletter";

const { subject, body } = parseLetter(readFileSync(file, "utf8"));
const letter = renderLetter({ subject, body, cancelUrl: "{{cancel_url}}" });
if (args.includes("--preview")) {
  const out = file.replace(/\.md$/, "") + ".html";
  writeFileSync(out, letter.html.replaceAll("{{cancel_url}}", "https://kitagrawal.github.io/unsubscribe.html?c=cus_PROOF"));
  console.log(`preview: ${out}`);
}
if (previewOnly) process.exit(0);

const aws = (...a) =>
  execFileSync("aws", [...a, "--output", "text"], {
    encoding: "utf8",
    env: { ...process.env, AWS_PROFILE: "newsletter", AWS_REGION: "us-east-2" },
  }).trim();
const api = aws("cloudformation", "describe-stacks", "--stack-name", STACK, "--query", "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue");
const key = aws("ssm", "get-parameter", "--name", "/newsletter/admin-api-key", "--with-decryption", "--query", "Parameter.Value");

const payload = { subject: letter.subject, html: letter.html, text: letter.text };
if (mode[0] === "--dry-run") payload.dry_run = true;
if (mode[0] === "--proof") payload.test_to = PROOF_TO;
if (mode[0] === "--all") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await rl.question(`Send "${letter.subject}" to every reader? Type send: `)).trim() === "send";
  rl.close();
  if (!ok) process.exit(1);
}

const res = await fetch(`${api}/send`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key },
  body: JSON.stringify(payload),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
if (mode[0] !== "--dry-run") console.log("Sending in the background: watch the SendFunction logs (stack output SendFunctionName) for `done: sent=`.");
