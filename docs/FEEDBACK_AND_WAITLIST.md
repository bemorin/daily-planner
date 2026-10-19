# Owner API: Plus, team gifts, waitlist, feedback and demand counts

Daily Planner can talk to a small owner API (Cloudflare Pages Functions + D1) for:

1. **Daily Planner Plus** — a one-time, lifetime unlock of the Plus features (Plan your year, Your year in review, colours for the painted year). The API signs licences; the planner verifies them on the device, offline, with no account.
2. **Gifts** — a company buys Plus for its people (a **team gift**), or a person gives it to a friend (**Give Plus**) or to their family (**Plus Family**, up to 5 people). The buyer gets one gift link; each person who opens it activates Plus. Paid online through Creem (automatic) or, for teams, by invoice (you create the gift in the dashboard).
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
- About once a week, when the device is online and Plus is active, the planner sends only its licence (with the licence's random id), nothing else, to `POST /api/plus/check` to learn whether it was revoked (a refund or a dispute). No app version and nothing from the planner go with it, and the API stores nothing about the check. After a revocation the planner keeps that licence aside and keeps asking about it weekly, so a Restore brings Plus back. The time of the last check, the revoked licence ids and the licence kept aside stay on the device (`daily-planner-ui:plus-checked`, never synced or backed up).
- A partner code from a link like `/welcome/?ref=CODE` stays on the visitor's device (`daily-planner-ui:ref`, 60 days) and is sent only with a checkout, where the API passes it to Creem. The API never stores it. The buyer's country is read by Cloudflare for each checkout request, only to choose the currency, and is never stored by the API (the sales chart uses the country Creem reports with the payment).
- Local, never-synced flags: `daily-planner-ui:feedback`, `daily-planner-ui:waitlist-joined`, `daily-planner-ui:trophies-seen`, `daily-planner-ui:usage-counts`, `daily-planner-ui:counted` (which day, week or month a count was last sent) and the palette choice `daily-planner-ui:paint`.

## Privacy notice — shown automatically

When `PLANNER_API_URL` is set, the planner shows a **Privacy** entry in Settings and Help, a one-line note on the first setup step and a link under the waitlist and feedback forms. They open one Privacy dialog generated from the configuration (owner API, Plus, Google Drive sync, local storage), with a per-device switch **Send anonymous usage counts**. The landing page shows its own privacy paragraph. With the API off, none of it appears, because nothing is sent.

Waitlist emails and team requests are personal data under the GDPR. The waitlist is emailed once and each address is then deleted automatically; people can also leave from the sync guide at any time. Delete team requests and reviews on request (every row has a delete button).

## How payments, Plus and gifts work

- **Creem takes the payments.** Creem is the *merchant of record*: it is the seller on the receipt, charges VAT where it applies, and sends the buyer the receipt and the invoice. You receive the money from Creem.
- **Prices** live in one file, `src/lib/pricing.js`, used by the landing page, the planner and the API: `PLUS_PRICE`, the team packs (`TEAM_TIERS`) and the personal gifts (`PERSONAL_GIFTS`: Give Plus, at the price of Plus, and Plus Family). The API opens every checkout itself, so buyers always pay these amounts: Plus uses the price of its Creem product (keep it equal to `PLUS_PRICE`), and a gift is charged the price of what was chosen (the Creem product's own price is replaced). To change a price, edit that file and redeploy; nothing changes in Creem.
- **Currency** — there is no currency switch. The euro area (and the countries that use the euro, such as Monaco or Montenegro) pays in **euros**; everyone else pays in **US dollars**. The API decides from the buyer's country, which Cloudflare gives with every request: the page shows prices in that currency, and the checkout charges it whatever the page sent. When the country is unknown (a few networks, and local development), the page's own guess from the browser's languages is used. If a currency's product is missing in Cloudflare, buyers from those countries see "Payments in euros are not set up yet." (or "in US dollars"); they are never switched to the other currency.
- **Licence** — `DP1.<payload>.<signature>`: an ECDSA P-256 signature over a tiny JSON payload (`p: "plus"`, an id, where it came from, the company or the giver's name for gifts, a date). The private key (`PLUS_SIGNING_KEY`) stays on Cloudflare; the planner is built with the public key (`DAILY_PLANNER_PLUS_PUBLIC_KEY`) and checks the signature itself.
- **Buying Plus** — the buy button asks the API for a checkout (`POST /api/checkout`) and sends the buyer to Creem. After paying, Creem sends them back to `/?checkout_id=…`; the planner asks `POST /api/purchases/claim`, the API reads that checkout from Creem and returns a licence. Creem also tells the API directly (the webhook), and the API emails the buyer a link, `/?purchase=…`, that activates Plus on their other devices (up to 10 activations in all).
- **Team gift** — the same, returning to `/welcome/thanks/?checkout_id=…`. The API creates the gift once (whichever of the page and the webhook comes first), emails the buyer (gift link, manage link, a message to forward), and the page shows the link, the seats used and an editor for the company's message. The company name comes from a field on the Creem checkout ("Company name, shown to your team"; "Your company" when left empty). For invoices, create the gift in the dashboard; it gives you the gift link and a manage link (`/welcome/thanks/?gift=CODE&key=…`) to send to the buyer.
- **Personal gifts** — Give Plus (one person) and Plus Family (up to 5 people) are the same gift link, bought on the same Creem gift product and returning to the same page. The checkout asks "Your name, shown with the gift" (optional; "A friend" or "Your family" when left empty). The buyer's email is written for a person, not a company: the link to send, how activation works, the manage link and a short message to forward to the person or the family. In the dashboard these gifts are noted "Creem · Give Plus" and "Creem · Plus Family".
- **Seats** — the gift link is `https://planner.bemorin.com/?gift=XXXX-XXXX-XXXX`. Each activation uses a seat; for team gifts (10 seats or more) the API allows the seats plus 10% (at least one) for people who set the planner up again; Give Plus, Plus Family and smaller dashboard gifts allow exactly their seats. Then it answers "fully claimed". Nobody's name is collected. Gift links can be activated for 12 months.
- **Refunds and disputes** — you refund in Creem; the API does the rest (below, [Refunds and revoked licences](#refunds-and-revoked-licences)).

## Refunds and revoked licences

A licence is checked on the device, so without help a refund would leave Plus on for ever. Since 1.24:

1. **The order is remembered.** When a checkout is paid (webhook `checkout.completed`, or the buyer coming back with `?checkout_id=`), the API keeps its Creem **order id** and mode (test or live; table `orders`). Checkouts paid before 1.24 have none at first: a Plus purchase gets it the next time its activation link is opened, and a refund that matches nothing reads the orders of the 40 most recent Creem checkouts still without one (Plus purchases and gifts alike — gift buyers only open their manage link, which never records it) and looks again. An older sale beyond those can still be missed: it is then listed as **Not matched** (below).
2. **Creem reports the refund.** The webhook `refund.created` (or `dispute.created` for a chargeback) names only a transaction. The API asks Creem for it (`GET /v1/transactions?transaction_id=…`), whose order leads to the checkout, then to the Plus purchase or the gift. A refund whose mode (test or live) differs from its order's is ignored and listed as not matched. If Creem's transaction can't be read, the refund is listed as **Waiting** (with the error), the webhook answers 502 so Creem sends it again, and if Creem's next try fails too you get one email about it.
3. **A full refund or a dispute switches Plus off.**
   - Plus purchase: the activation link (`/?purchase=…`, `/?checkout_id=…`) answers “This purchase was refunded…”, and its licence is revoked.
   - Gift: its link is switched off (Team gifts shows it off, with a **Refunded** label) and every licence activated from it is revoked. Gift licences activated before 1.24 don't carry the gift's code and can't be reached this way.
   - Not delivered yet (the buyer never came back and `checkout.completed` hadn't gone through, e.g. while `PLUS_SIGNING_KEY` was missing): its order is revoked too, so when the checkout does complete nothing is delivered and nobody is emailed; the links say it was refunded, and the refund is matched to it then.
   - A second refund or a dispute of a payment that is already switched off adds nothing: one Restore undoes the whole payment. A partial refund that completes a full one (even one Creem delivers late) is shown as such, with its own amount.
4. **Planners find out.** About once a week, each planner with Plus asks `POST /api/plus/check` with its licence. A revoked licence switches Plus off on that planner, which then says once: “Plus was switched off on this planner: its purchase was refunded or cancelled. If this is a mistake, reply to your receipt email.” (the same words fit a revocation made by hand). Offline or on any error, Plus stays on. The planner keeps the revoked licence aside and keeps asking about it weekly: once it is valid again (Restore), Plus comes back, with a one-time “Plus is back on this planner”.
5. **A partial refund switches nothing off.** You get an email and decide: lower the seats of a gift (Team gifts → Edit), or revoke by hand.
6. **You are told every time.** `OWNER_EMAIL` receives a short email for each refund and dispute, and the dashboard's **Refunds and disputes** card lists them (date, kind, amount, full or partial, the purchase, and what was switched off). A refund that matches no purchase (an older sale whose order id wasn't found, or not from this site) is listed as **Not matched**, nothing is switched off (only its order is held back, in case it is delivered later), and the webhook still answers 200 so Creem doesn't send it again and again.

**By hand** — in **Refunds and disputes → Revoke Plus by hand**, paste a licence id (16 characters, e.g. from “Latest licences made here”), a whole licence (`DP1.…`), a checkout id (`ch_…`, from Creem, even one not delivered yet: it then never is) or a gift code, add a note if you like, and press **Revoke**. Use it for a refund that matched nothing, a dispute won or lost outside Creem, or a licence made here that should stop. The links then say the purchase was switched off (not refunded), and planners say “refunded or cancelled”. **Restore** (on a refund, a dispute or a line of “Revoked by you”) undoes exactly that decision: the links work again, and a gift link comes back as it was before (on, unless you had switched it off yourself). Planners that already lost Plus get it back at their next weekly check, when they are online.

Each event is processed once (by its refund or dispute id). Nothing about the person who activated a licence is stored: a revocation names a licence id, a checkout, an order or a gift.

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
- With `--fake-creem` (part of `start:api:fake`), every buy button opens a pretend checkout page that returns at once as paid, exactly like Creem does (team gifts are for "Acme Studio", personal gifts from "Camille"). Two shortcuts need no checkout: `/?checkout_id=fake_plus` unlocks Plus and `/welcome/thanks/?checkout_id=fake_gift50` creates a 50-seat gift for "Acme Studio". The webhook is on with a pretend secret (or `CREEM_WEBHOOK_SECRET` if you set one).
- **Pretend refunds:** `curl -X POST "http://localhost:8080/__fake-creem/refund?checkout=fake_plus"` refunds a paid pretend checkout in full and sends the signed `refund.created` webhook to the API, as Creem does; add `&amount=500` for a partial refund (in cents) or `&dispute=1` for a `dispute.created`. The checkout id is the one in the address after paying (`?checkout_id=ch_fake_…`) or a shortcut. To see the planner switch Plus off (or, after **Restore**, back on) without waiting a week, set `at` to `0` in `daily-planner-ui:plus-checked` in the browser's local storage and reload (removing the whole key also forgets the revoked licence kept aside).
- Locally the visitor's country is unknown, so prices follow the browser's languages. Add `--country FR` (or `US`, `DE` …) to the command to see the site as a visitor from that country; with curl, send the header `cf-ipcountry: FR`.
- The pretend Creem prints the partner code of each checkout and refuses the code `BADCODE`, as Creem refuses an unknown code: open `/welcome/?ref=BADCODE`, buy, and the checkout still opens (the server prints a warning).
- `ADMIN_TOKEN=… ADMIN_TOTP_SECRET=… npm run start:api` tries two-factor sign-in locally.

## Production on Cloudflare Pages + D1

| Path | Purpose |
| --- | --- |
| `functions/api/[[path]].js` | Pages Function answering every `/api/*` request |
| `server/planner-api.js` | Router shared with the dev server |
| `server/licenses.js`, `server/gifts.js`, `server/creem.js`, `server/refunds.js`, `server/email.js`, `server/admin-auth.js` | Plus licences, gifts, Creem payments, refunds and revocations, Resend, dashboard sign-in |
| `src/lib/pricing.js` | Every price, shared by the landing page, the planner and the API |
| `src/features/plus-check.js` | The planner's weekly licence check |
| `server/d1-store.js`, `migrations/0001…0005` | Storage and tables |
| `admin/` | Dashboard at `/admin/` |
| `welcome/` | Landing page at `/welcome/` and the gift manage page at `/welcome/thanks/` |

The steps below are in the order to follow. Keep a note open while you work: several values are copied from one website and pasted into Cloudflare in step 5.

### 1. Database

1. In Cloudflare: **Storage & Databases → D1 SQLite Database → Create**. Name it `daily-planner`. Under **Specify jurisdiction**, choose **European Union** (the data stays in the EU; this can't be changed later).
2. Open the new database, then its **Console** tab.
3. Open each file of the `migrations/` folder in a text editor, copy its whole content, paste it into the console and run it — one file at a time: `0001_planner_api.sql`, `0002_team_requests.sql`, `0003_plus.sql`, `0004_creem_reviews.sql` and `0005_refunds.sql`. The order does not matter, and running a file twice does no harm (so when in doubt, run it again).

From a terminal instead: `npx wrangler d1 execute daily-planner --remote --file=migrations/0005_refunds.sql` (one command per file).

**Updating to 1.24:** run `0005_refunds.sql` once (it only adds the tables `orders`, `refunds` and `revocations`). Until it is run, everything else works, but refunds are not recorded and nothing is switched off; the dashboard's Setup card says so.

If the dashboard ever says *"A database table is missing"*, a file was not run yet: run all five again.

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
   | Daily Planner Plus gift | EUR | 195.00 (replaced by the API) | every gift in euros: Give Plus, Plus Family and the team packs |
   | Daily Planner Plus gift | USD | 195.00 (replaced by the API) | every gift in dollars |

   The Plus price must stay equal to `PLUS_PRICE` in `src/lib/pricing.js`: if you change one, change the other. For the two gift products, the API sets the price of each gift (29 for Give Plus up to 4,995 for 1,000 people) when it opens the checkout and seals what it sells, so a gift is only delivered for a checkout opened from the site's own buttons (someone opening the product's Creem link by hand gets nothing; check such a payment in Creem and refund it). The product's name is what buyers see on the Creem page, so keep it general ("Daily Planner Plus gift"): if you created "Daily Planner Plus team gift" earlier, just rename it in Creem; its id does not change. You don't need to set a "success URL" either: the API gives Creem the return address for each checkout.
3. **Product ids** — open each product and copy its id; it starts with `prod_`. Note which is which: they go into `CREEM_PLUS_EUR`, `CREEM_PLUS_USD`, `CREEM_GIFT_EUR` and `CREEM_GIFT_USD`.
4. **API key** — **Developers → API keys**: copy the key (a test key starts with `creem_test_`). It goes into `CREEM_API_KEY`.
5. **Webhook** — **Developers → Webhooks → Create webhook** (or *Add endpoint*):
   - URL: `https://planner.bemorin.com/api/creem/webhook` (while testing: your project's `….pages.dev` address instead, see step 6)
   - Events: `checkout.completed`, `refund.created` and `dispute.created` (tick all three)
   - Save, then copy its **signing secret**. It goes into `CREEM_WEBHOOK_SECRET`.

   The webhook is how a buyer who closes the tab right after paying still gets their gift, how Plus buyers get the email that activates Plus on their other devices, and how a refund or a dispute switches Plus off. A webhook created before 1.24 has only `checkout.completed`: open it in Creem and add the two other events.
6. **Try it** — put the six values in Cloudflare (step 5), redeploy, open `/admin/`: the **Setup** card should say Creem is in test mode. With test keys, buying is switched off on `planner.bemorin.com` itself (otherwise anyone could pay with a test card and keep Plus): test on your Pages project's own address, `https://<project>.pages.dev`, shown at the top of the project in Cloudflare (use it for the test webhook URL too). Buy Plus, Give Plus and a small team gift on its landing page with Creem's test card (4242 4242 4242 4242, any future date, any security code — Creem's testing page lists it if it ever changes). You should land back on the planner with Plus unlocked, then on your gift page with the gift link, and receive the emails. From France the prices are in euros; a VPN in another country shows dollars. Purchases made in test mode stop working once the live keys are in place. Then refund one of the test purchases in Creem: it appears under **Refunds and disputes**, its link stops working, and you get an email.
7. **Go live** — when Creem has approved your store, switch the Creem dashboard to live mode and do steps 2 to 5 again there: live mode has its own products (new `prod_…` ids), its own API key (it does not start with `creem_test_`) and its own webhook with a new signing secret. Replace the six values in Cloudflare with the live ones and redeploy. If you had set `CREEM_TEST_MODE`, delete it.
8. **Affiliates (optional)** — partners who recommend Daily Planner earn a share of each sale they bring, and Creem pays them for you.
   - In Creem, open **Growth → Affiliate Hub** (Creem may show it as **Affiliates**) and create the program: the commission (a percentage of each sale), how many days a click counts (the cookie duration, 30 to 90 days), and whether you approve each partner yourself (recommended).
   - Invite your partners from there. Each one gets a code in their Creem affiliate portal.
   - Partners share a link to the landing page with their code: `https://planner.bemorin.com/welcome/?ref=THEIR_CODE`. The site keeps the code for 60 days on the visitor's device and sends it with the checkout, so a purchase made later (on the landing page or in the planner) is still credited to that partner.
   - Creem pays affiliates on the 1st and the 15th of each month (once they reach Creem's minimum balance), and lists their sales and commissions in the Affiliate Hub. You have nothing to pay or count yourself.
   - A wrong, paused or old code never blocks a sale: if Creem refuses it, the checkout opens again at once without it (the buyer sees nothing) and the Cloudflare logs show "Creem refused the affiliate code …". The code is passed to Creem only; the API never stores it.

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
| `CREEM_GIFT_EUR` | Text | `prod_…` of the gift in EUR (personal and team gifts) | Creem → Products |
| `CREEM_GIFT_USD` | Text | `prod_…` of the gift in USD (personal and team gifts) | Creem → Products |
| `EMAIL_FROM` | Text | the sender, e.g. `Daily Planner <hello@bemorin.com>`, on the verified domain | your choice |
| `OWNER_EMAIL` | Text | the inbox for notifications and test sends | your choice |
| `DAILY_PLANNER_API_URL` | Text | `/api` (switches the API and the privacy notices on) | always `/api` |
| `DAILY_PLANNER_PLUS_PUBLIC_KEY` | Text | the public key | `npm run plus:keys` |
| `EMAIL_DAILY_LIMIT` | Text | optional, default `100` | Resend plan |
| `PUBLIC_BASE_URL` | Text | optional, default `https://planner.bemorin.com` | your address |
| `CREEM_TEST_MODE` | Text | optional: `1` forces Creem's test mode (not needed with a `creem_test_` key) | — |
| `DAILY_PLANNER_SUPPORT_EMAIL` | Text | the contact address shown on the legal pages (an address on your own domain) | your choice (see [Legal pages](#legal-pages)) |
| `DAILY_PLANNER_LEGAL_ADDRESS` | Text | the postal address shown in the legal notice | your address |
| `DAILY_PLANNER_LEGAL_REGISTRATION` | Text | optional: SIRET and/or VAT number, e.g. `SIRET 123 456 789 00012` | your registration |

Nothing to set for the currency: Cloudflare tells the API each buyer's country.

**Redeploy after every change** — **Deployments → the latest production deployment → ⋯ → Retry deployment**. Saved values are not used until the next deployment, and the `DAILY_PLANNER_…` ones (the API URL, the Plus public key and the three legal details) are read while the site is built.

Then open `https://planner.bemorin.com/admin/`: the **Setup** card lists anything still missing, and never shows a secret.

### Legal pages

The site carries its own legal pages, linked from the planner's footer, the landing page and the gift page:

| Page | Address |
| --- | --- |
| Legal notice | `/legal/` |
| Privacy policy | `/legal/privacy/` (short link `/privacy`) |
| Terms of use and sale | `/legal/terms/` (short link `/terms`) |
| Cookies and storage | `/legal/cookies/` (short link `/cookies`) |

The short links come from `_redirects` (Cloudflare Pages reads it from the build output; the dev server applies it too), so old links to `bemorin.com/privacy`, `/terms` and `/cookies` land on the right page through the bemorin.com → planner redirect.

Three build variables fill in the publisher's details. Add them in **Settings → Variables and Secrets** as *Text* for **Production** (table above), then **redeploy**: they are read while the site is built.

- `DAILY_PLANNER_SUPPORT_EMAIL` — the contact address. Without it, every "contact us" points to the landing page's "Ask a question" form.
- `DAILY_PLANNER_LEGAL_ADDRESS` — your postal address, shown in the legal notice and the privacy policy.
- `DAILY_PLANNER_LEGAL_REGISTRATION` — optional: SIRET and/or VAT number.

A blank value is simply left out; nothing personal is ever written in the repository. The dashboard's **Setup** card says which ones are missing and lists the three addresses Creem asks for during its store review: the terms (`https://planner.bemorin.com/legal/terms/`), the privacy policy (`https://planner.bemorin.com/legal/privacy/`) and the website (`https://planner.bemorin.com/welcome/`).

The pages render the counted moments (`COUNTED_EVENTS`, `LANDING_EVENTS`), the prices and the Plus features from the code itself, so they can't drift. Edit the wording in `legal/*/index.html`, change the "Last updated" date at the top of the page, and have the text checked by a lawyer before relying on it.

### Protecting the API

- **Rate limiting** — the Free plan includes **one** rate limiting rule per domain; no add-on is needed. It counts requests per IP address, over a fixed 10-second period, and blocks for 10 seconds. Open the **bemorin.com** domain in Cloudflare → **Security → Security rules → Create rule → Rate limiting rule** (older dashboards: **Security → WAF → Rate limiting rules**):
  - Rule name: `API`
  - When incoming requests match: field **URI Path**, operator **starts with**, value `/api/`
  - Rate: **30** requests per **10 seconds**
  - Action: **Block**, then **Deploy**.

  This covers sign-in, gift links, purchase claims, checkouts, the weekly licence checks (`/api/plus/check`), the forms and the counts in one rule. The Creem webhook is covered too; Creem sends far fewer requests than that.
- **Optional extra layer**: Cloudflare Zero Trust → Access for `planner.bemorin.com/admin/*` and `/api/admin/*`, allowing only your email. Never put Access in front of `/api/creem/webhook`, or Creem can't reach it.

### Dashboard sign-in

The dashboard sends the token and the 6-digit code to `POST /api/admin/session` and keeps only a signed 8-hour session in that tab. With two-factor on, the session key is derived from both secrets, so the token alone can never produce one; changing either secret signs every session out. Without `ADMIN_TOTP_SECRET`, scripts can still call admin routes with `Authorization: Bearer <ADMIN_TOKEN>`.

## Dashboard

`/admin/` shows: key numbers; charts over time (`GET /api/admin/series`: daily counts and sales); the sync funnel; team demand (landing visits → Teams → request → sent, plus checkouts); team requests (plan, currency, kind) with CSV and delete; **Gifts** (team and personal gifts: create, copy gift and manage links, seats used, message, active switch, delete; a paid gift's note says what was bought, e.g. "Creem · Plus Family"; a refunded gift is labelled **Refunded**); **Plus** (purchases, create a licence for support or giveaways); **Refunds and disputes** (each one with what was switched off, Restore, and Revoke Plus by hand); the waitlist with the announcement composer; feedback by version and the reviews that may be quoted (with delete); other signals; and **Setup** (what's configured, never the secret values).
