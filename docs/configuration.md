# Configuration page

**Admin → Configuration** (`/admin/configuration/`, linked from the dashboard's header and its **Setup** card) checks every production setting for real, so you don't have to reread the setup guide ([FEEDBACK_AND_WAITLIST.md](FEEDBACK_AND_WAITLIST.md)). It uses the dashboard's sign-in: the signed 8-hour session of that tab.

**Check everything** asks the server to try each setting with its own service, read-only, with a 5-second timeout per call, all at once. Nothing is changed anywhere and nothing is stored. A secret's value is never shown, not even in part: only whether it is set, its length and the form recognised (“looks like a Creem live key (creem_…), 54 characters”). The answer is scrubbed of every secret before it leaves the server, and a test (`tests/admin-config.test.js`) checks that no secret, nor any 6 characters of one, ever appears in it.

## Reading it

One row per setting, grouped as on Cloudflare:

| State | Meaning |
| --- | --- |
| **OK** | Set, and its service accepted it (or its form is right, when there's nothing more to test). |
| **Problem** | Set, but wrong: the row says what it blocks and the exact fix. |
| **Missing** | Required or recommended, and not set. |
| **Optional, missing** | Not set, and blank is a sound default (the row says what blank means). |
| **Present, not tested** | Set, but the service gave no usable answer, or offers no read-only test (see below). |

**Fix first**, at the top, lists the problems and missing settings: required ones first, then recommended, then optional. Each line jumps to its row, where the fix is written out: the exact path in Cloudflare (**Workers & Pages → your Pages project → Settings → Variables and Secrets → Production**), the variable's name and type (*Secret* or *Text*), then **Retry deployment**; for the database, the SQL of the migration to paste in the D1 console (or the `wrangler` command). Copy buttons sit next to every name, address and SQL. The time of the check is shown; check again once a new deployment is live.

**Generate a value** draws, in your browser (`crypto.getRandomValues`, WebCrypto), the secrets no service gives you: `ADMIN_TOKEN` (48 letters and digits), `ADMIN_TOTP_SECRET` (32 base32 characters, with its `otpauth://` link for an authenticator app) and, only while no usable `PLUS_SIGNING_KEY` is set, a Plus key pair (`PLUS_SIGNING_KEY` with its `DAILY_PLANNER_PLUS_PUBLIC_KEY`). Values are kept nowhere — not sent, not stored — and are gone when you leave the page. Replacing an existing Plus key invalidates every licence already issued: the page never offers it then.

**Copy summary** copies the state of every setting as plain text — states, forms and lengths, never a value — to paste into a conversation with Claude. **Send me a test email** sends one email to `OWNER_EMAIL` through Resend (the dashboard's test send).

## What each check does

| Service | Read-only check |
| --- | --- |
| D1 (`DB`) | `SELECT 1`, then every table, column and index of `migrations/0001…0007` in `sqlite_master`. D1 has no extensions, and this app has no scheduled jobs (no cron trigger) and no private settings in the database: there is nothing else to check. |
| Creem | `CREEM_API_KEY`: `GET /v1/checkouts?checkout_id=` with a made-up id (404 means the key was accepted, 401/403 refused), on the test API when the key is `creem_test_…` or `CREEM_TEST_MODE` is on. Each product: `GET /v1/products/{id}` — currency, one-time, not archived, tax inclusive, and Plus at `PLUS_PRICE` (a gift product's own price is never charged). The webhook: `GET /v1/webhooks`, one for this site's `/api/creem/webhook` with `checkout.completed`, `refund.created` and `dispute.created`, then `GET /v1/webhooks/{id}/secret`, compared on the server, in constant time, with `CREEM_WEBHOOK_SECRET` and never sent back. A test key on the production address is a problem: buying is switched off there. |
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
| `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `EMAIL_DAILY_LIMIT`, `CREEM_TEST_MODE` | optional | no | Functions |

Required means a core promise breaks without it (the API, selling Plus, activating it). Cloudflare also gives every Function the `ASSETS` binding by itself (the site's files); nothing to set.

Read on a computer only, never set on Cloudflare: `PORT` (the dev server's port), `FAKE_CREEM_CATALOG` (the pretend Creem store of `--fake-creem`), `CHROME_BIN`, `PROGRAMFILES` and `PROGRAMFILES(X86)` (where the smoke test finds Chrome). The dev server also reads the production variables above, so the API behaves locally as in production; `npm run admin:secret` reads `ADMIN_TOTP_SECRET` and `npm run plus:keys` reads `PLUS_SIGNING_KEY`.

**For developers.** `server/config-inventory.js` (the list), `server/admin-config.js` (the checks, `fetch` injectable), `POST /api/admin/config/check` (owner sign-in, 10 checks per 10 minutes per worker instance, Cloudflare's rate limiting rule on `/api/` being the real guard), `admin/configuration/` (the page). Locally, `node scripts/serve.mjs --api --fake-email --fake-creem` answers the checks with its pretend Creem and Resend.

## Creem setup assistant

**Admin → Configuration → Set up Creem products** creates in Creem the four products and the webhook the site needs, from the prices in `src/lib/pricing.js`, and gives you the lines to paste into your host. It works with the key in `CREEM_API_KEY`, in its mode: a test key (`creem_test_…`, or `CREEM_TEST_MODE=1`) sets up your test store, a live key your live store. The mode is shown next to the title; in live mode you tick “I understand this creates real products in my live Creem store” before **Create** is possible.

1. **The plan.** When it opens (in the **Creem** group, after the first **Check everything**), the assistant reads your Creem store (read only) and lists, for Plus EUR, Plus USD, Gift EUR, Gift USD and the webhook, what the code needs and what Creem has:
   - **Ready**: the product in `CREEM_…` is right (one-time, tax included, the currency, and for Plus the price of `PLUS_PRICE`).
   - **Found**: a right product is in Creem but your variable doesn't name it yet (made earlier by the assistant, or by hand with the exact name “Daily Planner Plus” / “Daily Planner Plus gift”).
   - **To create**: nothing usable is in Creem.
   - **Differs**: the product exists but is wrong (another price, currency, billing, tax added on top, archived): each difference is listed. The assistant never edits or deletes anything in Creem and creates no second product for it: change it in Creem → Products, then **Check again**. A gift product's own price and a renamed product are only noted (each gift checkout sends its price).
2. **Create the missing products** makes only what is listed as “To create” (it reads Creem again first, so a second click, or a second tab, creates nothing twice). Then:
   - **Environment variables**: `CREEM_PLUS_EUR=prod_…` and the three others, plus `CREEM_TEST_MODE=1` in test mode. Paste them into Cloudflare Pages → Settings → Variables and Secrets, each as **Text**, then redeploy. The lines that change are highlighted. Product ids aren't secrets.
   - **Webhook signing secret · shown once**, when the webhook was just created: copy it into `CREEM_WEBHOOK_SECRET` as a **Secret**, then redeploy. It is not stored anywhere by the site (not on the server, not in the browser) and disappears when you hide it or leave the page; Creem → Developers → Webhooks still shows it if you lose it.
3. Once a webhook exists, the plan says whether `CREEM_WEBHOOK_SECRET` matches its signing secret (the server compares them; neither is ever shown).

**When the webhook must be added by hand.** Creem calls the webhook from the internet, so it needs a public `https` address (`PUBLIC_BASE_URL`, default `https://planner.bemorin.com`, + `/api/creem/webhook`). And Creem only lets a key manage webhooks with the `webhooks:read` and `webhooks:write` scopes: without them the plan says “By hand”. Then add it in Creem → Developers → Webhooks with that URL and the events `checkout.completed`, `refund.created` and `dispute.created`, and copy its signing secret into `CREEM_WEBHOOK_SECRET`.

**How it recognises its own objects.** Creem products have no metadata field in Creem's API, so each product the assistant creates ends its description with a reference such as `Ref. dp-setup:plus-eur` (buyers may see the description on Creem's page). Keep that reference if you edit the description: it is how a second run knows the product already exists. While an active product carries a reference, no other is created for it; archive it in Creem to start again. A webhook is recognised by its URL (two endpoints on one URL would receive every event twice) and is named “Daily Planner · dp-setup”. Each product request also carries an `Idempotency-Key` (mode, product, price and day), so a retried request answers the product already made.

**What it creates.** One-time products, tax inclusive (`tax_mode: inclusive`), tax category `saas` (Creem offers `saas`, `digital-goods-service` and `ebooks`; change it in Creem if your accountant prefers another — the assistant doesn't check it). Plus at `PLUS_PRICE`; the gift products at the smallest team pack's price (never charged by the site: each gift checkout sends its own price with `custom_price`).

**What Creem's API allows** (checked in October 2026, [API reference](https://docs.creem.io/api-reference/introduction)): list products ([`GET /v1/products/search`](https://docs.creem.io/api-reference/endpoint/search-products), paginated), read one ([`GET /v1/products/{id}`](https://docs.creem.io/api-reference/endpoint/get-product)), create one ([`POST /v1/products`](https://docs.creem.io/api-reference/endpoint/create-product): name, description, price in cents, currency EUR/USD, `billing_type` onetime, `tax_mode`, `tax_category`; `Idempotency-Key` header; no metadata); list webhooks ([`GET /v1/webhooks`](https://docs.creem.io/api-reference/endpoint/list-webhooks), no secret in the list), create one ([`POST /v1/webhooks`](https://docs.creem.io/api-reference/endpoint/create-webhook): url, name, events; the signing secret is returned on create only) and read its secret ([`GET /v1/webhooks/{id}/secret`](https://docs.creem.io/api-reference/endpoint/get-webhook-secret), used only for the comparison above). See also [Webhooks](https://docs.creem.io/code/webhooks) and [Test mode](https://docs.creem.io/getting-started/test-mode).

**For developers.** `server/creem-setup.js` (plan and apply, `fetch` injectable) and `admin/creem-setup.js` (`mountCreemSetup(container, { call })`). Routes, owner sign-in required: `POST /api/admin/creem/setup/plan` and `POST /api/admin/creem/setup/apply` with `{ confirm: true, mode, create: ['gift-eur', 'webhook', …] }` (`mode` must be the key's mode). Rate limits per worker instance: 20 plans and 6 applies per 10 minutes; one apply at a time. Every Creem call times out after 5 seconds. Answers never contain the API key or `CREEM_WEBHOOK_SECRET` (scrubbed, even if Creem echoes them); the only secret ever answered is the new webhook's, once, in `webhookSecret`. Locally, `node scripts/serve.mjs --api --fake-creem` pretends Creem's store: `FAKE_CREEM_CATALOG=partial` (default), `empty`, `differs` or `full`, and `PUBLIC_BASE_URL=https://…` to let it create the webhook. Tests: `tests/creem-setup.test.js`.
