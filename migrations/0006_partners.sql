/* Daily Planner owner API (Cloudflare D1): sales made through a partner's link.
   It does not depend on the other files: the six files can be run in any order. Paste into the D1 console as is,
   or apply it with wrangler d1 execute (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one.
   partner_sales: one row per paid checkout that came through a partner's link (?ref=CODE), recorded when the
   checkout is paid (webhook or claim); code is the partner's code; kind is plus or gift (sent to Creem with the
   code: Creem credits the partner and pays the commission, team gifts included before 1.28) or team (1.28 and
   later: a team gift opened without the code, whose commission the owner pays); plan is the gift bought; amount
   is in cents; member is 1 for a gift sold at the member price; mode is Creem's mode (test or live).
   Nothing about the buyer. Creem's own figures and payouts are in its Affiliate Hub. */
CREATE TABLE IF NOT EXISTS partner_sales (
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
CREATE INDEX IF NOT EXISTS partner_sales_code ON partner_sales (code, created_at);
