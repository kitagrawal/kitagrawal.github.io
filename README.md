# Personal Portfolio

Static portfolio site served by a Cloudflare Worker at https://appliedailetter.com. No build step, no package manager.

## Layout

| Path | What it is |
|------|------------|
| `public/` | The deployed site: every page, stylesheet, script and image (file table below) |
| `worker/index.js` | The Worker: serves `public/`, redirects `www` to the apex, proxies `POST /api/cancel` to AWS with a shared-secret header and a per-IP rate limit, redirects `/subscribe` to the Stripe Payment Link |
| `wrangler.jsonc` | Worker config: name, assets directory, rate-limit binding, custom domains |
| `index.html`, `404.html`, `.nojekyll` (repo root) | GitHub Pages redirect stubs for the old `kitagrawal.github.io` address. Each sends the visitor to the same path, query and hash on appliedailetter.com. GitHub Pages still serves the rest of the repo as raw files (including an inert copy under `/public/`, whose canonical links point at appliedailetter.com); none of it holds a secret |
| `tools/` | Build helpers (`header-logos/`, `og-image/`) and the cutover wizard `cloudflare-setup.sh` |
| `docs/` | Images used by this README |

Preview the site locally with `python3 -m http.server -d public` (the Worker routes, `/subscribe` and `/api/cancel`, only exist on Cloudflare).

## Deploy

Cloudflare Workers Builds is connected to this GitHub repository: a push to `main` runs `npx wrangler deploy` (no build command). No Cloudflare token is stored in GitHub.

The upstream values are Worker secrets, never committed. Set each with `npx wrangler secret put <NAME>`, piping the value on stdin:

| Secret | What it holds |
|--------|---------------|
| `CANCEL_API_URL` | The cancel API (stack output `CancelApiUrl`) |
| `CANCEL_SHARED_SECRET` | Sent as `X-Cancel-Secret`; the same value is the `CANCEL_SHARED_SECRET` field of the Secrets Manager secret `applied-ai-letter/stripe` |
| `SUBSCRIBE_URL` | The Stripe Payment Link behind `/subscribe` |

The one-off move from IONOS DNS to Cloudflare, the secrets and the first deploy are walked through by `tools/cloudflare-setup.sh` (`--from N` resumes at stage N). It checks MX, SPF, DMARC and DKIM with `dig` before and after the nameserver change, and only prints the backend deploy commands.

## Tests

```bash
node --test worker/index.test.mjs
```

## Files

The paths below are relative to `public/`.

| File | Purpose |
|------|---------|
| `index.html` | Home page. Styles in `index.css`, behaviour in `home.js` |
| `book.html` | Consultation booking page (Cal.com popup) |
| `terms.html`, `privacy.html`, `consent.html`, `contact.html` | Legal and contact pages |
| `unsubscribe.html` | Cancel page, reached only from the link in each letter (not linked from the site, marked `noindex`) |
| `404.html` | Custom "page not found" page |
| `config.js` | Site settings: booking link, newsletter subscribe link, cancel endpoint |
| `base.css`, `index.css`, `pages.css` | Shared and page-specific styles |
| `site.js`, `home.js` | Shared helpers and the home page script |
| `favicon.svg` | Icon |
| `logo-*.svg`, `monogram-light.svg` | Outlined logos (`logo-name-light.svg`, the name alone, in the header and footer; `logo-light.svg`, the full lockup with the tagline, used only by `tools/og-image`) and the K. monogram; rebuild the logos with `tools/header-logos/build.py` |
| `og-image.png`, `apple-touch-icon.png` | Social share card and iOS home-screen icon; rebuild with `tools/og-image/build.sh` |
| `robots.txt`, `sitemap.xml` | Search engine rules and indexable pages |

## Brand system

Warm Ivory, Deep Ink and Cobalt; Newsreader headings, Inter body, IBM Plex Mono labels. Light only: there is no dark mode. The header shows the name logo alone (no tagline), with a two-row layout below 680 px; its links wrap to a second row below 960 px.

## Newsletter architecture

The paid newsletter runs on Stripe and AWS. Its backend lives outside this repository; the overview:

![Newsletter architecture on Stripe and AWS](docs/aws-architecture.png)
