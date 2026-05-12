-- Alias penerima untuk mailbox eksternal seperti Outlook.com.
-- Email yang masuk ke alias Mail Flare akan disimpan ke user utama.
CREATE TABLE IF NOT EXISTS user_email_aliases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  alias_email TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'mailflare',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_email_aliases_user ON user_email_aliases(user_id);
CREATE INDEX IF NOT EXISTS idx_user_email_aliases_provider ON user_email_aliases(provider, alias_email);
