/* Daily Planner owner API (Cloudflare D1): team kit requests from the landing page.
   Run after 0001. Paste into the D1 console as is, or apply it with wrangler d1 execute
   (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one. */
CREATE TABLE IF NOT EXISTS team_requests (
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
CREATE INDEX IF NOT EXISTS team_requests_created ON team_requests (created_at);
