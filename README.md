# Personal Portfolio

Static portfolio site, hosted on GitHub Pages. No build step or dependencies.

## Files

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
| `robots.txt`, `sitemap.xml`, `.nojekyll` | Search engine rules and indexable pages; serve files as-is on GitHub Pages |

## Brand system

Warm Ivory, Deep Ink and Cobalt; Newsreader headings, Inter body, IBM Plex Mono labels. Light only: there is no dark mode. The header shows the name logo alone (no tagline), with a two-row layout below 680 px; its links wrap to a second row below 960 px.

## Newsletter architecture

The paid newsletter runs on Stripe and AWS. Its backend lives outside this repository; the overview:

![Newsletter architecture on Stripe and AWS](docs/aws-architecture.png)
