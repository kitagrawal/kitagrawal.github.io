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
| `favicon.svg`, `theme-icon.svg` | Icons |
| `logo-*.svg`, `monogram-*.svg` | Outlined logo lockups (full, compact below 680 px, name-only for the footer) and the K. monogram, light and dark; rebuild the logos with `tools/header-logos/build.py` |
| `og-image.png`, `apple-touch-icon.png` | Social share card and iOS home-screen icon; rebuild with `tools/og-image/build.sh` |
| `robots.txt`, `sitemap.xml`, `.nojekyll` | Search engine rules and indexable pages; serve files as-is on GitHub Pages |

## Brand system

Warm Ivory, Deep Ink and Cobalt; Newsreader headings, Inter body, IBM Plex Mono labels. The header shows the full lockup from 680 px up and a two-row layout with the compact lockup below; its links wrap to a second row below 960 px.

## Newsletter architecture

The paid newsletter runs on Stripe and AWS. Its backend lives outside this repository; the overview:

![Newsletter architecture on Stripe and AWS](docs/aws-architecture.png)
