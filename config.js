/*
 * SITE CONFIGURATION: the only file you need to edit to go live with
 * bookings and subscriptions. See SETUP.md for step-by-step instructions.
 *
 * Anything still containing "REPLACE" is treated as "not set up yet", and the
 * pages show a friendly notice instead of a broken link.
 *
 * None of these values are secrets. Cal.com links are public.
 */
window.SITE_CONFIG = {

  /* ---- Paid consultations (book.html and index.html #advisory) ----
     The first one is the featured card. */
  consultations: [
    {
      id: "advisory",
      name: "GenAI & Strategy Advisory",
      duration: "60 min",
      price: "$120",   // text shown on the page; set the same amount on the Cal.com event (if Cal.com collects payment)
      description: "For founders and business leaders: where GenAI and agentic workflows create value, what to build first, and how to avoid costly pilots."
    }
  ],

  /* ---- Cal.com popup booking ----
     "Book an appointment" (index.html) and "Pick a time" (book.html) open this event in a popup.
     Format is "<cal-username>/<event-slug>", e.g. "ankit-agrawal/advisory".
     Leave "REPLACE" in it and the buttons show "Coming soon". */
  cal: {
    origin: "https://app.cal.com",                       // use "https://cal.eu" if your account is on the EU server
    bookLink: "REPLACE_WITH_CAL_USERNAME/EVENT_SLUG"
  },

  /* ---- Newsletter ----
     subscribeUrl: where every "Subscribe" button goes. Use your newsletter tool's
     paid-subscribe page (recommended, so its subscriber list stays in sync with Stripe)
     or a Stripe recurring Payment Link. Must start with https://. */
  newsletter: {
    price: "$7",   // text shown on the home page; "per month" is added there
    subscribeUrl: "REPLACE_WITH_SUBSCRIBE_URL"
  }
};
