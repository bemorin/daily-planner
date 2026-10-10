# Owner API: Plus, team gifts, waitlist, feedback and demand counts

Daily Planner can talk to a small owner API (Cloudflare Pages Functions + D1) for:

1. **Daily Planner Plus** — a one-time, lifetime unlock of the Plus features (Plan your year, Your year in review, colours for the painted year). The API signs licences; the planner verifies them on the device, offline, with no account.
2. **Team gifts** — a company buys Plus for its people. It gets one gift link; each person who opens it activates Plus. Paid with a Stripe Payment Link (automatic) or by invoice (you create the gift in the dashboard).
3. **Anonymous daily counts** of a few named moments in the planner and on the landing page (the exact list is in `src/lib/planner-api.js`; the server keeps the same allow-list).
4. **The account-sync waitlist** — an email, the devices someone would use, an optional note and their consent to be emailed once.
5. **Feedback by app version** — a rating, a kind, a message, an optional reply email and the platform family.
6. **Team requests** from the landing page — invoice requests, quotes and questions.
7. **Email through Resend** — notifications to you, the gift link to buyers, and the one waitlist announcement.

The API is **off by default**. With `PLANNER_API_URL` blank — the checked-in value — the planner and the landing page make no requests at all, and Plus cannot be activated (there is no public key either).

## What is never sent

- Nothing from the planner itself: no tasks, notes, schedules, Horizon content, journal entries or statistics. Plus features (the year plan, the review, palettes) run entirely on the device.
- Counts carry no identifier: no user ID, device ID, cookie, IP address or user agent is stored. Each count is only `(day, event name, app version) → number`.
- Activating a gift sends the gift code; confirming a purchase sends the Stripe checkout reference. The licence that comes back is stored in the planner's settings, so Google Drive sync and backups carry it to the person's other devices.
- Local, never-synced flags: `daily-planner-ui:feedback`, `daily-planner-ui:waitlist-joined`, `daily-planner-ui:trophies-seen`, `daily-planner-ui:usage-counts` and the palette choice `daily-planner-ui:paint`.

## Privacy notice — shown automatically

When `PLANNER_API_URL` is set, the planner shows a **Privacy** entry in Settings and Help, a one-line note on the first setup step and a link under the waitlist and feedback forms. They open one Privacy dialog generated from the configuration (owner API, Plus, Google Drive sync, local storage), with a per-device switch **Send anonymous usage counts**. The landing page shows its own privacy paragraph. With the API off, none of it appears, because nothing is sent.

Waitlist emails and team requests are personal data under the GDPR. The waitlist is emailed once and each address is then deleted automatically; people can also leave from the sync guide at any time. Delete team requests on request (every row has a delete button).

## How Plus and team gifts work

- **Licence** — `DP1.<payload>.<signature>`: an ECDSA P-256 signature over a tiny JSON payload (`p: "plus"`, an id, where it came from, the company for gifts, a date). The private key (`PLUS_SIGNING_KEY`) stays on Cloudflare; the planner is built with the public key (`DAILY_PLANNER_PLUS_PUBLIC_KEY`) and checks the signature itself.
- **Individual purchase** — the Stripe Payment Link sends the buyer back to `/?purchase={CHECKOUT_SESSION_ID}`. The planner asks `POST /api/purchases/claim`, the API reads the session from Stripe, and returns a licence if it's paid.
- **Team gift** — after a pack's Payment Link, the buyer lands on `/welcome/thanks/?session=…`: the API creates the gift once, emails the buyer (gift link, manage link, a message to forward), and the page shows the link, the seats used and an editor for the company's message. For invoices, create the gift in the dashboard; it gives you the gift link and a manage link (`/welcome/thanks/?gift=CODE&key=…`) to send to the buyer.
- **Seats** — the gift link is `https://planner.bemorin.com/?gift=XXXX-XXXX-XXXX`. Each activation uses a seat; the API allows the seats plus 10% (at least one) for people who set the planner up again, then answers "fully claimed". Nobody's name is collected. Gift links can be activated for 12 months.

## How the waitlist measures real demand

The waitlist form only appears after the three-step Google Drive guide, and the dashboard shows the funnel (guide opened → step 2 → step 3 → form opened → joined, plus "chose Google Drive"). Each step is counted once per opening.

When account sync is ready, write the announcement in the dashboard and press **Send** (send a test to `OWNER_EMAIL` first). The API sends oldest first, at most `EMAIL_DAILY_LIMIT` emails per UTC day and 1,000 per press, and deletes each address right after its email goes out. Press Send again the next day for the rest.

## How feedback avoids asking twice

The planner asks at most once per app version: the API is configured, at least five days closed, three days on this version, never asked about this version on this device, and no prompt in the last fourteen days. Feedback is always possible from **More → Send feedback** or **Help**.

## Local development

```text
npm run start:api        planner + API + dashboard on http://localhost:8080 (token: dev)
npm run start:api:fake   the same, printing emails and accepting two pretend Stripe payments
```

- Data is kept in `.planner-dev/api.json` (ignored by Git).
- Without `PLUS_SIGNING_KEY`, the dev server makes a throwaway key pair at each start, serves its public key to the planner, and `POST /api/dev/license` returns a licence (licences from an earlier run stop working).
- With `--fake-stripe`, `/?purchase=cs_test_fake_plus` unlocks Plus and `/welcome/thanks/?session=cs_test_fake_gift50` creates a 50-seat gift for "Acme Studio".
- `ADMIN_TOKEN=… ADMIN_TOTP_SECRET=… npm run start:api` tries two-factor sign-in locally.

## Production on Cloudflare Pages + D1

| Path | Purpose |
| --- | --- |
| `functions/api/[[path]].js` | Pages Function answering every `/api/*` request |
| `server/planner-api.js` | Router shared with the dev server |
| `server/licenses.js`, `server/gifts.js`, `server/stripe.js`, `server/email.js`, `server/admin-auth.js` | Plus licences, gifts, Stripe, Resend, dashboard sign-in |
| `server/d1-store.js`, `migrations/0001…0003` | Storage and tables |
| `admin/` | Dashboard at `/admin/` |
| `welcome/` | Landing page at `/welcome/` and the gift manage page at `/welcome/thanks/` |

### 1. Database

Cloudflare → **Storage & Databases → D1 SQLite Database → Create**: name `daily-planner`, **Specify jurisdiction → European Union** (data stays in the EU; it can't be changed later). Then open its **Console** and run, one file at a time, the whole content of `migrations/0001_planner_api.sql`, `0002_team_requests.sql` and `0003_plus.sql`. The files are safe to paste (the console joins lines) and safe to run again. CLI alternative: `npx wrangler d1 execute daily-planner --remote --file=migrations/0001_planner_api.sql` (then 0002, 0003).

### 2. Secrets

- `npm run admin:secret` → `ADMIN_TOKEN` and `ADMIN_TOTP_SECRET` (add the second to your authenticator app with "Enter a setup key").
- `npm run plus:keys` → `PLUS_SIGNING_KEY` (secret) and `DAILY_PLANNER_PLUS_PUBLIC_KEY` (build variable). Keep the signing key in your password manager: replacing it invalidates every licence already issued. `PLUS_SIGNING_KEY=… npm run plus:keys -- --public` prints the public key again.

### 3. Email (Resend)

Resend → **Domains → Add** (e.g. `bemorin.com`), copy the DNS records it shows (DKIM, SPF/MX) into Cloudflare DNS as *DNS only*, wait for *Verified*, then create an API key with sending access. Free plan: 100 emails a day, 3,000 a month.

### 4. Payments (Stripe Payment Links)

1. Create a **restricted key** with *Checkout Sessions: Read* → `STRIPE_SECRET_KEY`.
2. Create one product/price for Plus and one per team pack (in EUR and in USD if you sell both).
3. Create the **Payment Links**:
   - Plus → after payment, redirect to `https://planner.bemorin.com/?purchase={CHECKOUT_SESSION_ID}`.
   - Each pack → redirect to `https://planner.bemorin.com/welcome/thanks/?session={CHECKOUT_SESSION_ID}`, with a custom text field whose key is `company`. Turn on invoice creation if buyers need an invoice PDF.
4. `STRIPE_PRICES` maps price ids to what they sell, e.g. `{"price_123":{"kind":"plus"},"price_456":{"kind":"gift","seats":50,"plan":"up-to-50"}}`.
5. Paste the links: the Plus link as the build variable `DAILY_PLANNER_PLUS_CHECKOUT_URL`; the pack links in `LANDING.checkout` at the top of `welcome/landing.js`.

### 5. Pages project settings

**Bindings → D1 database**: `DB` = `daily-planner`. **Variables and secrets**:

| Name | Type | Value |
| --- | --- | --- |
| `ADMIN_TOKEN` | Secret | from `admin:secret` |
| `ADMIN_TOTP_SECRET` | Secret | from `admin:secret` (recommended) |
| `PLUS_SIGNING_KEY` | Secret | from `plus:keys` |
| `RESEND_API_KEY` | Secret | Resend API key |
| `STRIPE_SECRET_KEY` | Secret | restricted Stripe key |
| `STRIPE_PRICES` | Plain | JSON above |
| `EMAIL_FROM` | Plain | `Ben Morin <hello@bemorin.com>` (on the verified domain) |
| `OWNER_EMAIL` | Plain | where notifications and test sends go |
| `EMAIL_DAILY_LIMIT` | Plain | optional, default 100 |
| `PUBLIC_BASE_URL` | Plain | optional, default `https://planner.bemorin.com` |
| `DAILY_PLANNER_API_URL` | Plain (build) | `/api` — switches the API and the privacy notices on |
| `DAILY_PLANNER_PLUS_PUBLIC_KEY` | Plain (build) | from `plus:keys` |
| `DAILY_PLANNER_PLUS_CHECKOUT_URL` | Plain (build) | the Plus Payment Link |

Redeploy, then open `https://planner.bemorin.com/admin/`: the **Setup** card lists anything still missing.

### Protecting the API

- **Rate limiting** (Security → WAF → Rate limiting rules): one rule for `/api/admin/session`, `/api/gifts/`, `/api/purchases/claim`, `/api/teams`, `/api/waitlist`, `/api/waitlist/remove` and `/api/feedback`, e.g. 10 requests per minute per IP.
- **Optional extra layer**: Cloudflare Zero Trust → Access for `planner.bemorin.com/admin/*` and `/api/admin/*`, allowing only your email.

### Dashboard sign-in

The dashboard sends the token and the 6-digit code to `POST /api/admin/session` and keeps only a signed 8-hour session in that tab. With two-factor on, the session key is derived from both secrets, so the token alone can never produce one; changing either secret signs every session out. Without `ADMIN_TOTP_SECRET`, scripts can still call admin routes with `Authorization: Bearer <ADMIN_TOKEN>`.

## Dashboard

`/admin/` shows: key numbers; the sync funnel; team demand (landing visits → Teams → request → sent, plus checkouts); team requests (plan, currency, kind) with CSV and delete; **Team gifts** (create, copy gift and manage links, seats used, message, active switch, delete); **Plus** (purchases, create a licence for support or giveaways); the waitlist with the announcement composer; feedback by version; other signals; and **Setup** (what's configured, never the secret values).
