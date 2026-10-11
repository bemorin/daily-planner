# Owner API: Plus, team gifts, waitlist, feedback and demand counts

Daily Planner can talk to a small owner API (Cloudflare Pages Functions + D1) for:

1. **Daily Planner Plus** — a one-time, lifetime unlock of the Plus features (Plan your year, Your year in review, colours for the painted year). The API signs licences; the planner verifies them on the device, offline, with no account.
2. **Team gifts** — a company buys Plus for its people. It gets one gift link; each person who opens it activates Plus. Paid online through Creem (automatic) or by invoice (you create the gift in the dashboard).
3. **Anonymous daily counts** of a few named moments in the planner and on the landing page (the exact list is in `src/lib/planner-api.js`; the server accepts exactly the same names, and a test checks both lists match). Some are counted at most once per day, week or month on a device, so the dashboard can show how many devices use the planner without any identifier.
4. **The account-sync waitlist** — an email, the devices someone would use, an optional note and their consent to be emailed once.
5. **Feedback by app version** — a rating, a kind, a message, an optional reply email and the platform family. When someone ticks that their words may be quoted, a copy is kept as a **review**, with the name they chose to give (optional).
6. **Team requests** from the landing page — invoice requests, quotes and questions.
7. **Email through Resend** — notifications to you, the gift link and the Plus activation link to buyers, and the one waitlist announcement.

The API is **off by default**. With `PLANNER_API_URL` blank — the checked-in value — the planner and the landing page make no requests at all, and Plus cannot be activated (there is no public key either).

## What is never sent

- Nothing from the planner itself: no tasks, notes, schedules, Horizon content, journal entries or statistics. Plus features (the year plan, the review, palettes) run entirely on the device.
- Counts carry no identifier: no user ID, device ID, cookie, IP address or user agent is stored. Each count is only `(day, event name, app version) → number`.
- Activating a gift sends the gift code; confirming a purchase sends the Creem checkout reference. The licence that comes back is stored in the planner's settings, so Google Drive sync and backups carry it to the person's other devices.
- Local, never-synced flags: `daily-planner-ui:feedback`, `daily-planner-ui:waitlist-joined`, `daily-planner-ui:trophies-seen`, `daily-planner-ui:usage-counts`, `daily-planner-ui:counted` (which day, week or month a count was last sent) and the palette choice `daily-planner-ui:paint`.

## Privacy notice — shown automatically

When `PLANNER_API_URL` is set, the planner shows a **Privacy** entry in Settings and Help, a one-line note on the first setup step and a link under the waitlist and feedback forms. They open one Privacy dialog generated from the configuration (owner API, Plus, Google Drive sync, local storage), with a per-device switch **Send anonymous usage counts**. The landing page shows its own privacy paragraph. With the API off, none of it appears, because nothing is sent.

Waitlist emails and team requests are personal data under the GDPR. The waitlist is emailed once and each address is then deleted automatically; people can also leave from the sync guide at any time. Delete team requests and reviews on request (every row has a delete button).

## How payments, Plus and team gifts work

- **Creem takes the payments.** Creem is the *merchant of record*: it is the seller on the receipt, charges VAT where it applies, and sends the buyer the receipt and the invoice. You receive the money from Creem.
- **Prices** live in one file, `src/lib/pricing.js`, used by the landing page, the planner and the API. The API opens every checkout itself, so buyers always pay these amounts: Plus uses the price of its Creem product (keep it equal to `PLUS_PRICE`), and a team gift is charged the price of the pack chosen (the Creem product's own price is replaced).
- **Licence** — `DP1.<payload>.<signature>`: an ECDSA P-256 signature over a tiny JSON payload (`p: "plus"`, an id, where it came from, the company for gifts, a date). The private key (`PLUS_SIGNING_KEY`) stays on Cloudflare; the planner is built with the public key (`DAILY_PLANNER_PLUS_PUBLIC_KEY`) and checks the signature itself.
- **Buying Plus** — the buy button asks the API for a checkout (`POST /api/checkout`) and sends the buyer to Creem. After paying, Creem sends them back to `/?checkout_id=…`; the planner asks `POST /api/purchases/claim`, the API reads that checkout from Creem and returns a licence. Creem also tells the API directly (the webhook), and the API emails the buyer a link, `/?purchase=…`, that activates Plus on their other devices (up to 10 activations in all).
- **Team gift** — the same, returning to `/welcome/thanks/?checkout_id=…`. The API creates the gift once (whichever of the page and the webhook comes first), emails the buyer (gift link, manage link, a message to forward), and the page shows the link, the seats used and an editor for the company's message. The company name comes from a field on the Creem checkout. For invoices, create the gift in the dashboard; it gives you the gift link and a manage link (`/welcome/thanks/?gift=CODE&key=…`) to send to the buyer.
- **Seats** — the gift link is `https://planner.bemorin.com/?gift=XXXX-XXXX-XXXX`. Each activation uses a seat; the API allows the seats plus 10% (at least one) for people who set the planner up again, then answers "fully claimed". Nobody's name is collected. Gift links can be activated for 12 months.
- **Refunds** are made in Creem. To stop a refunded gift link, switch it off in the dashboard (use its **Active** switch: a paid gift is never erased, so the same payment can't create a new gift).

## How the waitlist measures real demand

The waitlist form only appears after the three-step Google Drive guide, and the dashboard shows the funnel (guide opened → step 2 → step 3 → form opened → joined, plus "chose Google Drive"). Each step is counted once per opening.

When account sync is ready, write the announcement in the dashboard and press **Send** (send a test to `OWNER_EMAIL` first). The API sends oldest first, at most `EMAIL_DAILY_LIMIT` emails per UTC day and 1,000 per press, and deletes each address right after its email goes out. Press Send again the next day for the rest.

## How feedback avoids asking twice

The planner asks at most once per feature release (1.21 covers 1.21.0, 1.21.1 …), in a dialog that shows what's new: the API is configured, at least three days closed, two days on this release, never asked about this release on this device, no prompt in the last fourteen days, and never during first-run setup or over another dialog. Feedback is always possible from **More → Send feedback** or **Help**. Ticking “You can quote this on the Daily Planner website” also keeps the rating, the message and the chosen name as a review (dashboard → Reviews).

## Local development

```text
npm run start:api        planner + API + dashboard on http://localhost:8080 (token: dev)
npm run start:api:fake   the same, printing emails instead of sending them, with pretend Creem payments
```

- Data is kept in `.planner-dev/api.json` (ignored by Git).
- Without `PLUS_SIGNING_KEY`, the dev server makes a throwaway key pair at each start, serves its public key to the planner, and `POST /api/dev/license` returns a licence (licences from an earlier run stop working).
- With `--fake-creem` (part of `start:api:fake`), every buy button opens a pretend checkout page that returns at once as paid, exactly like Creem does. Two shortcuts need no checkout: `/?checkout_id=fake_plus` unlocks Plus and `/welcome/thanks/?checkout_id=fake_gift50` creates a 50-seat gift for "Acme Studio". Start it with `CREEM_WEBHOOK_SECRET=anything` to try the webhook as well.
- `ADMIN_TOKEN=… ADMIN_TOTP_SECRET=… npm run start:api` tries two-factor sign-in locally.

## Production on Cloudflare Pages + D1

| Path | Purpose |
| --- | --- |
| `functions/api/[[path]].js` | Pages Function answering every `/api/*` request |
| `server/planner-api.js` | Router shared with the dev server |
| `server/licenses.js`, `server/gifts.js`, `server/creem.js`, `server/email.js`, `server/admin-auth.js` | Plus licences, gifts, Creem payments, Resend, dashboard sign-in |
| `src/lib/pricing.js` | Every price, shared by the landing page, the planner and the API |
| `server/d1-store.js`, `migrations/0001…0004` | Storage and tables |
| `admin/` | Dashboard at `/admin/` |
| `welcome/` | Landing page at `/welcome/` and the gift manage page at `/welcome/thanks/` |

The steps below are in the order to follow. Keep a note open while you work: several values are copied from one website and pasted into Cloudflare in step 5.

### 1. Database

1. In Cloudflare: **Storage & Databases → D1 SQLite Database → Create**. Name it `daily-planner`. Under **Specify jurisdiction**, choose **European Union** (the data stays in the EU; this can't be changed later).
2. Open the new database, then its **Console** tab.
3. Open each file of the `migrations/` folder in a text editor, copy its whole content, paste it into the console and run it — one file at a time: `0001_planner_api.sql`, `0002_team_requests.sql`, `0003_plus.sql` and `0004_creem_reviews.sql`. The order does not matter, and running a file twice does no harm (so when in doubt, run it again).

From a terminal instead: `npx wrangler d1 execute daily-planner --remote --file=migrations/0004_creem_reviews.sql` (one command per file).

If the dashboard ever says *"A database table is missing"*, a file was not run yet: run all four again.

### 2. Secrets you make on your computer

- `npm run admin:secret` → `ADMIN_TOKEN` and `ADMIN_TOTP_SECRET` (add the second to your authenticator app with "Enter a setup key").
- `npm run plus:keys` → `PLUS_SIGNING_KEY` (secret) and `DAILY_PLANNER_PLUS_PUBLIC_KEY` (build variable). Keep the signing key in your password manager: replacing it invalidates every licence already issued. `PLUS_SIGNING_KEY=… npm run plus:keys -- --public` prints the public key again.

### 3. Email (Resend)

Resend → **Domains → Add** (e.g. `bemorin.com`), copy the DNS records it shows (DKIM, SPF/MX) into Cloudflare DNS as *DNS only*, wait for *Verified*, then **API Keys → Create** with sending access. Free plan: 100 emails a day, 3,000 a month.

### 4. Payments with Creem

Do everything first in **Test mode**: nothing is charged, and you can buy Plus and a gift yourself to check the whole path. Then repeat the same steps in live mode (step 4.7).

1. **Account** — sign up at [creem.io](https://www.creem.io) and create your store. Make sure the **Test mode** switch in the Creem dashboard is on.
2. **Four products** — in **Products → Create product**, create these four. For each one choose a **one-time** payment (not a subscription), its currency, and mark the price as **tax inclusive** (the price already includes VAT, as on the landing page). If Creem asks for a tax category, choose the one for software or digital products.

   | Product | Currency | Price | What it is for |
   | --- | --- | --- | --- |
   | Daily Planner Plus | EUR | 29.00 | Plus bought in euros |
   | Daily Planner Plus | USD | 29.00 | Plus bought in dollars |
   | Daily Planner Plus team gift | EUR | 195.00 | every team pack in euros |
   | Daily Planner Plus team gift | USD | 195.00 | every team pack in dollars |

   The Plus price must stay equal to `PLUS_PRICE` in `src/lib/pricing.js`: if you change one, change the other. For the two gift products, the API sets the price of each pack (195 to 4,995) when it opens the checkout and seals what it sells, so a gift is only delivered for a checkout opened from the site's own buttons (someone opening the product's Creem link by hand gets nothing; check such a payment in Creem and refund it). You don't need to set a "success URL" either: the API gives Creem the return address for each checkout.
3. **Product ids** — open each product and copy its id; it starts with `prod_`. Note which is which: they go into `CREEM_PLUS_EUR`, `CREEM_PLUS_USD`, `CREEM_GIFT_EUR` and `CREEM_GIFT_USD`.
4. **API key** — **Developers → API keys**: copy the key (a test key starts with `creem_test_`). It goes into `CREEM_API_KEY`.
5. **Webhook** — **Developers → Webhooks → Create webhook** (or *Add endpoint*):
   - URL: `https://planner.bemorin.com/api/creem/webhook` (while testing: your project's `….pages.dev` address instead, see step 6)
   - Event: `checkout.completed`
   - Save, then copy its **signing secret**. It goes into `CREEM_WEBHOOK_SECRET`.

   The webhook is how a buyer who closes the tab right after paying still gets their gift, and how Plus buyers get the email that activates Plus on their other devices.
6. **Try it** — put the six values in Cloudflare (step 5), redeploy, open `/admin/`: the **Setup** card should say Creem is in test mode. With test keys, buying is switched off on `planner.bemorin.com` itself (otherwise anyone could pay with a test card and keep Plus): test on your Pages project's own address, `https://<project>.pages.dev`, shown at the top of the project in Cloudflare (use it for the test webhook URL too). Buy Plus and a small team gift on its landing page with Creem's test card (4242 4242 4242 4242, any future date, any security code — Creem's testing page lists it if it ever changes). You should land back on the planner with Plus unlocked, then on your gift page with the gift link, and receive the emails. Purchases made in test mode stop working once the live keys are in place.
7. **Go live** — when Creem has approved your store, switch the Creem dashboard to live mode and do steps 2 to 5 again there: live mode has its own products (new `prod_…` ids), its own API key (it does not start with `creem_test_`) and its own webhook with a new signing secret. Replace the six values in Cloudflare with the live ones and redeploy. If you had set `CREEM_TEST_MODE`, delete it.

### 5. Cloudflare Pages settings

All of this is in the Cloudflare dashboard, under **Workers & Pages → your Pages project → Settings**.

**The database binding** — **Settings → Bindings → Add → D1 database**. Variable name: `DB`. D1 database: `daily-planner`. Save.

**Variables and secrets** — **Settings → Variables and Secrets → Add**. For each line of the table: choose the **Type** shown (*Secret* for anything private, *Text* for plain values), type the name exactly as written, paste the value, and save it for the **Production** environment. A secret can't be read back after saving; to change one, edit it and paste the new value.

| Name | Type | What to paste | Where it comes from |
| --- | --- | --- | --- |
| `ADMIN_TOKEN` | Secret | the long token | `npm run admin:secret` |
| `ADMIN_TOTP_SECRET` | Secret | the setup key (recommended) | `npm run admin:secret` |
| `PLUS_SIGNING_KEY` | Secret | the signing key | `npm run plus:keys` |
| `RESEND_API_KEY` | Secret | the key, `re_…` | Resend → API Keys |
| `CREEM_API_KEY` | Secret | the key, `creem_test_…` while testing, then the live key | Creem → Developers → API keys |
| `CREEM_WEBHOOK_SECRET` | Secret | the webhook's signing secret | Creem → Developers → Webhooks |
| `CREEM_PLUS_EUR` | Text | `prod_…` of Plus in EUR | Creem → Products |
| `CREEM_PLUS_USD` | Text | `prod_…` of Plus in USD | Creem → Products |
| `CREEM_GIFT_EUR` | Text | `prod_…` of the team gift in EUR | Creem → Products |
| `CREEM_GIFT_USD` | Text | `prod_…` of the team gift in USD | Creem → Products |
| `EMAIL_FROM` | Text | the sender, e.g. `Daily Planner <hello@bemorin.com>`, on the verified domain | your choice |
| `OWNER_EMAIL` | Text | the inbox for notifications and test sends | your choice |
| `DAILY_PLANNER_API_URL` | Text | `/api` (switches the API and the privacy notices on) | always `/api` |
| `DAILY_PLANNER_PLUS_PUBLIC_KEY` | Text | the public key | `npm run plus:keys` |
| `EMAIL_DAILY_LIMIT` | Text | optional, default `100` | Resend plan |
| `PUBLIC_BASE_URL` | Text | optional, default `https://planner.bemorin.com` | your address |
| `CREEM_TEST_MODE` | Text | optional: `1` forces Creem's test mode (not needed with a `creem_test_` key) | — |

**Redeploy after every change** — **Deployments → the latest production deployment → ⋯ → Retry deployment**. Saved values are not used until the next deployment, and two of them (`DAILY_PLANNER_API_URL` and `DAILY_PLANNER_PLUS_PUBLIC_KEY`) are read while the site is built.

Then open `https://planner.bemorin.com/admin/`: the **Setup** card lists anything still missing, and never shows a secret.

### Protecting the API

- **Rate limiting** — the Free plan includes **one** rate limiting rule per domain; no add-on is needed. It counts requests per IP address, over a fixed 10-second period, and blocks for 10 seconds. Open the **bemorin.com** domain in Cloudflare → **Security → Security rules → Create rule → Rate limiting rule** (older dashboards: **Security → WAF → Rate limiting rules**):
  - Rule name: `API`
  - When incoming requests match: field **URI Path**, operator **starts with**, value `/api/`
  - Rate: **30** requests per **10 seconds**
  - Action: **Block**, then **Deploy**.

  This covers sign-in, gift links, purchase claims, checkouts, the forms and the counts in one rule. The Creem webhook is covered too; Creem sends far fewer requests than that.
- **Optional extra layer**: Cloudflare Zero Trust → Access for `planner.bemorin.com/admin/*` and `/api/admin/*`, allowing only your email. Never put Access in front of `/api/creem/webhook`, or Creem can't reach it.

### Dashboard sign-in

The dashboard sends the token and the 6-digit code to `POST /api/admin/session` and keeps only a signed 8-hour session in that tab. With two-factor on, the session key is derived from both secrets, so the token alone can never produce one; changing either secret signs every session out. Without `ADMIN_TOTP_SECRET`, scripts can still call admin routes with `Authorization: Bearer <ADMIN_TOKEN>`.

## Dashboard

`/admin/` shows: key numbers; charts over time (`GET /api/admin/series`: daily counts and sales); the sync funnel; team demand (landing visits → Teams → request → sent, plus checkouts); team requests (plan, currency, kind) with CSV and delete; **Team gifts** (create, copy gift and manage links, seats used, message, active switch, delete); **Plus** (purchases, create a licence for support or giveaways); the waitlist with the announcement composer; feedback by version and the reviews that may be quoted (with delete); other signals; and **Setup** (what's configured, never the secret values).
