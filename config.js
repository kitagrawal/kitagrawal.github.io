/*
 * SITE CONFIGURATION: the only file you need to edit to go live with
 * bookings and the mailing list. See SETUP.md for step-by-step instructions.
 *
 * Anything still containing "REPLACE" is treated as "not set up yet", and the
 * pages show a friendly notice instead of a broken link.
 *
 * None of these values are secrets. Stripe Payment Links and Apps Script URLs
 * are designed to be public. NEVER put a Stripe secret key (sk_...) here.
 */
window.SITE_CONFIG = {

  /* ---- Paid consultations (book.html and index.html #advisory) ----
     The first one is the featured card. */
  consultations: [
    {
      id: "advisory",
      audience: "For founders & business leaders",
      name: "GenAI & Strategy Advisory",
      duration: "60 min",
      price: "$120",   // text shown on the page; set the same amount on the Stripe Payment Link
      description: "For founders and business leaders: where GenAI and agentic workflows create value, what to build first, and how to avoid costly pilots.",
      stripeLink: "REPLACE_WITH_STRIPE_PAYMENT_LINK_FOR_ADVISORY"
    }
  ],

  /* Scheduler used to pick a time. A Cal.com or Calendly event URL.
     Shown after payment (thanks.html). If a consultation has no stripeLink,
     its button opens the scheduler directly (use this with Cal.com's built-in
     Stripe payments instead). */
  schedulerUrl: "REPLACE_WITH_CAL_COM_OR_CALENDLY_EVENT_URL",

  /* ---- Mailing list (subscribe.html) ---- */
  newsletter: {
    name: "The Applied AI Letter",
    price: "$7",   // monthly amount; pages add "per month". Billed monthly, auto-renewing, cancel anytime
    description: "Practical notes on applied ML, GenAI and AWS, plus early updates on what I'm building.",
    perks: [
      "Hands-on write-ups from real banking and healthcare ML work",
      "Agentic workflow patterns that survive production",
      "Early access to my contact tracing venture updates"
    ],
    stripeLink: "REPLACE_WITH_STRIPE_SUBSCRIPTION_PAYMENT_LINK",   // REQUIRED: a recurring monthly Payment Link. The list is paid-only; sign-ups stay disabled until this is set.
    manageUrl: "REPLACE_WITH_STRIPE_CUSTOMER_PORTAL_LINK"           // where subscribers cancel/manage (Stripe customer portal)
  },

  /* Google Apps Script web app URL that appends sign-ups to your Google Sheet
     (downloadable as CSV or Excel). Code is in apps-script/Code.gs. */
  signupEndpoint: "REPLACE_WITH_APPS_SCRIPT_WEB_APP_URL"
};
