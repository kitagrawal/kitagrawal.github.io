# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Static personal site for Ankit Agrawal, served by GitHub Pages from the `main` branch root. There is no build step, package manager, linter or test suite: the files in the repo are the deployed site, and pushing to `main` publishes it. Preview locally with `python3 -m http.server` from the repo root.

`README.md` holds the file map and deploy steps; `SETUP.md` holds the Cal.com, newsletter and Formspree setup. Keep both current when you change what a file does or how a service is wired.

## Styles and scripts

- `base.css` holds everything the pages share: colour tokens (and the dark-mode token pattern), reset, header, buttons, consultation cards (`.offer`), `.price`, `.rows` and the footer. Change a shared component there, once.
- `index.css` is for the home page only; `pages.css` is for `book.html`, `topics.html`, `unsubscribe.html` and `404.html` (including the form styles). Each page loads `base.css` first, then its own file. `404.html` links everything root-absolute (`/base.css`), because GitHub Pages serves it at any missing path.
- `site.js` (every page: theme toggle, year, Subscribe links, Cal.com popup, and `window.Site` with `cfg` and `renderOffers`) and `config.js` load on every page. `home.js` is the home page's script; the other pages keep a short inline script.
- The layout follows the Figma kit (concept 05 · Teal, Refined; see the `kitagrawal-figma` skill). Theme choice is stored in `localStorage` key `theme` by `site.js`.

## Configuration: `config.js`

Every page loads `config.js` (sets `window.SITE_CONFIG`) and then `site.js`. All links and prices live in `config.js`; `Site.renderOffers` draws the consultation cards (the first is featured) on `index.html` and `book.html`, and the pages fill the newsletter price and perks from it.

A value counts as configured only when it is non-empty and has no `REPLACE` in it. Unset values grey out or replace the action with "Coming soon", so leave placeholders containing `REPLACE` rather than empty strings or fake URLs. Values here are public by design.

## Booking and subscribe flow

There is no server. The only form is the topic-request form on `topics.html`.

- **Book**: `[data-cal-book]` elements (the home-page button; the "Pick a time" button `renderOffers` draws on `book.html`) open a Cal.com popup. `site.js` sets the `data-cal-*` attributes from `cfg.cal` and loads Cal.com's embed script once. Payment, if wanted, is set up inside Cal.com.
- **Subscribe**: `[data-subscribe]` elements get `href` from `cfg.newsletter.subscribeUrl` (the Buttondown subscribe page; Buttondown runs Stripe checkout). `site.js` greys them out until it is set.
- Subscribers and sending live in Buttondown, billing in Stripe. No Stripe or Google Sheets code lives in this repo.
- **Topic requests**: `topics.html` draws checkboxes from `cfg.topics.list` and POSTs to `cfg.topics.formEndpoint` (Formspree) with `Accept: application/json`, so it can read success or failure. It sends one `topics` field joined with ` | `, plus `suggestion`, optional `email` and Formspree's `_gotcha` honeypot. `scripts/rank-topics.mjs` reads Formspree's CSV export and relies on those field names and that separator; change them together. Export CSVs hold emails and must not be committed.

## Placeholders and gaps

- `photo.jpg` is not committed; `index.html` removes the `<img>` via `onerror` when it is missing.
