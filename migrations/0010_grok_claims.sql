CREATE TABLE IF NOT EXISTS grok_claims (
  user_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_subject TEXT NOT NULL DEFAULT '',
  detected_sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'detected',
  confirmation_code TEXT NOT NULL DEFAULT '',
  service_name TEXT NOT NULL DEFAULT 'xAI',
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (email_id) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_grok_claims_detected_at ON grok_claims(detected_at DESC);
