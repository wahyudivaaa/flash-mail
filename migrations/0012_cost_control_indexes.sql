-- Cost-control indexes: cut D1 rows-read on the hot dashboard / users / inbox paths.
-- users has 377k+ rows with zero secondary indexes; every COUNT(*) and ORDER BY
-- created_at was a full table scan. emails dashboard COUNT(*) filters also lacked
-- matching composite indexes.
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_password_hash ON users(password_hash);
CREATE INDEX IF NOT EXISTS idx_users_password_created ON users(password_hash, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_unread ON emails(deleted_at, is_read);
CREATE INDEX IF NOT EXISTS idx_emails_starred ON emails(deleted_at, is_starred);
CREATE INDEX IF NOT EXISTS idx_emails_archived ON emails(deleted_at, is_archived);
CREATE INDEX IF NOT EXISTS idx_emails_deleted_at ON emails(deleted_at);
