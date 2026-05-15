WITH candidate AS (
  SELECT
    e.id,
    e.user_id,
    e.sender,
    e.recipient,
    COALESCE(e.subject, e.parsed_subject, '') AS subject,
    e.received_at,
    COALESCE(e.body_text, e.parsed_text, e.parsed_html, '') AS body
  FROM emails e
  WHERE e.deleted_at IS NULL
    AND (
      lower(e.sender) LIKE '%github%'
      OR lower(COALESCE(e.parsed_from_email, '')) LIKE '%github%'
    )
    AND lower(COALESCE(e.body_text, e.parsed_text, e.parsed_html, '')) LIKE '%third-party oauth application%'
    AND lower(COALESCE(e.body_text, e.parsed_text, e.parsed_html, '')) LIKE '%kiro%'
), enriched AS (
  SELECT
    *,
    instr(body, 'Hey ') + 4 AS username_start,
    instr(substr(body, instr(body, 'Hey ') + 4), '!') AS username_length,
    instr(body, 'https://github.com/settings/connections/applications/') AS connection_start,
    instr(body, 'https://github.com/settings/security-log') AS security_start
  FROM candidate
)
INSERT INTO kiro_github_claims (
  user_id,
  email_id,
  authorized_at,
  detected_subject,
  detected_sender,
  recipient,
  github_username,
  application_name,
  connection_url,
  security_log_url
)
SELECT
  user_id,
  id,
  received_at,
  substr(subject, 1, 998),
  substr(sender, 1, 320),
  substr(lower(recipient), 1, 320),
  CASE
    WHEN username_start > 4 AND username_length > 0 THEN lower(substr(body, username_start, username_length - 1))
    ELSE ''
  END,
  'Kiro',
  CASE
    WHEN connection_start > 0 THEN substr(substr(body, connection_start), 1, instr(substr(body, connection_start), char(10)) - 1)
    ELSE ''
  END,
  CASE
    WHEN security_start > 0 THEN substr(substr(body, security_start), 1, instr(substr(body, security_start), char(10)) - 1)
    ELSE ''
  END
FROM enriched
WHERE true
ON CONFLICT(user_id) DO UPDATE SET
  email_id = excluded.email_id,
  authorized_at = excluded.authorized_at,
  detected_subject = excluded.detected_subject,
  detected_sender = excluded.detected_sender,
  recipient = excluded.recipient,
  github_username = excluded.github_username,
  application_name = excluded.application_name,
  connection_url = excluded.connection_url,
  security_log_url = excluded.security_log_url;
