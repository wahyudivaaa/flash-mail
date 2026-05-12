CREATE TABLE IF NOT EXISTS dot_alias_generations (
  id TEXT PRIMARY KEY,
  source_email TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mailflare',
  alias_count INTEGER NOT NULL DEFAULT 0,
  total_label TEXT NOT NULL DEFAULT '0',
  truncated INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dot_alias_generation_items (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  alias_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (generation_id) REFERENCES dot_alias_generations(id) ON DELETE CASCADE,
  UNIQUE(generation_id, alias_email)
);

CREATE INDEX IF NOT EXISTS idx_dot_alias_generations_created ON dot_alias_generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dot_alias_generations_source ON dot_alias_generations(source_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dot_alias_generation_items_generation ON dot_alias_generation_items(generation_id, alias_email);
