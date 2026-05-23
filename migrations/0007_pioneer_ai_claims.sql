CREATE TABLE IF NOT EXISTS pioneer_ai_claims (
  user_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_subject TEXT NOT NULL DEFAULT '',
  detected_sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'detected',
  confirmed_at TEXT NOT NULL DEFAULT '',
  confirmation_email_id TEXT NOT NULL DEFAULT '',
  magic_link_at TEXT NOT NULL DEFAULT '',
  magic_link_email_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (email_id) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_pioneer_ai_claims_detected_at ON pioneer_ai_claims(detected_at DESC);
