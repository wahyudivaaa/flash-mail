ALTER TABLE gpt_plus_claims ADD COLUMN deactivated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE gpt_plus_claims ADD COLUMN deactivated_email_id TEXT NOT NULL DEFAULT '';
ALTER TABLE gpt_plus_claims ADD COLUMN deactivated_subject TEXT NOT NULL DEFAULT '';
ALTER TABLE gpt_plus_claims ADD COLUMN deactivated_sender TEXT NOT NULL DEFAULT '';
