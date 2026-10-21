/* ============================================================================
   WELCOME PAGES — copy the owner may want to change without touching markup,
   shared by the landing page (/welcome/) and the Teams page (/teams/).
   Prices, what Plus adds and what it promises next live in
   src/lib/pricing.js (shared with the planner and the server, which charges
   exactly those amounts). Online checkout is Creem, through the owner API:
   GET /api/checkout says what can be bought, and in which currency this
   visitor pays (the euro area in EUR, everyone else in USD; no switch).

   PROPOSALS TO CONFIRM BEFORE PUBLISHING (owner decision pending):
   - `pricingNote` (check the wording with your accountant);
   - `replyDelay` (left blank on purpose: no response time is promised);
   - `supportEmail` (left blank on purpose: fill it in yourself, or set
     DAILY_PLANNER_SUPPORT_EMAIL when building, which the legal pages use too).
   ============================================================================ */
export const LANDING = Object.freeze({
  // Shown after "Prices in euros, taxes included." under the prices (landing page).
  pricingNote: 'One-time payments. Receipts and invoices come from Creem, our payment partner.',
  // Optional add-on, shown under the team prices (and as a request type) when
  // enabled. Off: no workshops, travel or live sessions are sold for now.
  talk: Object.freeze({ enabled: false, label: 'A remote talk by Ben (45 minutes)', price: 'On quote' }),
  // When PLANNER_API_URL is blank, requests become an email to this address,
  // or, left blank, to the site's SUPPORT_EMAIL (runtime config). Without
  // either, the form stays visible but cannot be sent.
  // “<support@example.com>” and “Support <support@example.com>” work too.
  contactEmail: '',
  // A reachable support address, shown as "Support: …" in the footer when set
  // (the payment provider's review asks for one that matches this site).
  // Blank here: the site's SUPPORT_EMAIL (runtime config) is used instead.
  supportEmail: '',
  // Optional promise shown after a request, e.g. 'within two working days'.
  replyDelay: '',
  // The Teams page, as the manager email links to it.
  teamsUrl: 'https://planner.bemorin.com/teams/',
  // "Send this to my manager": the same text feeds the mailto link and the
  // Copy message button. {url} becomes teamsUrl; {perPerson} the lowest
  // price per person in the visitor's currency.
  managerEmail: Object.freeze({
    subject: 'An idea for our year-end gift',
    body: [
      'Hi,',
      '',
      'For our year-end gift, I’d like to suggest Daily Planner Plus for everyone. Instead of another object, each person gets a calm planner for their days and their year, with a guided session to plan the year ahead and a one-page review of the year.',
      '',
      'It’s simple to give: we get one link to forward, and each person who opens it activates Plus on their own planner. There’s nothing to install, no accounts to create and no names collected, and each person’s planner stays private: the company never sees it.',
      '',
      'It’s a one-time price for the company, from about {perPerson} per person, with an invoice and no subscription.',
      '',
      'Details and prices: {url}',
      '',
      'Worth a look?'
    ].join('\n')
  })
});
