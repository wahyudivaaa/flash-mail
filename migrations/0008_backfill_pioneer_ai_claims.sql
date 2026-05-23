WITH candidate AS (
  SELECT
    e.id,
    e.user_id,
    e.sender,
    e.recipient,
    COALESCE(e.subject, e.parsed_subject, '') AS subject,
    e.received_at,
    lower(
      COALESCE(e.subject, e.parsed_subject, '') || ' ' ||
      COALESCE(e.sender, '') || ' ' ||
      COALESCE(e.parsed_from_email, '') || ' ' ||
      COALESCE(e.parsed_sender, '') || ' ' ||
      COALESCE(e.body_text, '') || ' ' ||
      COALESCE(e.parsed_text, '') || ' ' ||
      COALESCE(e.parsed_html, '')
    ) AS haystack
  FROM emails e
  INNER JOIN users u
    ON u.id = e.user_id
  WHERE e.deleted_at IS NULL
    AND u.password_hash IS NOT NULL
), detected AS (
  SELECT
    id,
    user_id,
    sender,
    recipient,
    subject,
    received_at,
    CASE
      WHEN haystack LIKE '%magic link%' THEN 'magic_link'
      WHEN haystack LIKE '%confirm your pioneer account%' THEN 'confirmed'
      ELSE 'detected'
    END AS status
  FROM candidate
  WHERE (
      haystack LIKE '%fastino.ai%'
      OR haystack LIKE '%pioneer%'
    )
    AND (
      haystack LIKE '%confirm your pioneer account%'
      OR haystack LIKE '%magic link%'
    )
)
INSERT INTO pioneer_ai_claims (
  user_id,
  email_id,
  detected_at,
  detected_subject,
  detected_sender,
  recipient,
  status,
  confirmed_at,
  confirmation_email_id,
  magic_link_at,
  magic_link_email_id
)
SELECT
  user_id,
  id,
  COALESCE(received_at, CURRENT_TIMESTAMP),
  substr(subject, 1, 998),
  substr(sender, 1, 320),
  substr(lower(recipient), 1, 320),
  status,
  CASE WHEN status = 'confirmed' THEN COALESCE(received_at, CURRENT_TIMESTAMP) ELSE '' END,
  CASE WHEN status = 'confirmed' THEN id ELSE '' END,
  CASE WHEN status = 'magic_link' THEN COALESCE(received_at, CURRENT_TIMESTAMP) ELSE '' END,
  CASE WHEN status = 'magic_link' THEN id ELSE '' END
FROM detected
WHERE true
ORDER BY COALESCE(received_at, CURRENT_TIMESTAMP) ASC
ON CONFLICT(user_id) DO UPDATE SET
  email_id = excluded.email_id,
  detected_at = excluded.detected_at,
  detected_subject = excluded.detected_subject,
  detected_sender = excluded.detected_sender,
  recipient = excluded.recipient,
  status = CASE
    WHEN excluded.status = 'magic_link' OR pioneer_ai_claims.status = 'magic_link' THEN 'magic_link'
    WHEN excluded.status = 'confirmed' OR pioneer_ai_claims.status = 'confirmed' THEN 'confirmed'
    ELSE 'detected'
  END,
  confirmed_at = CASE
    WHEN excluded.confirmed_at != '' THEN excluded.confirmed_at
    ELSE pioneer_ai_claims.confirmed_at
  END,
  confirmation_email_id = CASE
    WHEN excluded.confirmation_email_id != '' THEN excluded.confirmation_email_id
    ELSE pioneer_ai_claims.confirmation_email_id
  END,
  magic_link_at = CASE
    WHEN excluded.magic_link_at != '' THEN excluded.magic_link_at
    ELSE pioneer_ai_claims.magic_link_at
  END,
  magic_link_email_id = CASE
    WHEN excluded.magic_link_email_id != '' THEN excluded.magic_link_email_id
    ELSE pioneer_ai_claims.magic_link_email_id
  END;
