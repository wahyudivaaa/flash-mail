CREATE TABLE IF NOT EXISTS netflix_claims (
  user_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_subject TEXT NOT NULL DEFAULT '',
  detected_sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'detected',
  plan_name TEXT NOT NULL DEFAULT '',
  service_provider TEXT NOT NULL DEFAULT '',
  trial_ends_at TEXT NOT NULL DEFAULT '',
  next_billing_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (email_id) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_netflix_claims_detected_at ON netflix_claims(detected_at DESC);
