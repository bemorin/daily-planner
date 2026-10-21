// Every setting the production deployment reads (1.31), as data: the
// configuration page (admin/configuration/, POST /api/admin/config/check in
// server/admin-config.js) checks each one, and docs/configuration.md lists
// them. tests/config-inventory.test.js reads the code and fails when a
// variable is read that isn't listed here, or when one listed here is never read:
//   - build variables: what scripts/build.mjs reads from its environment,
//     baked into the public runtime-config.js (`runtimeKey`);
//   - Functions variables and secrets: what functions/api/[[path]].js reads and
//     the product ids of server/creem.js (ENV_NAMES);
//   - the D1 binding `DB`.
// One Cloudflare Pages project, one production deployment: preview
// deployments use the project's Preview variables (open the page there to
// check them). Nothing here is a value: names, where they are set, what they
// unlock and how they look.
//
// level: required (a core promise breaks without it: the API, selling and
// activating Plus), recommended (works without it, but something people see
// or you need is missing), optional (blank is a sound default).
// format: how server/admin-config.js recognises a value (never shown).
// generate: a value no service provides, made in the browser on the page.

export const CLOUDFLARE = Object.freeze({
  variables: 'Cloudflare → Workers & Pages → your Pages project → Settings → Variables and Secrets',
  bindings: 'Cloudflare → Workers & Pages → your Pages project → Settings → Bindings',
  redeploy: 'Cloudflare → Workers & Pages → your Pages project → Deployments → the latest production deployment → ⋯ → Retry deployment',
  d1Console: 'Cloudflare → Storage & Databases → D1 SQLite Database → daily-planner → Console',
  d1Name: 'daily-planner'
});

/** The groups of the page, in its order. */
export const CONFIG_GROUPS = Object.freeze([
  Object.freeze({ id: 'build', title: 'Cloudflare Pages — build variables', text: 'Read by scripts/build.mjs while the site is built, and written into the public runtime-config.js: plain text, never a secret. A change counts only after a new deployment.' }),
  Object.freeze({ id: 'functions', title: 'Functions — secrets and variables', text: 'Read by the API (functions/api/[[path]].js) on each request, from the same Variables and Secrets of the Pages project.' }),
  Object.freeze({ id: 'database', title: 'D1 database', text: 'The API’s data, bound as DB. D1 has no extensions and this app has no scheduled jobs (no cron trigger) or private settings in the database, so there is nothing else to check there.' }),
  Object.freeze({ id: 'creem', title: 'Creem', text: 'Payments: the API key, the four products and the webhook, checked with read-only calls to Creem.' }),
  Object.freeze({ id: 'resend', title: 'Resend', text: 'Email: the API key, the sender’s domain and where notifications go.' }),
  Object.freeze({ id: 'plus', title: 'Plus licences', text: 'The key pair that signs licences (on the server) and checks them (in the planner). Replacing it invalidates every licence already issued.' }),
  Object.freeze({ id: 'legal', title: 'Legal pages', text: 'Build variables shown on the legal pages and in the welcome pages’ footer.' })
]);

const v = fields => Object.freeze(fields);

/** Every production setting. `where`: build (scripts/build.mjs), runtime (the Functions) or binding. */
export const CONFIG_VARIABLES = Object.freeze([
  // ---- Build variables -------------------------------------------------------
  v({ name: 'DAILY_PLANNER_API_URL', where: 'build', runtimeKey: 'PLANNER_API_URL', group: 'build', level: 'required', secret: false, type: 'Text', format: 'api-url',
    source: 'Always /api.', unlocks: 'The planner and the landing page talk to this API: purchases, gifts, forms, counts and the privacy notices.', blocks: 'Without it the planner never calls the API: nothing can be bought, activated or sent.' }),
  v({ name: 'DAILY_PLANNER_AFFILIATE_URL', where: 'build', runtimeKey: 'AFFILIATE_URL', group: 'build', level: 'recommended', secret: false, type: 'Text', format: 'url',
    source: 'Creem → Growth → Affiliate Hub → the program’s sign-up link.', unlocks: 'The “Become a partner” button of the partners page.', blocks: 'Without it the button opens the question form instead of Creem’s sign-up.' }),
  v({ name: 'DAILY_PLANNER_GOOGLE_CLIENT_ID', where: 'build', runtimeKey: 'GOOGLE_CLIENT_ID', group: 'build', level: 'optional', secret: false, type: 'Text', format: 'google-client-id',
    source: 'Google Cloud → APIs & Services → Credentials → OAuth client ID (Web application).', unlocks: 'Personal sync through the person’s own Google Drive.', blocks: 'Blank: Personal sync shows nothing and no Google request is made.' }),
  v({ name: 'DAILY_PLANNER_CLOUD_API_URL', where: 'build', runtimeKey: 'CLOUD_API_URL', group: 'build', level: 'optional', secret: false, type: 'Text', format: 'url-or-path',
    source: 'The address of a private workspace service (none exists yet).', unlocks: 'Company workspaces in the planner.', blocks: 'Blank: the planner stays local-first; nothing is missing.' }),
  v({ name: 'DAILY_PLANNER_GITHUB_URL', where: 'build', runtimeKey: 'PROJECT_GITHUB_URL', group: 'build', level: 'optional', secret: false, type: 'Text', format: 'url',
    source: 'Your project page (https://…).', unlocks: 'The project link in the planner and the welcome pages, and feedback through issues when the API is off.', blocks: 'Blank: the link is hidden.' }),
  v({ name: 'DAILY_PLANNER_SPONSOR_URL', where: 'build', runtimeKey: 'GITHUB_SPONSOR_URL', group: 'build', level: 'optional', secret: false, type: 'Text', format: 'url',
    source: 'Your sponsor page (https://…).', unlocks: 'The “Support the project” card in the planner.', blocks: 'Blank: the card is hidden.' }),
  v({ name: 'DAILY_PLANNER_X_URL', where: 'build', runtimeKey: 'SOCIAL_X_URL', group: 'build', level: 'optional', secret: false, type: 'Text', format: 'url',
    source: 'Your X profile (https://…).', unlocks: 'The X link in the footers.', blocks: 'Blank: the link is hidden.' }),
  v({ name: 'DAILY_PLANNER_LINKEDIN_URL', where: 'build', runtimeKey: 'SOCIAL_LINKEDIN_URL', group: 'build', level: 'optional', secret: false, type: 'Text', format: 'url',
    source: 'Your LinkedIn page (https://…).', unlocks: 'The LinkedIn link in the footers.', blocks: 'Blank: the link is hidden.' }),

  // ---- Functions ---------------------------------------------------------------
  v({ name: 'ADMIN_TOKEN', where: 'runtime', group: 'functions', level: 'required', secret: true, type: 'Secret', format: 'admin-token', generate: 'token',
    source: 'Generate a value here, or run npm run admin:secret.', unlocks: 'Signing in to the dashboard and this page; people leaving the waitlist on their own.', blocks: 'Without it every admin route answers 503 and nobody can leave the waitlist from the app. A short token can be guessed.' }),
  v({ name: 'ADMIN_TOTP_SECRET', where: 'runtime', group: 'functions', level: 'recommended', secret: true, type: 'Secret', format: 'totp', generate: 'totp',
    source: 'Generate a value here (or npm run admin:secret), then add it to your authenticator app with “Enter a setup key”.', unlocks: 'An authenticator code at sign-in, on top of the token.', blocks: 'Without it the token alone opens the dashboard. A value that isn’t base32 locks every admin route (503).' }),
  v({ name: 'PUBLIC_BASE_URL', where: 'runtime', group: 'functions', level: 'optional', secret: false, type: 'Text', format: 'base-url',
    source: 'The production address, e.g. https://planner.bemorin.com.', unlocks: 'The address used in emails, gift links and checkout returns.', blocks: 'Blank: https://planner.bemorin.com is used.' }),
  v({ name: 'ALLOWED_ORIGINS', where: 'runtime', group: 'functions', level: 'optional', secret: false, type: 'Text', format: 'origins',
    source: 'Comma-separated origins, e.g. https://example.com (no path, no trailing slash).', unlocks: 'Other sites calling the API from a browser (CORS).', blocks: 'Blank: only this site calls the API, which is all the planner needs.' }),

  // ---- D1 ------------------------------------------------------------------------
  v({ name: 'DB', where: 'binding', group: 'database', level: 'required', secret: false, type: 'D1 database binding', format: 'd1',
    source: 'The D1 database daily-planner, bound with the variable name DB.', unlocks: 'Every /api request: counts, forms, gifts, purchases, the dashboard.', blocks: 'Without it every /api request answers 503.' }),

  // ---- Creem -------------------------------------------------------------------
  v({ name: 'CREEM_API_KEY', where: 'runtime', group: 'creem', level: 'required', secret: true, type: 'Secret', format: 'creem-key',
    source: 'Creem → Developers → API keys (the Test mode switch picks the test or the live key).', unlocks: 'Checkouts, purchases read back from Creem, refunds traced to their purchase.', blocks: 'Without a valid key nothing can be bought online.' }),
  v({ name: 'CREEM_WEBHOOK_SECRET', where: 'runtime', group: 'creem', level: 'required', secret: true, type: 'Secret', format: 'creem-webhook-secret',
    source: 'Creem → Developers → Webhooks → the webhook of /api/creem/webhook → signing secret.', unlocks: 'Signed events from Creem: delivery when a buyer closes the tab, the Plus activation email, refunds and disputes switching Plus off.', blocks: 'Without the right secret the webhook refuses Creem’s events: refunds don’t switch Plus off and buyers who close the tab get no email.' }),
  v({ name: 'CREEM_PLUS_EUR', where: 'runtime', group: 'creem', level: 'required', secret: false, type: 'Text', format: 'creem-product', item: 'plus', currency: 'EUR',
    source: 'Creem → Products → Daily Planner Plus in euros → its id (prod_…).', unlocks: 'Selling Plus in euros (the euro area).', blocks: 'Without it buyers in the euro area can’t buy Plus.' }),
  v({ name: 'CREEM_PLUS_USD', where: 'runtime', group: 'creem', level: 'required', secret: false, type: 'Text', format: 'creem-product', item: 'plus', currency: 'USD',
    source: 'Creem → Products → Daily Planner Plus in dollars → its id (prod_…).', unlocks: 'Selling Plus in dollars (everywhere else).', blocks: 'Without it buyers outside the euro area can’t buy Plus.' }),
  v({ name: 'CREEM_GIFT_EUR', where: 'runtime', group: 'creem', level: 'required', secret: false, type: 'Text', format: 'creem-product', item: 'gift', currency: 'EUR',
    source: 'Creem → Products → Daily Planner Plus gift in euros → its id (prod_…).', unlocks: 'Every gift in euros: Give Plus, Plus Family and the team packs.', blocks: 'Without it no gift can be bought in euros.' }),
  v({ name: 'CREEM_GIFT_USD', where: 'runtime', group: 'creem', level: 'required', secret: false, type: 'Text', format: 'creem-product', item: 'gift', currency: 'USD',
    source: 'Creem → Products → Daily Planner Plus gift in dollars → its id (prod_…).', unlocks: 'Every gift in dollars.', blocks: 'Without it no gift can be bought in dollars.' }),
  v({ name: 'CREEM_TEST_MODE', where: 'runtime', group: 'creem', level: 'optional', secret: false, type: 'Text', format: 'flag',
    source: '1 forces Creem’s test API; not needed with a creem_test_ key.', unlocks: 'Sends every Creem call to the test API.', blocks: 'Leave it blank in production: test mode switches buying off on the production address.' }),

  // ---- Resend ------------------------------------------------------------------
  v({ name: 'RESEND_API_KEY', where: 'runtime', group: 'resend', level: 'recommended', secret: true, type: 'Secret', format: 'resend-key',
    source: 'Resend → API Keys → Create API key (Sending access is enough).', unlocks: 'Every email: the Plus activation link, gift links, refund notices, team request notifications, the waitlist announcement.', blocks: 'Without a valid key nothing is emailed.' }),
  v({ name: 'EMAIL_FROM', where: 'runtime', group: 'resend', level: 'recommended', secret: false, type: 'Text', format: 'sender',
    source: 'The sender, e.g. Daily Planner <hello@yourdomain.com>, on a domain verified in Resend.', unlocks: 'The sender of every email.', blocks: 'Without a valid address on a verified domain nothing is emailed.' }),
  v({ name: 'OWNER_EMAIL', where: 'runtime', group: 'resend', level: 'recommended', secret: false, type: 'Text', format: 'email',
    source: 'Your own inbox.', unlocks: 'Team request notifications, refund notices and test sends; buyers’ replies go there.', blocks: 'Without it you aren’t notified, and no test email can be sent.' }),
  v({ name: 'EMAIL_DAILY_LIMIT', where: 'runtime', group: 'resend', level: 'optional', secret: false, type: 'Text', format: 'count',
    source: 'Your Resend plan’s daily limit, a whole number.', unlocks: 'Caps the emails sent per UTC day.', blocks: 'Blank: 100 a day (Resend’s free plan).' }),

  // ---- Plus ----------------------------------------------------------------------
  v({ name: 'PLUS_SIGNING_KEY', where: 'runtime', group: 'plus', level: 'required', secret: true, type: 'Secret', format: 'plus-signing-key', generate: 'plus-pair',
    source: 'Generate a pair here (offered only while it is missing), or run npm run plus:keys.', unlocks: 'Signing Plus licences, gift links and checkout seals.', blocks: 'Without it Plus is off: no purchase, gift or licence can be delivered.' }),
  v({ name: 'DAILY_PLANNER_PLUS_PUBLIC_KEY', where: 'build', runtimeKey: 'PLUS_PUBLIC_KEY', group: 'plus', level: 'required', secret: false, type: 'Text', format: 'plus-public-key', generate: 'plus-pair',
    source: 'The public key of PLUS_SIGNING_KEY (given here when it doesn’t match).', unlocks: 'The planner checks licences on the device with it.', blocks: 'Without it, or with another pair’s key, Plus can’t be activated in the planner.' }),

  // ---- Legal pages -------------------------------------------------------------
  v({ name: 'DAILY_PLANNER_SUPPORT_EMAIL', where: 'build', runtimeKey: 'SUPPORT_EMAIL', group: 'legal', level: 'recommended', secret: false, type: 'Text', format: 'legal-email',
    source: 'An address on your own domain, e.g. support@yourdomain.com.', unlocks: 'The contact address of the legal notice, the terms and the welcome pages’ footer (and privacy questions, without a privacy address).', blocks: 'Without a plain address, the legal pages and the footers point to the question form instead of an email address.' }),
  v({ name: 'DAILY_PLANNER_PRIVACY_EMAIL', where: 'build', runtimeKey: 'PRIVACY_EMAIL', group: 'legal', level: 'optional', secret: false, type: 'Text', format: 'legal-email',
    source: 'An address for privacy questions, e.g. privacy@yourdomain.com.', unlocks: 'The privacy policy’s and the cookies page’s contact.', blocks: 'Blank: the support address is used.' }),
  v({ name: 'DAILY_PLANNER_LEGAL_PHONE', where: 'build', runtimeKey: 'LEGAL_PHONE', group: 'legal', level: 'recommended', secret: false, type: 'Text', format: 'phone',
    source: 'Your number in international form: + and the country code, then the number without its leading 0, e.g. +33199001234.', unlocks: 'The Phone row of the legal notice (French law asks an individual publisher for one).', blocks: 'Without it the legal notice has no Phone row, which French law asks an individual publisher for.' }),
  v({ name: 'DAILY_PLANNER_LEGAL_ADDRESS', where: 'build', runtimeKey: 'LEGAL_ADDRESS', group: 'legal', level: 'recommended', secret: false, type: 'Text', format: 'text',
    source: 'Your postal address, on one line.', unlocks: 'The Address row of the legal notice and the privacy policy (French law asks for it).', blocks: 'Without it the legal notice and the privacy policy have no Address row, which French law asks for.' }),
  v({ name: 'DAILY_PLANNER_LEGAL_REGISTRATION', where: 'build', runtimeKey: 'LEGAL_REGISTRATION', group: 'legal', level: 'optional', secret: false, type: 'Text', format: 'text',
    source: 'SIRET and/or VAT number, e.g. SIRET 123 456 789 00012.', unlocks: 'A Registration row in the legal notice and the privacy policy.', blocks: 'Blank: no Registration row.' })
]);

/** Bindings Cloudflare Pages gives every Function by itself: never set by hand, never shown as a setting. */
export const PLATFORM_BINDINGS = Object.freeze([
  Object.freeze({ name: 'ASSETS', use: 'The site’s own static files: the checks read the deployed runtime-config.js through it.' })
]);

/**
 * Read on a computer only, by the local tools: never set on Cloudflare.
 * (The dev server, scripts/serve.mjs, also reads the production variables
 * above, so the API behaves locally as in production; scripts/admin-secret.mjs
 * reads ADMIN_TOTP_SECRET and scripts/plus-keys.mjs PLUS_SIGNING_KEY.)
 */
export const LOCAL_VARIABLES = Object.freeze([
  Object.freeze({ name: 'PORT', readBy: 'scripts/serve.mjs', use: 'The dev server’s port (8080 by default; --port wins).' }),
  Object.freeze({ name: 'FAKE_CREEM_CATALOG', readBy: 'scripts/serve.mjs', use: 'With --fake-creem: what the pretend Creem store holds for the setup assistant (partial, empty, differs or full).' }),
  Object.freeze({ name: 'CHROME_BIN', readBy: 'scripts/smoke.mjs', use: 'The Chrome or Chromium the smoke test drives.' }),
  Object.freeze({ name: 'PROGRAMFILES', readBy: 'scripts/smoke.mjs', use: 'Windows: where the smoke test looks for Chrome.' }),
  Object.freeze({ name: 'PROGRAMFILES(X86)', readBy: 'scripts/smoke.mjs', use: 'Windows: where the smoke test looks for Chrome.' })
]);

export const configVariable = name => CONFIG_VARIABLES.find(entry => entry.name === name) || null;

/**
 * The migrations, as their files hold them without the comments (the D1
 * console takes them as they are). tests/config-inventory.test.js checks they
 * match migrations/; the configuration page checks the database has every
 * table, column and index they create, and offers the SQL of a file to paste.
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    file: '0001_planner_api.sql',
    unlocks: 'Anonymous counts, the waitlist and feedback: the dashboard and every form need them.',
    sql: `CREATE TABLE IF NOT EXISTS events (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  app_version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, app_version)
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  devices TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  drive_seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT NOT NULL,
  rating INTEGER,
  kind TEXT NOT NULL DEFAULT 'other',
  message TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_version ON feedback (app_version, created_at);`
  }),
  Object.freeze({
    file: '0002_team_requests.sql',
    unlocks: 'Team requests and questions from the Contact and Teams pages.',
    sql: `CREATE TABLE IF NOT EXISTS team_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL,
  team_size INTEGER NOT NULL,
  timing TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'quote',
  message TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'landing',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_requests_created ON team_requests (created_at);`
  }),
  Object.freeze({
    file: '0003_plus.sql',
    unlocks: 'Gift links and Plus purchases: no gift or purchase can be delivered without them.',
    sql: `CREATE TABLE IF NOT EXISTS gifts (
  code TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL,
  redeemed INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  currency TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  stripe_session TEXT UNIQUE,
  buyer_email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  emailed_at TEXT
);
CREATE INDEX IF NOT EXISTS gifts_created ON gifts (created_at);
CREATE TABLE IF NOT EXISTS purchases (
  stripe_session TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  license_id TEXT NOT NULL DEFAULT '',
  claims INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_kind ON purchases (kind, created_at);`
  }),
  Object.freeze({
    file: '0004_creem_reviews.sql',
    unlocks: 'The sales chart (payments) and reviews that may be quoted.',
    sql: `CREATE TABLE IF NOT EXISTS payments (
  checkout_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  seats INTEGER,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  emailed_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_created ON payments (created_at);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT NOT NULL,
  rating INTEGER,
  text TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_created ON reviews (created_at);`
  }),
  Object.freeze({
    file: '0005_refunds.sql',
    unlocks: 'Refunds and disputes: without it a refund doesn’t switch Plus off.',
    sql: `CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_checkout ON orders (checkout_id);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  order_id TEXT NOT NULL DEFAULT '',
  transaction_id TEXT NOT NULL DEFAULT '',
  checkout_id TEXT NOT NULL DEFAULT '',
  item TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  full_refund INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  revoked TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refunds_created ON refunds (created_at);
CREATE TABLE IF NOT EXISTS revocations (
  target TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  was_active INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target, source)
);
CREATE INDEX IF NOT EXISTS revocations_source ON revocations (source);
CREATE INDEX IF NOT EXISTS revocations_created ON revocations (created_at);`
  }),
  Object.freeze({
    file: '0006_partners.sql',
    unlocks: 'Sales made through a partner’s link (the Partners card).',
    sql: `CREATE TABLE IF NOT EXISTS partner_sales (
  checkout_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  member INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_sales_created ON partner_sales (created_at);
CREATE INDEX IF NOT EXISTS partner_sales_code ON partner_sales (code, created_at);`
  }),
  Object.freeze({
    file: '0007_partner_commissions.sql',
    unlocks: 'Partner commissions: tax per sale, team commissions marked as paid, partner codes of team requests and codes that aren’t partners.',
    sql: `CREATE TABLE IF NOT EXISTS partner_sale_taxes (
  checkout_id TEXT PRIMARY KEY,
  tax INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_payouts (
  checkout_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_payouts_paid ON partner_payouts (paid_at);
CREATE TABLE IF NOT EXISTS team_request_partners (
  request_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_request_partners_code ON team_request_partners (code);
CREATE TABLE IF NOT EXISTS partner_code_rejections (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);`
  })
]);
