/* Daily Planner owner API (Cloudflare D1): Daily Planner Plus team gifts and purchases.
   Any order with the other files. Paste into the D1 console as is, or apply it with wrangler d1 execute
   (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one.
   gifts: one row per gift link; amount is in cents; emailed_at is set once the buyer was emailed.
   purchases: Plus purchases (kind plus) and licences made in the dashboard (kind manual).
   stripe_session keeps its name and holds the checkout reference (a Creem checkout id). */
CREATE TABLE IF NOT EXISTS gifts (
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
CREATE INDEX IF NOT EXISTS purchases_kind ON purchases (kind, created_at);
