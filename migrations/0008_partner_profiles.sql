/* Daily Planner owner API (Cloudflare D1): partner statuses (individual or business), private statement link versions
   and visits through partner links. It does not depend on the other files: the eight files can be run in any order.
   Paste into the D1 console as is, or apply it with wrangler d1 execute (see docs/FEEDBACK_AND_WAITLIST.md). Safe to
   run again. Block comments only: the D1 console joins all lines into one.
   partner_profiles: what the owner recorded about a partner in the dashboard, one row per partner. code is the partner
   code in capitals: codes that differ only by case (CAMILLE, Camille) are one partner. status is individual (the
   default, also for a partner with no row: team commissions capped per calendar year, PARTNER_PROGRAM in
   src/lib/pricing.js) or business (a micro-entreprise or a company, any country, paid against an invoice, no cap).
   link_version is the version of the partner's private statement link: 0 at first, one more each time the owner makes
   a new link, which stops the one sent before. updated_at is when the row was last changed. A row is made when the
   owner sets a status, copies a private link or makes a new one. No name, no bank details: never store an IBAN here.
   partner_visits: how many visits came through a partner's link (?ref=CODE), per partner code (in capitals) and UTC
   day. Only a code we know is counted: one with a recorded sale or a row in partner_profiles. A browser counts a code
   once a day at most, and not at all when its visitor switched the anonymous counts off. Daily totals only: no
   identifier, nothing about the visitor. Rows older than about 400 days are deleted as new visits come in. Read by
   the partner's private statement and the dashboard. */
CREATE TABLE IF NOT EXISTS partner_profiles (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'individual',
  link_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_visits (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
);
CREATE INDEX IF NOT EXISTS partner_visits_day ON partner_visits (day);
