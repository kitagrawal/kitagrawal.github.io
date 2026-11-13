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
     subscribeUrl: where every "Subscribe" button goes. Use your newsletter tool's
     paid-subscribe page (recommended, so its subscriber list stays in sync with Stripe)
     or a Stripe recurring Payment Link. Must start with https://. */
  newsletter: {
    price: "$7",   // text shown on the home page; "per month" is added there
    subscribeUrl: "https://buy.stripe.com/fZu8wP8pM7aU9LY8sB08g00",
    // unsubscribeApiUrl: the UnsubscribeUser API route (newsletter/setup-unsubscribe.sh prints it).
    // The hidden unsubscribe.html page posts the reader's email and the c/t from their letter's link here.
    unsubscribeApiUrl: "https://c7d3yimc7d.execute-api.us-east-2.amazonaws.com/unsubscribe"
  }
};
