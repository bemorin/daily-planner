# Configuration page

**Admin → Configuration** (`/admin/configuration/`, linked from the dashboard's header and its **Setup** card) checks every production setting for real, so you don't have to reread the setup guide ([FEEDBACK_AND_WAITLIST.md](FEEDBACK_AND_WAITLIST.md)). It uses the dashboard's sign-in: the signed 8-hour session of that tab.

**Check everything** asks the server to try each setting with its own service, read-only. Each call times out after 5 seconds and the calls run side by side; two are made one after the other (the webhook's signing secret after the webhook list, the tables after `SELECT 1`), so the whole check takes 10 seconds at most and usually one or two. Nothing is changed anywhere and nothing is stored. A secret's value is never shown, not even in part: only whether it is set, its length and the form recognised (“looks like a Creem live key (creem_…), 54 characters”; for `ADMIN_TOKEN`, its length and “strong” or “weak”, never what it is made of).

What a service says never brings a secret back (`server/secret-scrub.js`, the one scrubber of every owner route): after a 401 or a 403 none of its words are kept and the page says what happened in its own; otherwise any 4 characters of a secret, any key-shaped token (`creem_test_…`, `creem_…`, `whsec_…`, `re_…`, whatever its length) and masked forms (`re_ab****cd`, `creem_…`) are hidden, and a text that would still show one once decoded (URL-encoded, JSON or HTML escapes) is dropped whole. The whole answer is scrubbed again before it leaves the server. Tests (`tests/secret-scrub.test.js`, `tests/admin-config.test.js`, `tests/creem-setup.test.js`, `tests/planner-email.test.js`) try partial echoes — the last 4 characters, a masked key, the prefix alone, a fragment from the middle, URL-encoded and JSON-escaped — and check that no 4 characters of a secret come back.

## Reading it

One row per setting, grouped as on Cloudflare:

| State | Meaning |
| --- | --- |
| **OK** | Set, and its service accepted it (or its form is right, when there's nothing more to test). |
| **Problem** | Set, but wrong: the row says what it blocks and the exact fix. |
| **Warning** | Set on purpose for a while, to change later (1.34: review mode while Creem reviews the store). It blocks nothing; the row says when and how to change it. |
| **Missing** | Required or recommended, and not set. |
| **Optional, missing** | Not set, and blank is a sound default (the row says what blank means). |
| **Present, not tested** | Set, but the service gave no usable answer, or offers no read-only test (see below). |

**Fix first**, at the top, lists the problems and missing settings: required ones first, then recommended, then optional, and the warnings last. Each line jumps to its row, where the fix is written out: the exact path in Cloudflare (**Workers & Pages → your Pages project → Settings → Variables and Secrets → Production**), the variable's name and type (*Secret* or *Text*), then **Retry deployment**; for the database, the SQL to paste in the D1 console, in the order to run it (or the `wrangler` commands). Copy buttons sit next to every name, address and SQL. The time of the check is shown; check again once a new deployment is live.

**A migration not fully applied.** Running a migration file again creates what is missing (it is safe to run again) but skips a table that exists. So a missing column comes first:

- A column SQLite can add in place gets its `ALTER TABLE … ADD COLUMN` line (**Missing column**), run *before* the file (whose indexes may need the column).
- A column it can't add to a table that exists — a `PRIMARY KEY`, `UNIQUE`, `NOT NULL` without a default — means rebuilding the table, in two steps that never lose a row: **Rebuild …, 1 of 2** copies every row into a complete new table (`<table>_rebuild`) and changes nothing else; **2 of 2**, run only if step 1 worked, puts the complete table in place and keeps the old one as `<table>_before_<date>` (delete it once the page says OK). If the table has rows and the column is `NOT NULL` without a default, step 1 fails (“NOT NULL constraint failed”) without changing anything: those rows need a value first, so stop and ask for help.
- Then the whole file, for the tables and indexes still missing.

`tests/admin-config-d1.test.js` runs these fixes on a real SQLite for every column of every migration, in an empty table and in one with rows.

**Generate a value** draws, in your browser (`crypto.getRandomValues`, WebCrypto), the secrets no service gives you: `ADMIN_TOKEN` (48 letters and digits), `ADMIN_TOTP_SECRET` (32 base32 characters, with its `otpauth://` link for an authenticator app) and, only while no usable `PLUS_SIGNING_KEY` is set, a Plus key pair (`PLUS_SIGNING_KEY` with its `DAILY_PLANNER_PLUS_PUBLIC_KEY`). Values are kept nowhere — not sent, not stored — and are gone when you leave the page. Replacing an existing Plus key invalidates every licence already issued: the page never offers it then.

**Copy summary** copies the state of every setting as plain text — states, forms and lengths, never a value — to paste into a conversation with Claude. **Send me a test email** sends one short email, “Daily Planner: test email”, to `OWNER_EMAIL` only, through Resend (`POST /api/admin/email/test`, 5 per 10 minutes per worker isolate; it counts toward `EMAIL_DAILY_LIMIT` like every email, as Resend counts it). It has nothing to do with the waitlist: the dashboard's own test of an announcement stays where it is.

## What each check does

| Service | Read-only check |
| --- | --- |
| D1 (`DB`) | `SELECT 1`, then every table, column and index of `migrations/0001…0008` in `sqlite_master` (columns by their names, read from each table's `CREATE TABLE`). No answer in time is “not tested”; an error is a problem with the binding. D1 has no extensions, and this app has no scheduled jobs (no cron trigger) and no private settings in the database: there is nothing else to check. |
| Creem | `CREEM_API_KEY`: `GET /v1/checkouts?checkout_id=` with a made-up id (404 means the key was accepted, 401/403 refused), on the test API when the key is `creem_test_…` or `CREEM_TEST_MODE` is on. Each product: `GET /v1/products/{id}` — currency, one-time, not archived, tax inclusive, and Plus at `PLUS_PRICE` (a gift product's own price is never charged). The webhook: `GET /v1/webhooks`, one for this site's `/api/creem/webhook` with `checkout.completed`, `refund.created` and `dispute.created`, then `GET /v1/webhooks/{id}/secret`, compared on the server, in constant time, with `CREEM_WEBHOOK_SECRET` and never sent back. A test key on the production address is a problem: buying is switched off there, and the fix says how review mode (`CREEM_TEST_ON_PRODUCTION`) lets Creem's team make a test purchase before approving the store; with review mode on, it is a warning (put the live key in once approved). `CREEM_TEST_ON_PRODUCTION` on with a test key is a warning (“Review mode: test purchases are open on the production address — turn it off once your live key is in”); on with a live key it has no effect, and the row says to remove it. |
| Resend | `GET /domains`: a full-access key lists the domains, and the domain of `EMAIL_FROM` must be verified; a sending-only key answers 401 `restricted_api_key`, which still proves the key. |
| Plus | A random message signed with `PLUS_SIGNING_KEY` on the server must verify with the public key the planner was built with. When it doesn't, the row gives the public key that matches (it is public). |
| Build variables | Compared with the values the deployed `runtime-config.js` holds (read through the `ASSETS` binding): a variable changed since the last deployment says “retry the deployment”. Their form is checked as the pages check it (the legal pages' rules for addresses and phone numbers). |
| The rest | By form: token strength, base32, https addresses, email addresses, whole numbers. |

## Not testable from here, and why

- `DAILY_PLANNER_GOOGLE_CLIENT_ID`: Google has no read-only check for a client ID. Connect Google Drive in the planner (Settings → Personal sync) to try it.
- `EMAIL_FROM` with a sending-only Resend key: such a key can't read domains. **Send me a test email** tries the whole path.
- `CREEM_WEBHOOK_SECRET` with a Creem key that can't read webhooks (no `webhooks:read` scope): compare it in Creem → Developers → Webhooks.
- Links (`DAILY_PLANNER_GITHUB_URL`, the social links, `DAILY_PLANNER_AFFILIATE_URL`): only their form; they aren't opened from the server.
- On the local dev server there is no D1: the database rows say “checked on Cloudflare”.

## One deployment

There is one deployment, production. No secret is shared with another deployment, so there is nothing to compare between deployments (no health route either). A preview deployment uses the project's **Preview** variables: open the page on its address (`https://<hash>.<project>.pages.dev/admin/configuration/`) to check them there.

## Every setting

Classified from the code (`server/config-inventory.js`; `tests/config-inventory.test.js` fails when the code reads a variable that isn't listed, or the other way round).

| Name | Level | Secret | Where |
| --- | --- | --- | --- |
| `DAILY_PLANNER_API_URL` | required | no | build (`runtime-config.js`) |
| `DAILY_PLANNER_PLUS_PUBLIC_KEY` | required | no (public) | build |
| `DAILY_PLANNER_AFFILIATE_URL` | recommended | no | build |
| `DAILY_PLANNER_SUPPORT_EMAIL` | recommended | no | build (legal pages) |
| `DAILY_PLANNER_LEGAL_PHONE` | recommended | no | build (legal pages) |
| `DAILY_PLANNER_LEGAL_ADDRESS` | recommended | no | build (legal pages) |
| `DAILY_PLANNER_PRIVACY_EMAIL` | optional | no | build (legal pages) |
| `DAILY_PLANNER_LEGAL_REGISTRATION` | optional | no | build (legal pages) |
| `DAILY_PLANNER_GOOGLE_CLIENT_ID` | optional | no | build |
| `DAILY_PLANNER_CLOUD_API_URL` | optional | no | build |
| `DAILY_PLANNER_GITHUB_URL`, `DAILY_PLANNER_SPONSOR_URL`, `DAILY_PLANNER_X_URL`, `DAILY_PLANNER_LINKEDIN_URL` | optional | no | build |
| `DB` | required | — | Functions: D1 binding |
| `ADMIN_TOKEN` | required | yes | Functions |
| `PLUS_SIGNING_KEY` | required | yes | Functions |
| `CREEM_API_KEY` | required | yes | Functions |
| `CREEM_WEBHOOK_SECRET` | required | yes | Functions |
| `CREEM_PLUS_EUR`, `CREEM_PLUS_USD`, `CREEM_GIFT_EUR`, `CREEM_GIFT_USD` | required | no | Functions |
| `ADMIN_TOTP_SECRET` | recommended | yes | Functions |
| `RESEND_API_KEY` | recommended | yes | Functions |
| `EMAIL_FROM`, `OWNER_EMAIL` | recommended | no | Functions |
| `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `EMAIL_DAILY_LIMIT`, `CREEM_TEST_MODE`, `CREEM_TEST_ON_PRODUCTION` | optional | no | Functions |

Required means a core promise breaks without it (the API, selling Plus, activating it). Cloudflare also gives every Function the `ASSETS` binding by itself (the site's files); nothing to set.

Read on a computer only, never set on Cloudflare: `PORT` (the dev server's port), `FAKE_CREEM_CATALOG` (the pretend Creem store of `--fake-creem`), `CHROME_BIN`, `PROGRAMFILES` and `PROGRAMFILES(X86)` (where the smoke test finds Chrome). The dev server also reads the production variables above, so the API behaves locally as in production; `npm run admin:secret` reads `ADMIN_TOTP_SECRET` and `npm run plus:keys` reads `PLUS_SIGNING_KEY`.

**For developers.** `server/config-inventory.js` (the list), `server/admin-config.js` (the checks, `fetch` injectable), `server/secret-scrub.js` (the scrubber), `server/admin-limits.js` (the rate limits), `POST /api/admin/config/check` (owner sign-in), `POST /api/admin/email/test` (owner sign-in), `admin/configuration/` (the page). The rate limits — 10 checks, 20 Creem plans, 6 Creem Creates and 5 test emails per 10 minutes — live at module scope: the Pages Function builds a new API for each request, and every request a worker isolate answers shares them. They are per isolate (Cloudflare runs several), so Cloudflare's rate limiting rule on `/api/` is the real guard. Locally, `node scripts/serve.mjs --api --fake-email --fake-creem` answers the checks with its pretend Creem and Resend.

## Review mode, while Creem reviews the store

Creem enables live payments only once it has approved the store, and its compliance team may make a limited test purchase with a one-time 100% discount code. A test key normally switches buying off on the production address (anyone could pay with a test card), so the reviewers would only see “Coming soon”. Review mode opens it for that time:

1. Keep the test key, the four test product ids and the test webhook's signing secret (the test webhook must send events to the production address, `PUBLIC_BASE_URL` + `/api/creem/webhook`).
2. **Workers & Pages → your Pages project → Settings → Variables and Secrets → Production → Add**: Type **Text**, name `CREEM_TEST_ON_PRODUCTION`, value `1`. Retry the deployment.
3. Checkouts now open on the production address in Creem's test mode: nothing is charged and real cards are refused. The buy buttons say so in one line (the checkout options answer `test: true`, and `review: true` on the production address). Purchases and gifts are delivered and emailed as usual, marked **Test mode**. This page shows the variable as a **Warning**, and `CREEM_API_KEY` too.
4. Once approved: the live key, the live product ids and the live webhook's signing secret in place, `CREEM_TEST_ON_PRODUCTION` deleted, retry the deployment.
5. Dashboard → **Refunds and disputes** → **Switch off test-mode purchases**: type `SWITCH OFF` in its dialog. Every licence and gift link bought in test mode is revoked (planners lose Plus at their next weekly check; gift links stop at once), as one decision that **Restore all** undoes. **Needs your attention** reminds you while some are still active.

With a live key the variable changes nothing. On a local server, an address like `localhost` is never production: see the header of `scripts/serve.mjs` to try review mode under another host name.

## Creem setup assistant

**Admin → Configuration → Set up Creem products** creates in Creem the four products and the webhook the site needs, from the prices in `src/lib/pricing.js`, and gives you the lines to paste into your host. It works with the key in `CREEM_API_KEY`, in its mode: a test key (`creem_test_…`, or `CREEM_TEST_MODE=1`) sets up your test store, a live key your live store. The mode is shown next to the title; in live mode you tick “I understand this creates real products in my live Creem store” before **Create** is possible.

1. **The plan.** When it opens (in the **Creem** group, after the first **Check everything**), the assistant reads your Creem store (read only) and lists, for Plus EUR, Plus USD, Gift EUR, Gift USD and the webhook, what the code needs and what Creem has:
   - **Ready**: the product in `CREEM_…` is right (one-time, tax included, the currency, and for Plus the price of `PLUS_PRICE`).
   - **Found**: a right product is in Creem but your variable doesn't name it yet (made earlier by the assistant, or by hand with the exact name “Daily Planner Plus” / “Daily Planner Plus gift”).
   - **To create**: nothing usable is in Creem.
   - **Differs**: the product exists but is wrong (another price, currency, billing, tax added on top, archived): each difference is listed. The assistant never edits or deletes anything in Creem and creates no second product for it: change it in Creem → Products, then **Check again**. A gift product's own price and a renamed product are only noted (each gift checkout sends its price).
2. **Create the missing products** makes only what is listed as “To create”: it reads Creem again first, so running it again later creates nothing twice. Then:
   - **Environment variables**: `CREEM_PLUS_EUR=prod_…` and the three others. `CREEM_TEST_MODE=1` is added only when it is what puts your key in test mode (a key that isn't `creem_test_…`, on Creem's test API because `CREEM_TEST_MODE` is on): a `creem_test_` key needs none, and a live key must have none. Paste them into Cloudflare Pages → Settings → Variables and Secrets, each as **Text**, then redeploy. The lines that change are highlighted. Product ids aren't secrets.
   - **Webhook signing secret · shown once**, when the webhook was just created: copy it into `CREEM_WEBHOOK_SECRET` as a **Secret**, then redeploy. It is not stored anywhere by the site (not on the server, not in the browser) and disappears when you hide it or leave the page; Creem → Developers → Webhooks still shows it if you lose it (or rotate it there).
   - **If the answer to Create doesn't arrive** (the connection dropped, the server failed), the page can't tell what was made: it says that something may have been created and keeps **Create** off until you **Check again**, which shows what Creem has now. A webhook created then has had its signing secret shown nowhere: copy it from Creem → Developers → Webhooks (or rotate it there) into `CREEM_WEBHOOK_SECRET`.
3. Once a webhook exists, the plan says whether `CREEM_WEBHOOK_SECRET` matches its signing secret (the server compares them; neither is ever shown).

**Two Creates at the same time** (a double click, two tabs, a retry while the first is still running) — exactly what is guaranteed:
- In one worker isolate they are serialised: the second answers “a setup is already running” and creates nothing.
- Across isolates (Cloudflare may send the two requests to two of them), each product request carries Creem's `Idempotency-Key`, derived from the mode and the product's marker (with its price, the UTC day and the count of earlier copies), so both send the same key and Creem answers the same product. The webhook list is read again right before the webhook is created, so a second Create that starts after the first made it finds it; two that reach that point at the same instant can still make two endpoints on one URL — the plan then says so (“each event arrives 2 times: delete the extra one”).
- The rate limits (20 plans and 6 Creates per 10 minutes) are per worker isolate too.

**Which webhook address.** The assistant registers `PUBLIC_BASE_URL` + `/api/creem/webhook` (default `https://planner.bemorin.com`) when the page is open on the production address or on a local server. On another address (a preview, the `.pages.dev` one) with a test key, it registers that address's own webhook, as the configuration check expects there. On another address with a live key, **Create** is refused: a live store's webhook belongs to production, so set it up from the production address. The plan shows the address it will register, and why that one.

**When the webhook must be added by hand.** Creem calls the webhook from the internet, so it needs a public `https` address (above). And Creem only lets a key manage webhooks with the `webhooks:read` and `webhooks:write` scopes: without them the plan says “By hand”. Then add it in Creem → Developers → Webhooks with that URL and the events `checkout.completed`, `refund.created` and `dispute.created`, and copy its signing secret into `CREEM_WEBHOOK_SECRET`.

**How it recognises its own objects.** Creem products have no metadata field in Creem's API, so each product the assistant creates ends its description with a reference such as `Ref. dp-setup:plus-eur` (buyers may see the description on Creem's page). Keep that reference if you edit the description: it is how a second run knows the product already exists. While an active product carries a reference, no other is created for it; archive it in Creem to start again. A webhook is recognised by its URL (two endpoints on one URL would receive every event twice) and is named “Daily Planner · dp-setup”. Each product request also carries an `Idempotency-Key` (mode, marker, price, UTC day and earlier copies), so a retried request answers the product already made.

**What it creates.** One-time products, tax inclusive (`tax_mode: inclusive`), tax category `saas` (Creem offers `saas`, `digital-goods-service` and `ebooks`; change it in Creem if your accountant prefers another — the assistant doesn't check it). Plus at `PLUS_PRICE`; the gift products at the smallest team pack's price (never charged by the site: each gift checkout sends its own price with `custom_price`).

**What Creem's API allows** (checked in October 2026, [API reference](https://docs.creem.io/api-reference/introduction)): list products ([`GET /v1/products/search`](https://docs.creem.io/api-reference/endpoint/search-products), paginated), read one ([`GET /v1/products/{id}`](https://docs.creem.io/api-reference/endpoint/get-product)), create one ([`POST /v1/products`](https://docs.creem.io/api-reference/endpoint/create-product): name, description, price in cents, currency EUR/USD, `billing_type` onetime, `tax_mode`, `tax_category`; `Idempotency-Key` header; no metadata); list webhooks ([`GET /v1/webhooks`](https://docs.creem.io/api-reference/endpoint/list-webhooks), no secret in the list), create one ([`POST /v1/webhooks`](https://docs.creem.io/api-reference/endpoint/create-webhook): url, name, events; the signing secret is returned on create only) and read its secret ([`GET /v1/webhooks/{id}/secret`](https://docs.creem.io/api-reference/endpoint/get-webhook-secret), used only for the comparison above). See also [Webhooks](https://docs.creem.io/code/webhooks) and [Test mode](https://docs.creem.io/getting-started/test-mode).

**For developers.** `server/creem-setup.js` (plan and apply, `fetch` injectable) and `admin/creem-setup.js` (`mountCreemSetup(container, { call })`). Routes, owner sign-in required: `POST /api/admin/creem/setup/plan` and `POST /api/admin/creem/setup/apply` with `{ confirm: true, mode, create: ['gift-eur', 'webhook', …] }` (`mode` must be the key's mode). Rate limits per worker isolate (`server/admin-limits.js`, module scope): 20 plans and 6 applies per 10 minutes; one apply at a time per isolate. Every Creem call times out after 5 seconds, its answer included. Answers never contain the API key or a signing secret, nor any part of one (`server/secret-scrub.js`: Creem's words are dropped after a 401 or a 403, scrubbed otherwise); the only secret ever answered is the new webhook's, once, in `webhookSecret`. Locally, `node scripts/serve.mjs --api --fake-creem` pretends Creem's store: `FAKE_CREEM_CATALOG=partial` (default), `empty`, `differs` or `full`, and `PUBLIC_BASE_URL=https://…` to let it create the webhook. Tests: `tests/creem-setup.test.js`.
