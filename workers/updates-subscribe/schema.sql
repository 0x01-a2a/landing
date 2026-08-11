CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unsubscribed')),
  source TEXT NOT NULL,
  subscribed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  resend_contact_id TEXT,
  resend_synced_at TEXT
);

CREATE INDEX IF NOT EXISTS subscribers_status_idx ON subscribers (status, subscribed_at);

CREATE TABLE IF NOT EXISTS subscribe_rate_limits (
  ip_hash TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
