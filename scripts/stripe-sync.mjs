// Daily newsletter sync: reads subscriptions on the newsletter price from Stripe
// and posts each subscriber's status to the Apps Script that owns the Sheet.
// Run by .github/workflows/stripe-sync.yml. Node 20+, no dependencies.
//
// Env: STRIPE_KEY (restricted, read-only rk_ key), SHEET_SYNC_TOKEN,
//      NEWSLETTER_PRICE_ID. The Apps Script URL is read from config.js.
//
// The repo is public, so Actions logs are public: log counts only, never emails.

import { readFileSync } from 'node:fs';

const { STRIPE_KEY, SHEET_SYNC_TOKEN, NEWSLETTER_PRICE_ID } = process.env;
const missing = Object.entries({ STRIPE_KEY, SHEET_SYNC_TOKEN, NEWSLETTER_PRICE_ID })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) fail(`Missing ${missing.join(', ')}. See SETUP.md, section 4.`);
if (STRIPE_KEY.startsWith('sk_')) fail('Use a restricted read-only key (rk_...), not a full secret key.');

const config = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const endpoint = (config.match(/signupEndpoint:\s*"([^"]+)"/) || [])[1];
if (!endpoint || !endpoint.startsWith('https://') || endpoint.includes('REPLACE')) {
  fail('signupEndpoint in config.js is not set.');
}

// When one email has several subscriptions, the best status wins.
const RANK = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled'];
const better = (a, b) => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);

const statusByEmail = new Map();
let after = '';
let count = 0;
do {
  const q = new URLSearchParams({ price: NEWSLETTER_PRICE_ID, status: 'all', limit: '100', 'expand[]': 'data.customer' });
  if (after) q.set('starting_after', after);
  const res = await fetch(`https://api.stripe.com/v1/subscriptions?${q}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  const body = await res.json();
  if (!res.ok) fail(`Stripe ${res.status}: ${body.error?.message || 'request failed'}`);

  for (const sub of body.data) {
    count++;
    const email = String(sub.customer?.email || '').trim().toLowerCase();
    if (!email) continue;
    const prev = statusByEmail.get(email);
    statusByEmail.set(email, prev ? better(prev, sub.status) : sub.status);
  }
  after = body.has_more ? body.data.at(-1).id : '';
} while (after);

const subscribers = [...statusByEmail].map(([email, status]) => ({ email, status }));

// text/plain matches the site's requests; fetch follows Apps Script's redirect.
const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ action: 'stripe_sync', token: SHEET_SYNC_TOKEN, subscribers }),
});
let result;
try { result = await res.json(); } catch { fail(`Sheet returned HTTP ${res.status} with a non-JSON body. Is the deployment URL current?`); }
if (!result.ok) fail(`Sheet rejected the sync: ${result.error}`);

console.log(`Stripe subscriptions: ${count}. Emails: ${subscribers.length}. ` +
  `Rows updated: ${result.updated}. Not in Sheet: ${result.notFound}.`);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
