# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The site belongs to Ankit Agrawal: a founder, senior data scientist and EdTech mentor. Visitors fall into these groups:

- **Business leaders (primary consultation visitor).** Founders and executives who want to know where GenAI and agentic workflows create value, what to build first, and how to avoid costly pilots. They usually pay as a business expense. When consultation copy or design must favour one group, it favours this one.
- **Newsletter readers.** Practitioners who want practical notes on applied ML, GenAI and AWS from someone who has shipped it.
- **Potential venture partners.** Institutions and partners interested in the stealth contact-tracing company.

## Product Purpose

A personal site that turns professional credibility into a paying relationship. It has three paid or partnership paths:

1. **The Applied AI Letter**: a paid newsletter, $7 a month (`subscribe.html`).
2. **Paid consultation**: "GenAI & Strategy Advisory", 60 minutes, $120 a session (`book.html`). The 1:1 Mentoring Session was retired on 2026-11-02.
3. **Partnership conversations** about the contact-tracing venture (contact section of `index.html`).

**Priority when these compete for attention: newsletter subscribers first.** Consultations come next, and the newsletter should not crowd them out for business-leader visitors. Success means paid newsletter sign-ups, then booked consultations.

## Positioning

Research depth combined with an engineer's habit of shipping. Ankit has applied ML and deep learning to high-stakes banking and healthcare problems, taken models to monitored, low-latency production on AWS, and teaches the subject from linear algebra up to deployed agents. A consultant who only talks strategy, or an engineer who has never explained a model to a non-technical stakeholder, cannot truthfully claim the same mix. Headline on the landing page: "Turning machine learning into decisions that ship."

## Operating Context

- Static site on GitHub Pages, served from the `main` branch root. No build step and no server.
- Payments go through Stripe Payment Links. Scheduling goes through Cal.com or Calendly. Newsletter sign-ups are written to a Google Sheet by an Apps Script web app. Redirects join these services (see `CLAUDE.md` and `SETUP.md`).
- Visitors arrive at the landing page, then go to `book.html` or `subscribe.html`. Stripe sends them back to `thanks.html`.

## Capabilities and Constraints

- All links and prices live in `config.js`. Values that contain `REPLACE` show a "Setup needed" notice and disable the action. Prices: advisory $120 a session, newsletter $7 a month.
- The newsletter is paid-only, billed monthly with automatic renewal, and can be cancelled at any time. Sign-up stays disabled until a Stripe subscription link is set.
- A `returned_from_checkout` status in the Sheet is not proof of payment. Stripe is the source of truth.
- The contact-tracing company is in **stealth**. Say only what the site says now: early-stage, building a contact-tracing application with the institutions that will use it, details at launch.
- `photo.jpg` is not committed yet. The landing page hides the image when it is missing.
- Open: the Stripe links, the scheduler URL, and the public contact email are not set yet.

## Brand Commitments

- Name: **Ankit Agrawal**. Newsletter name: **The Applied AI Letter**.
- Voice: first person, plain and practical. It claims what has been done and avoids hype ("where AI actually creates value, and where it doesn't").
- Identity: founder, senior data scientist, AI mentor. The domains are banking, lending and credit risk, healthcare and public health, and EdTech.

## Evidence on Hand

- Descriptions of eight problem areas: sub-prime lending models, auto-lending analytics, contact tracing, production ML on AWS, on-device model hosting, agentic workflows, leading full-stack teams, product ownership and system design (`index.html`, Selected Work).
- Skills and toolkit list, mentoring offers and newsletter perks (`index.html`, `config.js`).
- **No names, testimonials or metrics.** The owner chose to keep the work anonymous. Show domains and problem types only. Do not name employers, clients or platforms, invent testimonials, or quote numbers (people mentored, models shipped, latency, savings).

## Product Principles

1. **The newsletter is the main conversion.** Every page makes the next step to the Applied AI Letter easy to see, but it does not hide the consultations from a leader who is ready to book.
2. **Speak to the decision-maker.** Consultation content talks in business terms first (value, risk, what to build first) and technical detail second.
3. **Credibility comes from specifics, not names.** Proof comes from concrete problem descriptions and plain explanations, never from invented logos, quotes or numbers.
4. **Be honest about money.** Prices, billing frequency, cancellation and the Stripe checkout are clear before the visitor pays.
5. **The stealth venture stays in stealth.** Show interest in partners without disclosing product details.
