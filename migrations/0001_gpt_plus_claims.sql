CREATE TABLE IF NOT EXISTS user_initial_credentials (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  initial_password TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'create_user',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gpt_plus_claims (
  user_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detected_subject TEXT NOT NULL DEFAULT '',
  detected_sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'claimed',
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (email_id) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_gpt_plus_claims_claimed_at ON gpt_plus_claims(claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_initial_credentials_email ON user_initial_credentials(email);
