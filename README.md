# Personal Portfolio

Static portfolio site, hosted on GitHub Pages. No build step or dependencies.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole site (HTML, CSS and JS in one file) |
| `photo.jpg` | **You add this**: your portrait (about 1200x1500 px, under 300 KB) |
| `favicon.svg` | Browser tab icon (edit the initials) |
| `404.html` | Custom "page not found" page |
| `book.html` | Consultation booking page (Stripe payment + scheduler) |
| `subscribe.html` | Mailing list sign-up page (saves to Google Sheet, then Stripe) |
| `thanks.html` | Post-payment page (Stripe redirects here) |
| `config.js` | **Edit this**: Stripe links, scheduler URL, sign-up endpoint |
| `pages.css`, `site.js` | Shared styles and helpers for the new pages |
| `apps-script/Code.gs` | Google Apps Script that writes sign-ups to a Sheet (CSV/Excel) |
| `SETUP.md` | Step-by-step setup for payments, booking and the mailing list |
| `robots.txt` | Search engine rules |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Bookings, payments and mailing list

Follow **SETUP.md**. Until `config.js` is filled in, the pages show a "setup needed" notice instead of broken links.

## Before you publish

Search `index.html` for these placeholders and replace them:

- `Your Name` (page title, logo, footer, photo alt text)
- `YN` (initials shown until `photo.jpg` exists)
- `you@example.com`
- `https://www.linkedin.com/in/your-handle`
- `https://github.com/your-username`

Also update the initials in `favicon.svg` and the name in `404.html`.

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
