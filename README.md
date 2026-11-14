# Personal Portfolio

Static portfolio site, hosted on GitHub Pages. No build step or dependencies.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The home page markup. Styles are in `index.css`, behaviour in `home.js` |
| `monogram-light.svg`, `monogram-dark.svg` | Standalone outlined Newsreader K. mark, also used in the hero |
| `favicon.svg` | Browser tab icon: the K. mark with the cobalt square |
| `logo-light.svg`, `logo-dark.svg` | Header logo (byline lockup: ANKIT “KIT” AGRAWAL over THE APPLIED AI LETTER), one per theme |
| `logo-compact-light.svg`, `logo-compact-dark.svg` | Header logo below 680 px wide: the name over THE APPLIED AI LETTER scaled to the name's full width, with no rules, so the tagline stays readable on phones |
| `logo-name-light.svg`, `logo-name-dark.svg` | Name-only logo used in the footer |
| `og-image.png`, `apple-touch-icon.png` | Social share card (1200×630) and iOS home-screen icon (180×180); rebuild both with `tools/og-image/build.sh` |
| `tools/og-image/` | `og.html` and `icon.html` are the sources; `build.sh` renders them with headless Chrome |
| `tools/header-logos/` | `build.py` regenerates the six `logo-*.svg` files from `source/logo-light.svg` |
| `404.html` | Custom "page not found" page (shares `base.css` and `pages.css`; every URL is root-absolute because GitHub Pages serves it at any missing path) |
| `book.html` | Consultation booking page (Cal.com popup) |
| `terms.html`, `privacy.html`, `consent.html`, `contact.html` | Legal pages for the letter and consultations: Terms & Conditions, Privacy Policy, Email & Cookie Consent, Contact & Concerns (support@appliedailetter.com). Every page shares one footer (styled in `base.css`) whose Legal column links all four. When one changes materially, update its effective date and email subscribers |
| `unsubscribe.html` | The cancel page (the file keeps its old name so old letter links work): reached only from the Cancel link at the bottom of each letter (`?c=<Stripe customer id>`; not linked from the site, marked `noindex`). One Confirm button posts the id to the `CancelPlan` Lambda, which sets the plan to end at the end of the paid period; letters continue until then |
| `config.js` | **Edit this**: Cal.com link, newsletter subscribe URL and the cancel API URL (`cancelApiUrl`) |
| `base.css` | Styles every page shares: colour tokens, header, buttons, consultation cards, price, rows, footer |
| `index.css`, `pages.css` | Page-specific styles: `index.css` for the home page, `pages.css` for book, the legal pages, unsubscribe and 404 |
| `site.js`, `home.js` | `site.js` is the shared helpers (theme, consultation cards) for every page; `home.js` is the home page's own script |
| `theme-icon.svg` | Theme toggle icon (used as a CSS mask, so it follows the text colour) |
| `SETUP.md` | Step-by-step Cal.com and newsletter setup |
| `newsletter/` | AWS Lambdas for the paid newsletter (us-east-2, `newsletter` profile): `stripe-sync` (the one Stripe webhook; builds rows from the events and uses no Stripe key), `cancel-plan` (the `CancelPlan` Lambda behind `POST /cancel`; holds the one Stripe key, restricted to "Subscriptions: Write"), shared `lib.mjs` and `rules.mjs` (pure, tested with `node --test newsletter/*.test.mjs`), `deploy.sh` to push code changes to both Lambdas, one-off `setup-dynamodb.sh` and `setup-cancel.sh`, `link.sh` to print a test Cancel link, and one-off `cancel-opt-outs.sh` and `cancel-opt-outs.mjs` (dry run by default; `--confirm` schedules period-end cancels in live Stripe for legacy opt-outs who still pay). Not part of the site; see `docs/newsletter-ses/PLAN.md` |
| `robots.txt` | Search engine rules; points to `sitemap.xml` |
| `sitemap.xml` | Indexable pages (home, book, legal). Add a page here when you add one |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Brand system

The shared semantic tokens in `base.css` use Deep Ink, Warm Ivory, Muted Slate, Soft Stone and Cobalt. Dark-mode text accents use a lighter blue for contrast; buttons and monogram punctuation retain Cobalt. Newsreader, Inter and IBM Plex Mono remain the font families. The header uses the full outlined lockup at 680 px and above and the compact lockup below, where the header becomes two rows: logo and theme toggle, then links with the Book and Subscribe pills. Navigation links wrap to a second row below 960 px. The existing system-theme preference and saved toggle choice are preserved.

## Bookings and newsletter

Follow **SETUP.md**. Until `config.js` is filled in, the pages show a "setup needed" notice instead of broken links.

## Before you publish

- Check the full wordmark, K. monogram and theme toggle at desktop and mobile widths.
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
