CREATE TABLE IF NOT EXISTS kiro_github_claims (
  user_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL UNIQUE,
  authorized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_subject TEXT NOT NULL DEFAULT '',
  detected_sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  github_username TEXT NOT NULL DEFAULT '',
  application_name TEXT NOT NULL DEFAULT 'Kiro',
  connection_url TEXT NOT NULL DEFAULT '',
  security_log_url TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (email_id) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_kiro_github_claims_authorized_at ON kiro_github_claims(authorized_at DESC);
