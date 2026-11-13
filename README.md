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
| `unsubscribe.html` | The unsubscribe page: reached only from the Unsubscribe link at the bottom of each letter (`?c=<Stripe customer id>`; not linked from the site, marked `noindex`). One Confirm button posts the id to `POST /cancel` on the newsletter stack, which sets the plan to end at the end of the paid period; letters continue until then |
| `config.js` | **Edit this**: Cal.com link, newsletter subscribe URL and the unsubscribe API URL (`cancelApiUrl`) |
| `base.css` | Styles every page shares: colour tokens, header, buttons, consultation cards, price, rows, footer |
| `index.css`, `pages.css` | Page-specific styles: `index.css` for the home page, `pages.css` for book, the legal pages, unsubscribe and 404 |
| `site.js`, `home.js` | `site.js` is the shared helpers (theme, consultation cards) for every page; `home.js` is the home page's own script |
| `theme-icon.svg` | Theme toggle icon (used as a CSS mask, so it follows the text colour) |
| `SETUP.md` | Step-by-step Cal.com and newsletter setup |
| `newsletter/` | The paid newsletter's backend, not part of the site. `api/` is the AWS SAM stack `newsletter` (Python, us-east-2, profile `newsletter`): Stripe webhook → DynamoDB, daily reconcile, `POST /send`, `POST /cancel`, SES bounce suppression; see `newsletter/api/README.md`. `letter.mjs` (with vendored `marked`) renders a Markdown letter into the branded email, and `publish.mjs` sends it through `/send` (`--preview`, `--dry-run`, `--proof`, `--all`). Tests: `python3 -I newsletter/api/tests/test_local.py` and `node --test newsletter/*.test.mjs` |
| `robots.txt` | Search engine rules |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Bookings and newsletter

Follow **SETUP.md**. Until `config.js` is filled in, the pages show a "setup needed" notice instead of broken links.

## Before you publish

- Add `photo.jpg` next to `index.html` (the "AA" initials show until it exists).
- Fill the `REPLACE` placeholders in `config.js` (see `SETUP.md`).

## Newsletter backend

Deploy, secrets, Stripe webhook and sending a letter: `newsletter/api/README.md`.

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
