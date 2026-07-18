-- Bulk-detect historical Grok/xAI confirmation emails into grok_claims.
-- One claim per user (latest matching email). Active users only.
-- Note: confirmation_code left empty here (D1 rejects complex GLOB); runtime detector fills on new mail / page backfill.

INSERT INTO grok_claims (
  user_id,
  email_id,
  detected_at,
  detected_subject,
  detected_sender,
  recipient,
  status,
  confirmation_code,
  service_name
)
SELECT
  latest.user_id,
  latest.email_id,
  latest.detected_at,
  latest.detected_subject,
  latest.detected_sender,
  latest.recipient,
  latest.status,
  latest.confirmation_code,
  'xAI'
FROM (
  SELECT
    e.user_id AS user_id,
    e.id AS email_id,
    COALESCE(e.received_at, CURRENT_TIMESTAMP) AS detected_at,
    substr(COALESCE(e.subject, e.parsed_subject, ''), 1, 998) AS detected_subject,
    substr(COALESCE(e.parsed_from_email, e.sender, ''), 1, 320) AS detected_sender,
    lower(substr(COALESCE(e.recipient, ''), 1, 320)) AS recipient,
    CASE
      WHEN lower(COALESCE(e.subject, e.parsed_subject, '')) LIKE '%xai confirmation%'
        OR lower(COALESCE(e.subject, e.parsed_subject, '')) LIKE '%confirmation code%'
      THEN 'confirmed'
      ELSE 'detected'
    END AS status,
    CASE
      WHEN instr(COALESCE(e.subject, e.parsed_subject, ''), ' xAI confirmation') > 0
        AND instr(COALESCE(e.subject, e.parsed_subject, ''), '-') = 4
      THEN upper(substr(trim(COALESCE(e.subject, e.parsed_subject, '')), 1, 7))
      WHEN instr(COALESCE(e.subject, e.parsed_subject, ''), ' xai confirmation') > 0
        AND instr(COALESCE(e.subject, e.parsed_subject, ''), '-') = 4
      THEN upper(substr(trim(COALESCE(e.subject, e.parsed_subject, '')), 1, 7))
      ELSE ''
    END AS confirmation_code,
    ROW_NUMBER() OVER (
      PARTITION BY e.user_id
      ORDER BY e.received_at DESC, e.id DESC
    ) AS rn
  FROM emails e
  INNER JOIN users u
    ON u.id = e.user_id
  WHERE e.deleted_at IS NULL
    AND u.password_hash IS NOT NULL
    AND (
      lower(COALESCE(e.sender, '')) LIKE '%x.ai%'
      OR lower(COALESCE(e.parsed_from_email, '')) LIKE '%x.ai%'
      OR lower(COALESCE(e.subject, e.parsed_subject, '')) LIKE '%xai confirmation%'
      OR lower(COALESCE(e.subject, e.parsed_subject, '')) LIKE '%confirmation code%'
    )
    AND (
      lower(COALESCE(e.subject, e.parsed_subject, '')) LIKE '%xai confirmation%'
      OR lower(COALESCE(e.subject, e.parsed_subject, '')) LIKE '%confirmation code%'
    )
) AS latest
WHERE latest.rn = 1
ON CONFLICT(user_id) DO UPDATE SET
  email_id = excluded.email_id,
  detected_at = excluded.detected_at,
  detected_subject = excluded.detected_subject,
  detected_sender = excluded.detected_sender,
  recipient = excluded.recipient,
  status = CASE
    WHEN excluded.status = 'confirmed' OR grok_claims.status = 'confirmed' THEN 'confirmed'
    ELSE 'detected'
  END,
  confirmation_code = CASE
    WHEN excluded.confirmation_code != '' THEN excluded.confirmation_code
    ELSE grok_claims.confirmation_code
  END,
  service_name = CASE
    WHEN excluded.service_name != '' THEN excluded.service_name
    ELSE grok_claims.service_name
  END;
