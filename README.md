# Personal Portfolio

Static portfolio site, hosted on GitHub Pages. No build step or dependencies.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The home page markup. Styles are in `index.css`, behaviour in `home.js` |
| `photo.jpg` | **You add this**: your portrait (about 1200x1500 px, under 300 KB) |
| `favicon.svg` | Browser tab icon (edit the initials) |
| `404.html` | Custom "page not found" page (shares `base.css` and `pages.css`; every URL is root-absolute because GitHub Pages serves it at any missing path) |
| `book.html` | Consultation booking page (Cal.com popup) |
| `terms.html`, `privacy.html`, `consent.html`, `contact.html` | Legal pages for the letter and consultations: Terms & Conditions, Privacy Policy, Email & Cookie Consent, Contact & Concerns (support@appliedailetter.com). Each footer links all four; other pages link Terms, Privacy and Contact. When one changes materially, update its effective date and email subscribers |
| `unsubscribe.html` | The cancel page (the file keeps its old name so old letter links work): reached only from the Cancel link at the bottom of each letter (`?c=<Stripe customer id>`; not linked from the site, marked `noindex`). One Confirm button posts the id to the `CancelPlan` Lambda, which sets the plan to end at the end of the paid period; letters continue until then |
| `config.js` | **Edit this**: Cal.com link, newsletter subscribe URL and the cancel API URL (`cancelApiUrl`) |
| `base.css` | Styles every page shares: colour tokens, header, buttons, consultation cards, price, rows, footer |
| `index.css`, `pages.css` | Page-specific styles: `index.css` for the home page, `pages.css` for book, the legal pages, unsubscribe and 404 |
| `site.js`, `home.js` | `site.js` is the shared helpers (theme, consultation cards) for every page; `home.js` is the home page's own script |
| `theme-icon.svg` | Theme toggle icon (used as a CSS mask, so it follows the text colour) |
| `SETUP.md` | Step-by-step Cal.com and newsletter setup |
| `newsletter/` | AWS Lambdas for the paid newsletter (us-east-2, `newsletter` profile): `stripe-sync` (the one Stripe webhook; builds rows from the events and uses no Stripe key), `cancel-plan` (the `CancelPlan` Lambda behind `POST /cancel`; holds the one Stripe key, restricted to "Subscriptions: Write"), shared `lib.mjs` and `rules.mjs` (pure, tested with `node --test newsletter/*.test.mjs`), `deploy.sh` to push code changes to both Lambdas, one-off `setup-dynamodb.sh` and `setup-cancel.sh`, `link.sh` to print a test Cancel link, and one-off `cancel-opt-outs.sh` and `cancel-opt-outs.mjs` (dry run by default; `--confirm` schedules period-end cancels in live Stripe for legacy opt-outs who still pay). Not part of the site; see `docs/newsletter-ses/PLAN.md` |
| `robots.txt` | Search engine rules |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Bookings and newsletter

Follow **SETUP.md**. Until `config.js` is filled in, the pages show a "setup needed" notice instead of broken links.

## Before you publish

- Add `photo.jpg` next to `index.html` (the "AA" initials show until it exists).
- Fill the `REPLACE` placeholders in `config.js` (see `SETUP.md`).

## Going live with Cancel (owner steps)

These change live AWS and Stripe, so you run them; nothing here runs from the site. Terms are in `GLOSSARY.md`; the reasons are in `docs/adr/` and `docs/newsletter-ses/PLAN.md`.

1. In Stripe, edit the restricted key stored in Secrets Manager (`applied-ai-letter/stripe`) so its only permission is **Subscriptions: Write** (it had **Customer portal: Write**).
2. `newsletter/setup-cancel.sh`: creates `CancelPlan`, its `POST /cancel` route and throttle, and CORS; removes the old `/unsubscribe` routes. It prints the API URL.
3. `newsletter/deploy.sh`: runs the tests, then pushes `StripeSync` and `CancelPlan`.
4. Put the printed URL in `cancelApiUrl` in `config.js`, then push the site to `main`. Until then the cancel page tells readers to email support.
5. `newsletter/cancel-opt-outs.sh` (dry run, lists who would be cancelled), then `newsletter/cancel-opt-outs.sh --confirm` to schedule the period-end cancel for legacy opt-outs who still pay.
6. Once the new page works, delete the old `UnsubscribeUser` Lambda (and its role, and the `/newsletter/unsubscribe-hmac-key` SSM parameter, which nothing reads any more).

## Deploy to GitHub Pages

1. Create a public repo named `<your-username>.github.io`.
2. Upload or push all files in this folder to the `main` branch root.
3. Go to **Settings -> Pages**, set Source to **Deploy from a branch**, Branch **main**, folder **/ (root)**, then Save.
4. Wait 1-2 minutes. Your site is live at `https://<your-username>.github.io`.

### Using git

```bash
git init
git add .
git commit -m "Initial portfolio site"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-username>.github.io.git
git push -u origin main
```

### Custom domain (optional)

Add a file named `CNAME` containing your domain (for example `yourname.com`), then configure DNS as described in GitHub's Pages docs and set the domain under Settings -> Pages.
