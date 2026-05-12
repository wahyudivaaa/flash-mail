CREATE TABLE IF NOT EXISTS gmail_dot_alias_usages (
  id TEXT PRIMARY KEY,
  generation_id TEXT,
  source_email TEXT NOT NULL,
  alias_email TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (generation_id) REFERENCES dot_alias_generations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gmail_dot_alias_usages_source ON gmail_dot_alias_usages(source_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_dot_alias_usages_generation ON gmail_dot_alias_usages(generation_id);
