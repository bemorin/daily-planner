/* Daily Planner owner API (Cloudflare D1): anonymous counts, waitlist, feedback.
   Paste into the D1 console as is, or apply it with wrangler d1 execute
   (see docs/FEEDBACK_AND_WAITLIST.md). Safe to run again.
   Block comments only: the D1 console joins all lines into one. */
CREATE TABLE IF NOT EXISTS events (
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
CREATE INDEX IF NOT EXISTS feedback_version ON feedback (app_version, created_at);
