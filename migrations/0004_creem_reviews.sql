/* Daily Planner owner API (Cloudflare D1): Creem payments and reviews that may be quoted.
   It does not depend on 0002 or 0003: the four files can be run in any order. Paste into the D1 console as is,
   or apply it with wrangler d1 execute (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one.
   payments: one row per paid Creem checkout (kind plus or gift) for the sales chart; amount is in cents;
   emailed_at is set once the Plus buyer was emailed the activation link.
   reviews: feedback whose author agreed it may be quoted, with an optional name. */
CREATE TABLE IF NOT EXISTS payments (
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
CREATE INDEX IF NOT EXISTS reviews_created ON reviews (created_at);
