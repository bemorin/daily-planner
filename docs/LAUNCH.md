# Launch checklist

The steps to take Daily Planner from Creem's review to live sales, in order. Every
check below is on the owner dashboard's **Configuration** page (`/admin/configuration/`,
“Check everything”), which tests the real settings without showing any secret.
Details: [configuration.md](./configuration.md), [FEEDBACK_AND_WAITLIST.md](./FEEDBACK_AND_WAITLIST.md).

## 0. Once, on Cloudflare

- Caching → Configuration → **Browser Cache TTL: Respect Existing Headers**, so a new
  deployment reaches visitors on their next visit.
- Sign in to `/admin/` once on every browser and device you use: the dashboard then
  stops counting that browser (“This browser isn't counted”).

## 1. During Creem's review (test key)

1. Cloudflare → Workers & Pages → the project → Settings → Variables and Secrets →
   Production: `CREEM_TEST_ON_PRODUCTION` = `1` (Text). **Retry deployment.**
2. Configuration → Check everything. Expected: OK everywhere except
   `CREEM_API_KEY` (a test key, warning), `CREEM_TEST_ON_PRODUCTION` (review mode,
   warning) and `DAILY_PLANNER_AFFILIATE_URL` (missing until step 3.8).
3. Configuration → **Send me a test email**: it must arrive (this checks the sender's
   domain in Resend).
4. Your own purchase test on `https://planner.bemorin.com/welcome/` (the page says
   payments are in test mode):
   - buy Plus with Creem's test card `4242 4242 4242 4242`: Plus turns on, the
     “Your Daily Planner Plus” email arrives;
   - in Creem (test mode) → Discounts, create a 100% code (e.g. `REVIEW100`) on the
     four test products, and buy a gift with it: the order is €0, the gift link arrives;
   - the dashboard shows these purchases as test mode, never as sales.
5. Submit Creem's business details: Individual; product name *Daily Planner*; website
   `https://planner.bemorin.com/welcome/`; the support address; in “Product and
   platform details”, add: *Checkout runs in test mode until the store is approved, so
   you can test the full purchase on the site.*

## 2. When Creem approves (live key)

1. Creem → live mode → API key → Cloudflare `CREEM_API_KEY` (**Secret**).
2. **Retry deployment**, then Configuration → Check everything → in the Creem group,
   run the **Creem setup assistant** in live mode (confirm live): it creates the four
   live products and the webhook. Copy the `.env` block into Cloudflare
   (`CREEM_PLUS_EUR`, `CREEM_PLUS_USD`, `CREEM_GIFT_EUR`, `CREEM_GIFT_USD`, Text) and,
   if shown, the webhook signing secret into `CREEM_WEBHOOK_SECRET` (**Secret**; it is
   shown once).
3. Delete `CREEM_TEST_ON_PRODUCTION` (and `CREEM_TEST_MODE` if it exists).
   **Retry deployment.**
4. Configuration → Check everything: everything required is OK.
5. A real purchase with your own card: Plus turns on, the email arrives, the dashboard
   counts the sale. Refund it in Creem: the dashboard records the refund and the
   licence is switched off at the planner's next weekly check.

## 3. Launch day

1. Dashboard → Refunds and disputes → **Switch off test-mode purchases** (type
   `SWITCH OFF`): every licence and gift link bought in test mode stops.
2. Dashboard → Trends → **Start fresh at launch** (type `RESET`): the anonymous usage
   counts start from zero; purchases, requests and partners are kept.
3. Creem → Growth → Affiliate Hub: commission **25%**, attribution **30 days**, program
   **public**. Copy its sign-up link into `DAILY_PLANNER_AFFILIATE_URL` (Text).
   **Retry deployment.**
4. Configuration → Check everything: nothing left in “Fix first”.

## After launch

- Each week: the dashboard's **Needs your attention** (questions and requests to
  answer, team commissions to pay — an individual partner at most €300 / $300 a year).
- A boosted partner week (e.g. 40% / 20%): change the rate in Creem for the week; ask
  for the team-commission period to be added in the code.
- Plus becomes a yearly subscription for new buyers after the launch (a 2.0 release).
