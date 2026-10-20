/* Daily Planner owner API (Cloudflare D1): partner commissions and the partner code of team requests.
   It does not depend on the other files: the seven files can be run in any order. Paste into the D1 console as is,
   or apply it with wrangler d1 execute (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one.
   partner_sale_taxes: the tax (VAT or sales tax) included in the amount of a partner sale, in cents, as Creem's order
   gives it (tax_amount), so commissions are worked out on the price before tax; one row per checkout of
   partner_sales. A sale without a row (recorded before this file, or Creem gave no tax) shows its commission on the
   amount paid.
   partner_payouts: the team commissions the owner paid by bank transfer and marked as paid in the dashboard; one row
   per checkout of partner_sales (a team gift); code is the partner's code, amount the commission paid in cents,
   currency the sale's, note the owner's (a transfer reference), paid_at when it was marked. Undo deletes the row.
   team_request_partners: the partner code a team request (team_requests) came with, from the partner's link
   remembered on the requester's browser, so a team order by invoice can earn that partner 10%. Deleted with the
   request. */
CREATE TABLE IF NOT EXISTS partner_sale_taxes (
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
