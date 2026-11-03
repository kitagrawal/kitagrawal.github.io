# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Static personal site for Ankit Agrawal, served by GitHub Pages from the `main` branch root. There is no build step, package manager, linter or test suite: the files in the repo are the deployed site, and pushing to `main` publishes it. Preview locally with `python3 -m http.server` from the repo root.

`README.md` holds the file map and deploy steps; `SETUP.md` holds the Stripe, scheduler and Google Sheet setup. Keep both current when you change what a file does or how a service is wired.

## Styles and scripts

- `base.css` holds everything the pages share: colour tokens (and the dark-mode token pattern), reset, header, buttons, consultation cards (`.offer`), `.price`, `.rows` and the footer. Change a shared component there, once.
- `index.css` is for the home page only; `pages.css` is for `book.html`, `subscribe.html`, `thanks.html` and `404.html`. Each page loads `base.css` first, then its own file. `404.html` links everything root-absolute (`/base.css`), because GitHub Pages serves it at any missing path.
- `site.js` (every page: theme toggle, year, and the `window.Site` helpers `cfg`, `isSet`, `el`, `embed`, `renderOffers`) and `config.js` load on every page. `home.js` is the home page's script; the other pages keep a short inline script.
- The layout follows the Figma kit (concept 05 · Teal, Refined; see the `kitagrawal-figma` skill). Theme choice is stored in `localStorage` key `theme` by `site.js`.

## Configuration: `config.js`

Every page that sells or signs up loads `config.js` (sets `window.SITE_CONFIG`) and then `site.js`. All links and prices live in `config.js`; `Site.renderOffers` draws the consultation cards (the first is featured) on `index.html` and `book.html`, and the pages fill the newsletter price and perks from it.

A value counts as configured only when `Site.isSet()` accepts it: an `https://` URL without `REPLACE` in it. Unset values make the pages show a "Setup needed" notice and disable the action, so leave placeholders containing `REPLACE` rather than empty strings or fake URLs. Values here are public by design (Stripe Payment Links, Apps Script URL); a Stripe secret key (`sk_...`) never belongs in the repo.

## Payment and sign-up flows

There is no server. Three outside services do the work, joined by redirects:

- **Consultations** (`book.html`): "Pay & book" links to the Stripe Payment Link with `client_reference_id` set to the consultation `id`. Stripe redirects to `thanks.html?type=consult`, which embeds `schedulerUrl` in an iframe. A consultation with no `stripeLink` opens the scheduler directly instead (the Cal.com-collects-payment path).
- **Newsletter** (`subscribe.html`): paid-only, so the form stays disabled without `newsletter.stripeLink`. On submit it POSTs the email to `signupEndpoint`, saves it to `sessionStorage` key `subEmail`, and redirects to Stripe with `prefilled_email`. Stripe redirects to `thanks.html?type=newsletter`, which reads `subEmail` and POSTs `action: "returned_from_checkout"`.
- **Sheet** (`apps-script/Code.gs`): a Google Apps Script web app, deployed by hand from the Sheet (it does not run from this repo). It dedupes by lowercased email, sets the Status column, and prefixes cells starting with `= + - @` to block formula injection. After editing it, the owner must publish a new deployment version or the live URL keeps the old code.

Requests to Apps Script use `mode: 'no-cors'` with `Content-Type: text/plain` to skip the CORS preflight. The response is opaque, so the page cannot read success or failure; keep that pattern rather than switching to JSON headers.

Status `returned_from_checkout` is not proof of payment. Stripe is the source of truth. A daily GitHub Action (`.github/workflows/stripe-sync.yml` runs `scripts/stripe-sync.mjs`) lists subscriptions on the `NEWSLETTER_PRICE_ID` repo variable with a restricted read-only key (`STRIPE_KEY` secret). It POSTs `action: "stripe_sync"` and `SHEET_SYNC_TOKEN` to `signupEndpoint`, which it reads from `config.js`. `Code.gs` checks the token against Script Property `SYNC_TOKEN` and sets Status to the Stripe status, only on rows already in the Sheet. It writes only the Status and Last updated cells, because rewriting other cells would drop the formula-injection `'` prefix. The repo is public, so Actions logs are public: the script logs counts, never emails.

Checkout stays on Stripe-hosted Payment Links (a redirect). An embedded or modal checkout would need a per-request server to create Checkout Sessions, and GitHub Pages and Actions can't provide one.

## Placeholders and gaps

- `photo.jpg` is not committed; `index.html` removes the `<img>` via `onerror` when it is missing.
