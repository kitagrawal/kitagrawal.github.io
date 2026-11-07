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
    bookLink: "https://cal.com/appliedailetter/60min"
  },

  /* ---- Newsletter ----
     subscribeUrl: where every "Subscribe" button goes: your Buttondown subscribe page,
     which runs Stripe checkout and keeps the subscriber list (see SETUP.md section 2).
     Must start with https://. */
  newsletter: {
    price: "$7",   // text shown on the home page; "per month" is added there
    subscribeUrl: "https://buy.stripe.com/fZu8wP8pM7aU9LY8sB08g00"
  },

  /* ---- Topic requests (topics.html) ----
     formEndpoint: a Formspree form URL ("https://formspree.io/f/<id>"). Formspree stores
     each request; export them as CSV and rank with scripts/rank-topics.mjs (see SETUP.md).
     list: the topics visitors can vote for. Edit freely; the ranking counts by this text.
     Leave "REPLACE" in formEndpoint and the form stays disabled. */
  topics: {
    formEndpoint: "REPLACE_WITH_FORMSPREE_FORM_URL",
    list: [
      "Is AI a bubble? Where the value is, and where it isn't",
      "Choosing a first GenAI project that pays back",
      "Agentic workflows that survive production",
      "Evaluating LLM output before you ship it",
      "Machine learning in lending and credit risk",
      "Taking a model from notebook to production on AWS",
      "Machine learning in healthcare and public health"
    ]
  }
};
