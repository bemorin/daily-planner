/* Daily Planner owner API (Cloudflare D1): partner statuses (individual or business) and visits through partner links.
   It does not depend on the other files: the eight files can be run in any order. Paste into the D1 console as is,
   or apply it with wrangler d1 execute (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one.
   partner_profiles: what the owner recorded about a partner code in the dashboard: status is individual (the
   default, also for a code with no row: team commissions capped per calendar year, PARTNER_PROGRAM in
   src/lib/pricing.js) or business (a micro-entreprise or a company, any country, paid against an invoice, no cap);
   updated_at is when it was last changed. One row per code. No name, no bank details: never store an IBAN here.
   partner_visits: how many visits came through each partner's link (?ref=CODE), per UTC day: a browser counts a
   code once a day at most, and not at all when its visitor switched the anonymous counts off. Daily totals only:
   no identifier, nothing about the visitor. A day takes new codes up to a bound; a code with a sale or a status is
   always counted (server/partners.js). Read by the partner's private statement and the dashboard. */
CREATE TABLE IF NOT EXISTS partner_profiles (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'individual',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS partner_visits (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
);
CREATE INDEX IF NOT EXISTS partner_visits_day ON partner_visits (day);
