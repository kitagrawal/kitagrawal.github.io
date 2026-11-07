#!/usr/bin/env node
// Rank topic requests from a Formspree CSV export (topics.html -> Formspree).
//
//   node scripts/rank-topics.mjs submissions.csv
//
// Counts one vote per topic per request. Requests that share an email count once,
// using the latest one, so one person cannot stack votes. Free-text suggestions are
// grouped after lowercasing and treating punctuation as spaces, and ranked the same way.
// No dependencies. The CSV stays on your machine; do not commit it (it holds emails).

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/rank-topics.mjs <formspree-export.csv>');
  process.exit(1);
}

// RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const [header, ...data] = parseCsv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
if (!header) { console.error('The CSV is empty.'); process.exit(1); }
const col = re => header.findIndex(h => re.test(h.trim()));
const iTopics = col(/^topics$/i);
const iSuggestion = col(/^suggestion$/i);
const iEmail = col(/^e-?mail$/i);
const iDate = col(/date|created|submitted|time/i);
if (iTopics < 0 && iSuggestion < 0) {
  console.error('No "topics" or "suggestion" column found. Columns: ' + header.join(', '));
  process.exit(1);
}

// Oldest first, so a later request from the same email replaces an earlier one.
const time = r => (iDate >= 0 ? Date.parse(r[iDate]) : NaN);
const ordered = iDate >= 0 ? [...data].sort((a, b) => (time(a) || 0) - (time(b) || 0)) : data;
const byPerson = new Map();
ordered.forEach((r, n) => {
  const email = iEmail >= 0 ? String(r[iEmail] || '').trim().toLowerCase() : '';
  byPerson.set(email || `anonymous-${n}`, r);
});
const requests = [...byPerson.values()];

const votes = new Map();
const suggestions = new Map();   // normalised text -> { text, count }
for (const r of requests) {
  const topics = iTopics >= 0 ? String(r[iTopics] || '').split(' | ').map(s => s.trim()).filter(Boolean) : [];
  new Set(topics).forEach(t => votes.set(t, (votes.get(t) || 0) + 1));
  const s = iSuggestion >= 0 ? String(r[iSuggestion] || '').replace(/\s+/g, ' ').trim() : '';
  if (s) {
    const key = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const entry = suggestions.get(key) || { text: s, count: 0 };
    entry.count++;
    suggestions.set(key, entry);
  }
}

const pct = n => (requests.length ? Math.round((100 * n) / requests.length) : 0);
const table = (title, list) => {
  console.log(`\n${title}`);
  if (!list.length) return console.log('  (none)');
  list.forEach(([label, n], i) => console.log(`  ${String(i + 1).padStart(2)}. ${String(n).padStart(4)}  ${String(pct(n)).padStart(3)}%  ${label}`));
};

const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const ideas = [...suggestions.values()].map(s => [s.text, s.count]).sort((a, b) => b[1] - a[1]);

console.log(`Requests: ${data.length} rows, ${requests.length} after counting each email once.`);
table('Topic votes (share of requests)', ranked);
table('Suggested topics', ideas);
if (ranked.length) {
  const top = ranked.filter(([, n]) => n === ranked[0][1]).map(([t]) => t);
  console.log(`\nMost requested: ${top.join(' / ')} (${ranked[0][1]} votes${top.length > 1 ? ', tied' : ''})`);
}
