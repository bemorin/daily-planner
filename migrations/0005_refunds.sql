/* Daily Planner owner API (Cloudflare D1): refunds, disputes and revoked Plus licences.
   It does not depend on the other files: the five files can be run in any order. Paste into the D1 console as is,
   or apply it with wrangler d1 execute (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one.
   orders: the Creem order of each paid checkout (Plus or gift), recorded when the checkout completes, so a refund
   (which names only a transaction, whose order Creem gives) can be traced back to what it paid for; mode is the
   checkout's Creem mode (test or live), so a refund from the other mode is never matched to it.
   refunds: each refund.created and dispute.created event from Creem, matched or not; id is Creem's refund or
   dispute id; amount is in cents; full_refund is 1 for a full refund or a dispute; scope is full, completes (a
   partial refund that completed a full one), partial or unclear; item is plus, gift or empty when no purchase
   matched; revoked lists the targets switched off; status is pending while Creem's transaction could not be read
   (note says why, attempts counts the tries, notified is 1 once the owner was told), empty once processed.
   revocations: what no longer gives Plus. target is license:<licence id>, checkout:<checkout id>, order:<order id>
   or gift:<gift ref>; source groups the rows of one decision (a refund or dispute id, or owner_<id> for one made in
   the dashboard), so Restore undoes it; label is what the owner sees (licence id, checkout id, gift code); reason
   refund, dispute or owner; was_active is, for a gift, whether its link was on before it was first revoked. */
CREATE TABLE IF NOT EXISTS orders (
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
CREATE INDEX IF NOT EXISTS revocations_created ON revocations (created_at);
