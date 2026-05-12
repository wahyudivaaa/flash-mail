import type {
  DashboardDto,
  DotAliasGenerationDto,
  DotAliasUsageDto,
  EmailDetailDto,
  EmailDto,
  GptPlusClaimDto,
  UserDto
} from '$lib/types/dto';
import type { WorkerSettingsPageDto } from '$lib/server/services/worker-settings.service';
import PostalMime from 'postal-mime';

const GPT_PLUS_DEACTIVATION_BACKFILL_INTERVAL_MS = 60_000;
let lastGptPlusDeactivationBackfillAt = 0;

interface CreateUserInput {
  email: string;
  displayName?: string;
  passwordHash?: string;
  initialPassword?: string;
  credentialSource?: string;
  emailAliases?: Array<{
    aliasEmail: string;
    provider?: string;
  }>;
}

interface UpdateUserInput {
  email?: string;
  displayName?: string;
  passwordHash?: string;
}

interface WorkerSettingsUpdateInput {
  botToken?: string;
  webhookSecret?: string;
  allowedIds?: string;
  forwardInbound?: boolean;
  targetMode?: string;
  defaultChatId?: string;
  testChatId?: string;
}

interface UpsertInboundEmailInput {
  emailId: string;
  sender: string;
  recipient: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  receivedAt?: string;
  rawMime?: string;
  contentType?: string;
  headersJson?: string;
}

export interface AuthUserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
}

export interface DeleteUserResult {
  deleted: boolean;
  reason?: 'not_found' | 'has_dependencies';
  emailCount?: number;
  loginSessionCount?: number;
}

export interface SoftDeleteUserResult {
  deleted: boolean;
  reason?: 'not_found' | 'already_deleted' | 'protected_owner';
}

export type EmailQuickAction = 'star' | 'archive' | 'delete';

type EmailQuickActionReason = 'not_found' | 'already_archived' | 'already_deleted';

export interface EmailActionState {
  id: string;
  userId: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  deletedAt: string | null;
}

export interface ApplyEmailQuickActionResult {
  updated: boolean;
  reason?: EmailQuickActionReason;
  email?: EmailActionState;
}

export async function getDashboardMetrics(db?: D1Database): Promise<DashboardDto> {
  if (!db) {
    return dashboardFallback;
  }

  const [users, emails, unread, starred, archived, deleted] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM emails').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM emails WHERE is_read = 0 AND deleted_at IS NULL').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM emails WHERE is_starred = 1 AND deleted_at IS NULL').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM emails WHERE is_archived = 1 AND deleted_at IS NULL').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM emails WHERE deleted_at IS NOT NULL').first<{ count: number }>()
  ]);

  return {
    metrics: [
      { key: 'users', label: 'Pengguna Terdaftar', value: String(users?.count ?? 0), status: 'ok' },
      { key: 'emails', label: 'Data Email', value: String(emails?.count ?? 0), status: 'ok' },
      { key: 'unread', label: 'Email Belum Dibaca', value: String(unread?.count ?? 0), status: 'warning' },
      { key: 'starred', label: 'Ditandai Admin', value: String(starred?.count ?? 0), status: 'ok' },
      { key: 'archived', label: 'Diarsipkan', value: String(archived?.count ?? 0), status: 'ok' },
      { key: 'deleted', label: 'Dihapus Sementara', value: String(deleted?.count ?? 0), status: 'critical' }
    ]
  };
}

export async function getUsersFromDb(db?: D1Database): Promise<UserDto[]> {
  if (!db) {
    return usersFallback;
  }

  await backfillRecentGptPlusDeactivationsFromDb(db);

  const query = `
    WITH owner AS (
      SELECT id AS owner_id
      FROM users
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
    SELECT
      u.id,
      u.email,
      COALESCE(u.display_name, u.email) AS display_name,
      CASE
        WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
        ELSE 'member'
      END AS role
      ,
      CASE
        WHEN u.password_hash IS NULL THEN 'disabled'
        ELSE 'active'
      END AS status,
      CASE WHEN g.user_id IS NULL THEN 0 ELSE 1 END AS gpt_plus_claimed,
      COALESCE(g.claimed_at, '') AS gpt_plus_claimed_at,
      COALESCE(g.status, '') AS gpt_plus_status,
      COALESCE(c.initial_password, '') AS initial_password,
      COALESCE(MAX(a.alias_email), '') AS outlook_forwarding_address,
      COUNT(DISTINCT e.id) AS total_emails,
      COUNT(DISTINCT CASE WHEN e.is_read = 0 THEN e.id END) AS unread_emails
    FROM users u
    LEFT JOIN gpt_plus_claims g
      ON g.user_id = u.id
    LEFT JOIN user_initial_credentials c
      ON c.user_id = u.id
    LEFT JOIN user_email_aliases a
      ON a.user_id = u.id
      AND a.provider IN ('outlook_forward', 'gmail_forward')
    LEFT JOIN emails e
      ON e.user_id = u.id
      AND e.deleted_at IS NULL
    WHERE u.password_hash IS NOT NULL
    GROUP BY u.id, u.email, u.display_name, u.password_hash, g.user_id, g.claimed_at, g.status, c.initial_password
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT 100
  `;
  let results: Record<string, unknown>[] | undefined;
  try {
    const response = await db.prepare(query).all<Record<string, unknown>>();
    results = response.results;
  } catch (error) {
    if (
      !isMissingOptionalTableError(error, 'gpt_plus_claims') &&
      !isMissingOptionalTableError(error, 'user_initial_credentials') &&
      !isMissingOptionalTableError(error, 'user_email_aliases')
    ) {
      throw error;
    }
    return getUsersWithoutGptClaimsFromDb(db);
  }

  return (results ?? []).map((row) => mapUserRow(row));
}

export async function getUserByIdFromDb(db: D1Database | undefined, userId: string): Promise<UserDto | null> {
  if (!db) {
    return usersFallback.find((user) => user.id === userId) ?? null;
  }

  let row: Record<string, unknown> | null;
  try {
    row = await db
      .prepare(
        `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        CASE
          WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
          ELSE 'member'
        END AS role,
        CASE
          WHEN u.password_hash IS NULL THEN 'disabled'
          ELSE 'active'
        END AS status,
        CASE WHEN g.user_id IS NULL THEN 0 ELSE 1 END AS gpt_plus_claimed,
        COALESCE(g.claimed_at, '') AS gpt_plus_claimed_at,
        COALESCE(g.status, '') AS gpt_plus_status,
        COALESCE(
          (
            SELECT a.alias_email
            FROM user_email_aliases a
            WHERE a.user_id = u.id
              AND a.provider IN ('outlook_forward', 'gmail_forward')
            ORDER BY a.created_at ASC
            LIMIT 1
          ),
          ''
        ) AS outlook_forwarding_address,
        (
          SELECT COUNT(*)
          FROM emails e
          WHERE e.user_id = u.id
            AND e.deleted_at IS NULL
        ) AS total_emails,
        (
          SELECT COUNT(*)
          FROM emails e
          WHERE e.user_id = u.id
            AND e.deleted_at IS NULL
            AND e.is_read = 0
        ) AS unread_emails
      FROM users u
      LEFT JOIN gpt_plus_claims g
        ON g.user_id = u.id
      WHERE u.id = ?
      LIMIT 1
    `
      )
      .bind(userId)
      .first<Record<string, unknown>>();
  } catch (error) {
    if (!isMissingOptionalTableError(error, 'gpt_plus_claims') && !isMissingOptionalTableError(error, 'user_email_aliases')) {
      throw error;
    }
    return getUserByIdWithoutGptClaimsFromDb(db, userId);
  }

  let resolvedRow = row;
  if (!resolvedRow) {
    return null;
  }

  return mapUserRow(resolvedRow);
}

async function getUsersWithoutGptClaimsFromDb(db: D1Database): Promise<UserDto[]> {
  let results: Record<string, unknown>[] | undefined;
  try {
    const response = await db
      .prepare(
        `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        CASE
          WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
          ELSE 'member'
        END AS role,
        CASE
          WHEN u.password_hash IS NULL THEN 'disabled'
          ELSE 'active'
        END AS status,
        COALESCE(c.initial_password, '') AS initial_password,
        COALESCE(MAX(a.alias_email), '') AS outlook_forwarding_address,
        COUNT(DISTINCT e.id) AS total_emails,
        COUNT(DISTINCT CASE WHEN e.is_read = 0 THEN e.id END) AS unread_emails
      FROM users u
      LEFT JOIN user_initial_credentials c
        ON c.user_id = u.id
      LEFT JOIN user_email_aliases a
        ON a.user_id = u.id
        AND a.provider IN ('outlook_forward', 'gmail_forward')
      LEFT JOIN emails e
        ON e.user_id = u.id
        AND e.deleted_at IS NULL
      WHERE u.password_hash IS NOT NULL
      GROUP BY u.id, u.email, u.display_name, u.password_hash, c.initial_password
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT 100
    `
      )
      .all<Record<string, unknown>>();
    results = response.results;
  } catch (error) {
    if (!isMissingOptionalTableError(error, 'user_initial_credentials') && !isMissingOptionalTableError(error, 'user_email_aliases')) {
      throw error;
    }
    return getUsersWithoutOptionalUserTablesFromDb(db);
  }

  return (results ?? []).map((row) => ({
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role ?? 'member'),
    status: String(row.status ?? 'active') === 'disabled' ? 'disabled' : 'active',
    gptPlusClaimed: false,
    gptPlusClaimedAt: '',
    gptPlusStatus: undefined,
    gptPlusDeactivatedAt: '',
    gptPlusDeactivationEmailId: '',
    initialPassword: String(row.initial_password ?? ''),
    outlookForwardingAddress: String(row.outlook_forwarding_address ?? ''),
    totalEmails: Number(row.total_emails ?? 0),
    unreadEmails: Number(row.unread_emails ?? 0)
  }));
}

async function getUsersWithoutOptionalUserTablesFromDb(db: D1Database): Promise<UserDto[]> {
  const { results } = await db
    .prepare(
      `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        CASE
          WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
          ELSE 'member'
        END AS role,
        CASE
          WHEN u.password_hash IS NULL THEN 'disabled'
          ELSE 'active'
        END AS status,
        COUNT(e.id) AS total_emails,
        SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unread_emails
      FROM users u
      LEFT JOIN emails e
        ON e.user_id = u.id
        AND e.deleted_at IS NULL
      WHERE u.password_hash IS NOT NULL
      GROUP BY u.id, u.email, u.display_name, u.password_hash
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT 100
    `
    )
    .all<Record<string, unknown>>();

  return (results ?? []).map((row) => ({
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role ?? 'member'),
    status: String(row.status ?? 'active') === 'disabled' ? 'disabled' : 'active',
    gptPlusClaimed: false,
    gptPlusClaimedAt: '',
    gptPlusStatus: undefined,
    gptPlusDeactivatedAt: '',
    gptPlusDeactivationEmailId: '',
    initialPassword: '',
    outlookForwardingAddress: '',
    totalEmails: Number(row.total_emails ?? 0),
    unreadEmails: Number(row.unread_emails ?? 0)
  }));
}

async function getUserByIdWithoutGptClaimsFromDb(db: D1Database, userId: string): Promise<UserDto | null> {
  const row = await db
    .prepare(
      `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        CASE
          WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
          ELSE 'member'
        END AS role,
        CASE
          WHEN u.password_hash IS NULL THEN 'disabled'
          ELSE 'active'
        END AS status,
        (
          SELECT COUNT(*)
          FROM emails e
          WHERE e.user_id = u.id
            AND e.deleted_at IS NULL
        ) AS total_emails,
        (
          SELECT COUNT(*)
          FROM emails e
          WHERE e.user_id = u.id
            AND e.deleted_at IS NULL
            AND e.is_read = 0
        ) AS unread_emails
      FROM users u
      WHERE u.id = ?
      LIMIT 1
    `
    )
    .bind(userId)
    .first<Record<string, unknown>>();

  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role ?? 'member'),
    status: String(row.status ?? 'active') === 'disabled' ? 'disabled' : 'active',
    gptPlusClaimed: false,
    gptPlusClaimedAt: '',
    gptPlusStatus: undefined,
    gptPlusDeactivatedAt: '',
    gptPlusDeactivationEmailId: '',
    outlookForwardingAddress: '',
    totalEmails: Number(row.total_emails ?? 0),
    unreadEmails: Number(row.unread_emails ?? 0)
  };
}

function mapUserRow(row: Record<string, unknown>): UserDto {
  const gptPlusClaimed = Number(row.gpt_plus_claimed ?? 0) === 1;
  const gptPlusStatus = normalizeGptPlusStatus(String(row.gpt_plus_status ?? ''), gptPlusClaimed);

  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role ?? 'member'),
    status: String(row.status ?? 'active') === 'disabled' ? 'disabled' : 'active',
    gptPlusClaimed,
    gptPlusClaimedAt: String(row.gpt_plus_claimed_at ?? ''),
    gptPlusStatus,
    gptPlusDeactivatedAt: String(row.gpt_plus_deactivated_at ?? ''),
    gptPlusDeactivationEmailId: String(row.gpt_plus_deactivation_email_id ?? ''),
    initialPassword: String(row.initial_password ?? ''),
    outlookForwardingAddress: String(row.outlook_forwarding_address ?? ''),
    totalEmails: Number(row.total_emails ?? 0),
    unreadEmails: Number(row.unread_emails ?? 0)
  };
}

function normalizeGptPlusStatus(value: string, hasClaim: boolean): UserDto['gptPlusStatus'] {
  if (value.toLowerCase() === 'deactivated') {
    return 'deactivated';
  }
  return hasClaim ? 'claimed' : undefined;
}

export async function getUserAuthByEmail(db: D1Database | undefined, email: string): Promise<AuthUserRecord | null> {
  if (!db) {
    return null;
  }

  const row = await db
    .prepare(
      `
      SELECT
        id,
        email,
        COALESCE(display_name, email) AS display_name,
        password_hash
      FROM users
      WHERE lower(email) = lower(?)
      LIMIT 1
    `
    )
    .bind(email)
    .first<Record<string, unknown>>();

  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    passwordHash: row.password_hash ? String(row.password_hash) : null
  };
}

export async function upsertInboundEmailInDb(
  db: D1Database | undefined,
  input: UpsertInboundEmailInput
): Promise<{ stored: boolean; reason?: string }> {
  if (!db) {
    throw new Error('DB binding is required for inbound email upsert');
  }

  const emailId = input.emailId.trim();
  const sender = input.sender.trim();
  const recipient = input.recipient.trim().toLowerCase();
  if (!emailId || !sender || !recipient) {
    return { stored: false, reason: 'invalid_input' };
  }

  const userId = await resolveInboundUserId(db, recipient);
  if (!userId) {
    return { stored: false, reason: 'recipient_not_found' };
  }

  const subject = (input.subject?.trim() || '(Tanpa Subjek)').slice(0, 998);
  const snippet = (
    input.snippet?.trim() ||
    `Email masuk dari ${sender} ke ${recipient} pada ${new Date().toISOString()}`
  ).slice(0, 2000);
  const rawMimeInput = normalizeRawMimeInput(input.rawMime ?? '');
  const rawMime =
    rawMimeInput.trim() ||
    `Dari: ${sender}\nKe: ${recipient}\nSubjek: ${subject}\nTanggal: ${new Date().toUTCString()}\n\n${snippet}`;
  const contentType = (input.contentType?.trim() || '').slice(0, 255);
  const headersJson = (input.headersJson?.trim() || '').slice(0, 30000);
  const headers = parseHeadersJson(headersJson);
  const contentTypeHeader = pickHeader(headers, 'content-type') || contentType;
  const transferEncodingHeader = pickHeader(headers, 'content-transfer-encoding');
  const fromHeader = pickHeader(headers, 'from') || sender;
  const toHeader = pickHeader(headers, 'to') || recipient;
  const ccHeader = pickHeader(headers, 'cc');
  const bccHeader = pickHeader(headers, 'bcc');
  const replyToHeader = pickHeader(headers, 'reply-to');
  const senderHeader = pickHeader(headers, 'sender');
  const returnPathHeader = pickHeader(headers, 'return-path');
  const inReplyToHeader = pickHeader(headers, 'in-reply-to');
  const referencesHeader = pickHeader(headers, 'references');
  const authResultsHeader = pickHeader(headers, 'authentication-results');
  const spamScoreHeader = pickHeader(headers, 'x-spam-score');
  const receivedChainHeader = pickHeader(headers, 'received');
  const dateHeader = pickHeader(headers, 'date') || input.receivedAt || '';
  const fromMailbox = parseMailboxHeader(fromHeader);
  const senderMailbox = parseMailboxHeader(senderHeader);
  const replyToMailbox = parseMailboxHeader(replyToHeader);
  const returnPathMailbox = parseMailboxHeader(returnPathHeader);
  const parsedCharset = parseHeaderParam(contentTypeHeader, 'charset').slice(0, 120);
  const parsedBoundary = parseHeaderParam(contentTypeHeader, 'boundary').slice(0, 255);
  const parser = new PostalMime();
  let parsedMimeHtml = '';
  let parsedMimeText = '';
  try {
    const parsedMime = await parser.parse(rawMime);
    parsedMimeHtml = parsedMime.html || '';
    parsedMimeText = parsedMime.text || (parsedMimeHtml ? htmlToPlainText(parsedMimeHtml) : '');
  } catch {
    parsedMimeHtml = '';
    parsedMimeText = '';
  }
  const fallbackMime = extractBestBodyFromRawMime(rawMime, contentTypeHeader, transferEncodingHeader, parsedBoundary);
  const preferFallback = looksLikeRawMimeLeak(parsedMimeText, parsedBoundary);
  const resolvedHtml = preferFallback ? fallbackMime.html || parsedMimeHtml : parsedMimeHtml || fallbackMime.html;
  const resolvedText = preferFallback
    ? fallbackMime.text || (resolvedHtml ? htmlToPlainText(resolvedHtml) : '')
    : parsedMimeText || fallbackMime.text || (resolvedHtml ? htmlToPlainText(resolvedHtml) : '');

  const parsedHtml = resolvedHtml.slice(0, 50000);
  const parsedText = resolvedText;
  const bodyText = (parsedText || input.bodyText?.trim() || snippet).slice(0, 20000);
  const parsedTextAsHtml = parsedHtml ? '' : textToSimpleHtml(bodyText).slice(0, 50000);
  const rawSize = rawMime.length;
  const receivedAt = input.receivedAt?.trim() || new Date().toISOString();

  await db
    .prepare(
      `
      INSERT INTO emails (
        id,
        user_id,
        message_id,
        sender,
        recipient,
        subject,
        snippet,
        received_at,
        is_read,
        is_starred,
        is_archived,
        raw_size,
        body_text,
        raw_mime,
        headers_json,
        parsed_message_id,
        parsed_from_email,
        parsed_subject,
        parsed_text,
        parsed_delivered_to,
        parsed_headers,
        parsed_date,
        parsed_content_type,
        parsed_charset,
        parsed_boundary
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        sender = excluded.sender,
        recipient = excluded.recipient,
        subject = excluded.subject,
        snippet = excluded.snippet,
        body_text = excluded.body_text,
        raw_size = excluded.raw_size,
        raw_mime = excluded.raw_mime,
        headers_json = excluded.headers_json,
        parsed_message_id = excluded.parsed_message_id,
        parsed_from_email = excluded.parsed_from_email,
        parsed_subject = excluded.parsed_subject,
        parsed_text = excluded.parsed_text,
        parsed_delivered_to = excluded.parsed_delivered_to,
        parsed_headers = excluded.parsed_headers,
        parsed_date = excluded.parsed_date,
        parsed_content_type = excluded.parsed_content_type,
        parsed_charset = excluded.parsed_charset,
        parsed_boundary = excluded.parsed_boundary
    `
    )
    .bind(
      emailId,
      userId,
      emailId,
      sender,
      recipient,
      subject,
      snippet,
      dateHeader || receivedAt,
      rawSize,
      bodyText,
      rawMime,
      headersJson,
      emailId,
      sender,
      subject,
      bodyText,
      recipient,
      headersJson,
      receivedAt,
      contentTypeHeader,
      parsedCharset,
      parsedBoundary
    )
    .run();

  await db
    .prepare(
      `
      UPDATE emails
      SET
        parsed_in_reply_to = ?,
        parsed_references = ?,
        parsed_from_name = ?,
        parsed_from_email = ?,
        parsed_sender = ?,
        parsed_reply_to = ?,
        parsed_return_path = ?,
        parsed_to = ?,
        parsed_cc = ?,
        parsed_bcc = ?,
        parsed_html = ?,
        parsed_text_as_html = ?,
        parsed_spam_score = ?,
        parsed_auth_results = ?,
        parsed_received_chain = ?
      WHERE id = ?
    `
    )
    .bind(
      truncateNullable(inReplyToHeader, 998),
      truncateNullable(referencesHeader, 5000),
      truncateNullable(fromMailbox.name, 255),
      truncateNullable(fromMailbox.email || sender, 320),
      truncateNullable(senderMailbox.email || senderHeader, 320),
      truncateNullable(replyToMailbox.email || replyToHeader, 320),
      truncateNullable(returnPathMailbox.email || returnPathHeader, 320),
      truncateNullable(toHeader, 2000),
      truncateNullable(ccHeader, 2000),
      truncateNullable(bccHeader, 2000),
      truncateNullable(parsedHtml, 50000),
      truncateNullable(parsedTextAsHtml, 50000),
      truncateNullable(spamScoreHeader, 120),
      truncateNullable(authResultsHeader, 5000),
      truncateNullable(receivedChainHeader, 30000),
      emailId
    )
    .run();

  await detectAndStoreGptPlusClaim(db, {
    userId,
    emailId,
    sender,
    recipient,
    subject,
    snippet,
    bodyText,
    bodyHtml: parsedHtml,
    parsedSubject: subject,
    parsedSender: fromMailbox.email || sender,
    receivedAt
  });

  return { stored: true };
}

async function resolveInboundUserId(db: D1Database, recipient: string): Promise<string> {
  const normalizedRecipient = recipient.trim().toLowerCase();
  const directUser = await db
    .prepare('SELECT id FROM users WHERE lower(email) = ? AND password_hash IS NOT NULL LIMIT 1')
    .bind(normalizedRecipient)
    .first<{ id: string | null }>();
  const directUserId = String(directUser?.id ?? '').trim();
  if (directUserId) {
    return directUserId;
  }

  try {
    const aliasUser = await db
      .prepare(
        `
        SELECT u.id
        FROM user_email_aliases a
        INNER JOIN users u
          ON u.id = a.user_id
        WHERE lower(a.alias_email) = ?
          AND u.password_hash IS NOT NULL
        LIMIT 1
      `
      )
      .bind(normalizedRecipient)
      .first<{ id: string | null }>();
    return String(aliasUser?.id ?? '').trim();
  } catch (error) {
    if (isMissingOptionalTableError(error, 'user_email_aliases')) {
      return '';
    }
    throw error;
  }
}

interface StoreInitialCredentialInput {
  userId: string;
  email: string;
  initialPassword: string;
  source?: string;
}

interface StoreEmailAliasInput {
  userId: string;
  aliasEmail: string;
  provider?: string;
}

interface StoreEmailAliasBatchResult {
  savedAliases: string[];
  createdAliases: string[];
  existingAliases: string[];
  skippedAliases: string[];
}

export interface ActivateDotAliasGenerationItemResult extends StoreEmailAliasBatchResult {
  activated: boolean;
  mode?: 'gmail' | 'mailflare';
  reason?:
    | 'missing_table'
    | 'not_found'
    | 'alias_not_found'
    | 'source_user_not_found'
    | 'source_user_disabled'
    | 'alias_taken';
  sourceEmail: string;
  aliasEmail: string;
}

export interface DeactivateDotAliasGenerationItemResult {
  deactivated: boolean;
  mode?: 'gmail' | 'mailflare';
  reason?:
    | 'missing_table'
    | 'not_found'
    | 'alias_not_found'
    | 'alias_not_active'
    | 'source_user_not_found'
    | 'protected_alias';
  sourceEmail: string;
  aliasEmail: string;
  removedAliases: string[];
}

interface DetectGptPlusClaimInput {
  userId: string;
  emailId: string;
  sender: string;
  recipient: string;
  subject: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  parsedSubject?: string;
  parsedSender?: string;
  receivedAt?: string;
}

export async function storeInitialCredentialInDb(db: D1Database, input: StoreInitialCredentialInput): Promise<void> {
  const userId = input.userId.trim();
  const email = input.email.trim().toLowerCase();
  const initialPassword = input.initialPassword.trim();
  const source = (input.source?.trim() || 'create_user').slice(0, 80);
  if (!userId || !email || !initialPassword) {
    return;
  }

  try {
    await db
      .prepare(
        `
      INSERT INTO user_initial_credentials (user_id, email, initial_password, source, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO NOTHING
    `
      )
      .bind(userId, email, initialPassword, source)
      .run();
  } catch (error) {
    if (!isMissingOptionalTableError(error, 'user_initial_credentials')) {
      throw error;
    }
  }
}

export async function storeUserEmailAliasInDb(db: D1Database, input: StoreEmailAliasInput): Promise<void> {
  const userId = input.userId.trim();
  const aliasEmail = input.aliasEmail.trim().toLowerCase();
  const provider = (input.provider?.trim() || 'mailflare').slice(0, 80);
  if (!userId || !aliasEmail) {
    return;
  }

  await db
    .prepare(
      `
      INSERT INTO user_email_aliases (id, user_id, alias_email, provider, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(alias_email) DO UPDATE SET
        user_id = excluded.user_id,
        provider = excluded.provider
    `
    )
    .bind(crypto.randomUUID(), userId, aliasEmail, provider)
    .run();
}

export async function getUserEmailAliasesInDb(
  db: D1Database | undefined,
  userId: string,
  provider?: string
): Promise<string[]> {
  const normalizedUserId = userId.trim();
  const normalizedProvider = provider?.trim();
  if (!db || !normalizedUserId) {
    return [];
  }

  try {
    const response = normalizedProvider
      ? await db
          .prepare(
            `
            SELECT alias_email
            FROM user_email_aliases
            WHERE user_id = ?
              AND provider = ?
            ORDER BY created_at ASC, alias_email ASC
          `
          )
          .bind(normalizedUserId, normalizedProvider)
          .all<{ alias_email: string }>()
      : await db
          .prepare(
            `
            SELECT alias_email
            FROM user_email_aliases
            WHERE user_id = ?
            ORDER BY created_at ASC, alias_email ASC
          `
          )
          .bind(normalizedUserId)
          .all<{ alias_email: string }>();

    return (response.results ?? []).map((row) => String(row.alias_email ?? '').trim().toLowerCase()).filter(Boolean);
  } catch (error) {
    if (isMissingOptionalTableError(error, 'user_email_aliases')) {
      return [];
    }
    throw error;
  }
}

export async function getUserEmailAliasesByEmailInDb(
  db: D1Database | undefined,
  email: string,
  provider?: string
): Promise<string[]> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!db || !normalizedEmail) {
    return [];
  }

  try {
    const row = await db
      .prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1')
      .bind(normalizedEmail)
      .first<{ id: string }>();
    return row?.id ? getUserEmailAliasesInDb(db, String(row.id), provider) : [];
  } catch (error) {
    if (isMissingOptionalTableError(error, 'user_email_aliases')) {
      return [];
    }
    throw error;
  }
}

export async function storeUserEmailAliasesIfAvailableInDb(
  db: D1Database,
  input: {
    userId: string;
    aliases: string[];
    provider?: string;
  }
): Promise<StoreEmailAliasBatchResult> {
  const userId = input.userId.trim();
  const provider = (input.provider?.trim() || 'mailflare').slice(0, 80);
  const aliases = [...new Set(input.aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
  if (!userId) {
    throw new Error('Invalid alias input');
  }

  const result: StoreEmailAliasBatchResult = {
    savedAliases: [],
    createdAliases: [],
    existingAliases: [],
    skippedAliases: []
  };

  for (const aliasEmail of aliases) {
    const directUser = await db
      .prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1')
      .bind(aliasEmail)
      .first<{ id: string }>();
    if (directUser?.id && String(directUser.id) !== userId) {
      result.skippedAliases.push(aliasEmail);
      continue;
    }

    const insertResult = await db
      .prepare(
        `
        INSERT INTO user_email_aliases (id, user_id, alias_email, provider, created_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(alias_email) DO NOTHING
      `
      )
      .bind(crypto.randomUUID(), userId, aliasEmail, provider)
      .run();

    const owner = await db
      .prepare('SELECT user_id FROM user_email_aliases WHERE lower(alias_email) = ? LIMIT 1')
      .bind(aliasEmail)
      .first<{ user_id: string }>();
    if (String(owner?.user_id ?? '') !== userId) {
      result.skippedAliases.push(aliasEmail);
      continue;
    }

    result.savedAliases.push(aliasEmail);
    if (Number(insertResult.meta?.changes ?? 0) > 0) {
      result.createdAliases.push(aliasEmail);
    } else {
      result.existingAliases.push(aliasEmail);
    }
  }

  return result;
}

export async function getDotAliasGenerationsFromDb(db: D1Database | undefined): Promise<DotAliasGenerationDto[]> {
  if (!db) {
    return [];
  }

  try {
    const response = await db
      .prepare(
        `
        SELECT
          id,
          source_email,
          provider,
          alias_count,
          total_label,
          truncated,
          COALESCE(created_by, '') AS created_by,
          created_at
        FROM dot_alias_generations
        ORDER BY created_at DESC, id DESC
        LIMIT 40
      `
      )
      .all<Record<string, unknown>>();

    const generations = response.results ?? [];
    const generationEntries = await Promise.all(
      generations.map(async (row) => {
        const id = String(row.id ?? '');
        const aliases = await getDotAliasGenerationItemsFromDb(db, id);
        return { row, aliases };
      })
    );
    const usageMap = await getDotAliasUsageMapFromDb(
      db,
      generationEntries.flatMap((generation) => generation.aliases)
    );

    return generationEntries.map(({ row, aliases }) => mapDotAliasGenerationRow(row, aliases, usageMap));
  } catch (error) {
    if (
      isMissingOptionalTableError(error, 'dot_alias_generations') ||
      isMissingOptionalTableError(error, 'dot_alias_generation_items')
    ) {
      return [];
    }
    throw error;
  }
}

export async function storeDotAliasGenerationInDb(
  db: D1Database,
  input: {
    sourceEmail: string;
    provider: string;
    aliases: string[];
    totalLabel: string;
    truncated: boolean;
    createdBy?: string;
  }
): Promise<DotAliasGenerationDto> {
  const sourceEmail = input.sourceEmail.trim().toLowerCase();
  const provider = (input.provider.trim() || 'mailflare').slice(0, 80);
  const aliases = [...new Set(input.aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
  const totalLabel = input.totalLabel.trim() || String(aliases.length);
  const createdBy = input.createdBy?.trim() ?? '';
  if (!sourceEmail || aliases.length === 0) {
    throw new Error('Invalid dot alias input');
  }

  const id = crypto.randomUUID();

  try {
    await db
      .prepare(
        `
        INSERT INTO dot_alias_generations (
          id,
          source_email,
          provider,
          alias_count,
          total_label,
          truncated,
          created_by,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
      )
      .bind(id, sourceEmail, provider, aliases.length, totalLabel, input.truncated ? 1 : 0, createdBy || null)
      .run();

    for (const alias of aliases) {
      await db
        .prepare(
          `
          INSERT INTO dot_alias_generation_items (id, generation_id, alias_email, created_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(generation_id, alias_email) DO NOTHING
        `
        )
        .bind(crypto.randomUUID(), id, alias)
        .run();
    }
  } catch (error) {
    if (
      isMissingOptionalTableError(error, 'dot_alias_generations') ||
      isMissingOptionalTableError(error, 'dot_alias_generation_items')
    ) {
      throw new Error('Tabel riwayat dot alias belum ada. Jalankan migration 0004_dot_alias_generations.sql.');
    }
    throw error;
  }

  const created = await db
    .prepare(
      `
      SELECT
        id,
        source_email,
        provider,
        alias_count,
        total_label,
        truncated,
        COALESCE(created_by, '') AS created_by,
        created_at
      FROM dot_alias_generations
      WHERE id = ?
      LIMIT 1
    `
    )
      .bind(id)
      .first<Record<string, unknown>>();

  const usageMap = await getDotAliasUsageMapFromDb(db, aliases);
  return mapDotAliasGenerationRow(created ?? {}, aliases, usageMap);
}

export async function deleteDotAliasGenerationInDb(
  db: D1Database | undefined,
  generationId: string
): Promise<{ deleted: boolean; reason?: 'not_found' | 'missing_table' }> {
  const id = generationId.trim();
  if (!db || !id) {
    return { deleted: false, reason: 'not_found' };
  }

  try {
    const existing = await db.prepare('SELECT id FROM dot_alias_generations WHERE id = ? LIMIT 1').bind(id).first<{ id: string }>();
    if (!existing?.id) {
      return { deleted: false, reason: 'not_found' };
    }

    await db.prepare('DELETE FROM dot_alias_generation_items WHERE generation_id = ?').bind(id).run();
    await db.prepare('DELETE FROM dot_alias_generations WHERE id = ?').bind(id).run();
    return { deleted: true };
  } catch (error) {
    if (
      isMissingOptionalTableError(error, 'dot_alias_generations') ||
      isMissingOptionalTableError(error, 'dot_alias_generation_items')
    ) {
      return { deleted: false, reason: 'missing_table' };
    }
    throw error;
  }
}

export async function activateDotAliasGenerationItemInDb(
  db: D1Database | undefined,
  input: {
    generationId: string;
    aliasEmail: string;
    provider?: string;
  }
): Promise<ActivateDotAliasGenerationItemResult> {
  const generationId = input.generationId.trim();
  const aliasEmail = input.aliasEmail.trim().toLowerCase();
  const provider = (input.provider?.trim() || 'dot_alias_tool').slice(0, 80);
  const emptyResult: ActivateDotAliasGenerationItemResult = {
    activated: false,
    sourceEmail: '',
    aliasEmail,
    savedAliases: [],
    createdAliases: [],
    existingAliases: [],
    skippedAliases: []
  };

  if (!db || !generationId || !aliasEmail) {
    return { ...emptyResult, reason: 'not_found' };
  }

  try {
    const generation = await db
      .prepare(
        `
        SELECT
          g.source_email AS source_email,
          g.provider AS provider,
          COALESCE(g.created_by, '') AS created_by,
          i.alias_email AS alias_email
        FROM dot_alias_generations g
        LEFT JOIN dot_alias_generation_items i
          ON i.generation_id = g.id
          AND lower(i.alias_email) = ?
        WHERE g.id = ?
        LIMIT 1
      `
      )
      .bind(aliasEmail, generationId)
      .first<{ source_email: string; provider: string; created_by: string; alias_email: string | null }>();

    const sourceEmail = String(generation?.source_email ?? '').trim().toLowerCase();
    const sourceProvider = String(generation?.provider ?? '').trim().toLowerCase();
    const createdBy = String(generation?.created_by ?? '').trim();
    const matchedAlias = String(generation?.alias_email ?? '').trim().toLowerCase();
    if (!sourceEmail) {
      return { ...emptyResult, reason: 'not_found' };
    }
    if (!matchedAlias) {
      return { ...emptyResult, sourceEmail, reason: 'alias_not_found' };
    }

    if (sourceProvider === 'gmail' || sourceEmail.endsWith('@gmail.com')) {
      const existing = await db
        .prepare('SELECT id FROM gmail_dot_alias_usages WHERE lower(alias_email) = ? LIMIT 1')
        .bind(matchedAlias)
        .first<{ id: string }>();

      await db
        .prepare(
          `
          INSERT INTO gmail_dot_alias_usages (id, generation_id, source_email, alias_email, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(alias_email) DO UPDATE SET
            generation_id = excluded.generation_id,
            source_email = excluded.source_email,
            created_by = COALESCE(excluded.created_by, gmail_dot_alias_usages.created_by)
        `
        )
        .bind(crypto.randomUUID(), generationId, sourceEmail, matchedAlias, createdBy || null)
        .run();

      return {
        activated: true,
        mode: 'gmail',
        sourceEmail,
        aliasEmail: matchedAlias,
        savedAliases: [matchedAlias],
        createdAliases: existing?.id ? [] : [matchedAlias],
        existingAliases: existing?.id ? [matchedAlias] : [],
        skippedAliases: []
      };
    }

    const sourceUser = await getUserAuthByEmail(db, sourceEmail);
    if (!sourceUser?.id) {
      return { ...emptyResult, sourceEmail, reason: 'source_user_not_found' };
    }
    if (!sourceUser.passwordHash) {
      return { ...emptyResult, sourceEmail, reason: 'source_user_disabled' };
    }

    const stored = await storeUserEmailAliasesIfAvailableInDb(db, {
      userId: sourceUser.id,
      aliases: [matchedAlias],
      provider
    });

    if (stored.savedAliases.length === 0) {
      return {
        ...emptyResult,
        ...stored,
        sourceEmail,
        aliasEmail: matchedAlias,
        reason: 'alias_taken'
      };
    }

    return {
      ...stored,
      activated: true,
      mode: 'mailflare',
      sourceEmail,
      aliasEmail: matchedAlias
    };
  } catch (error) {
    if (
      isMissingOptionalTableError(error, 'dot_alias_generations') ||
      isMissingOptionalTableError(error, 'dot_alias_generation_items') ||
      isMissingOptionalTableError(error, 'gmail_dot_alias_usages') ||
      isMissingOptionalTableError(error, 'user_email_aliases')
    ) {
      return { ...emptyResult, reason: 'missing_table' };
    }
    throw error;
  }
}

export async function deactivateDotAliasGenerationItemInDb(
  db: D1Database | undefined,
  input: {
    generationId: string;
    aliasEmail: string;
    provider?: string;
  }
): Promise<DeactivateDotAliasGenerationItemResult> {
  const generationId = input.generationId.trim();
  const aliasEmail = input.aliasEmail.trim().toLowerCase();
  const provider = (input.provider?.trim() || 'dot_alias_tool').slice(0, 80);
  const emptyResult: DeactivateDotAliasGenerationItemResult = {
    deactivated: false,
    sourceEmail: '',
    aliasEmail,
    removedAliases: []
  };

  if (!db || !generationId || !aliasEmail) {
    return { ...emptyResult, reason: 'not_found' };
  }

  try {
    const generation = await db
      .prepare(
        `
        SELECT
          g.source_email AS source_email,
          g.provider AS provider,
          i.alias_email AS alias_email
        FROM dot_alias_generations g
        LEFT JOIN dot_alias_generation_items i
          ON i.generation_id = g.id
          AND lower(i.alias_email) = ?
        WHERE g.id = ?
        LIMIT 1
      `
      )
      .bind(aliasEmail, generationId)
      .first<{ source_email: string; provider: string; alias_email: string | null }>();

    const sourceEmail = String(generation?.source_email ?? '').trim().toLowerCase();
    const sourceProvider = String(generation?.provider ?? '').trim().toLowerCase();
    const matchedAlias = String(generation?.alias_email ?? '').trim().toLowerCase();
    if (!sourceEmail) {
      return { ...emptyResult, reason: 'not_found' };
    }
    if (!matchedAlias) {
      return { ...emptyResult, sourceEmail, reason: 'alias_not_found' };
    }

    if (sourceProvider === 'gmail' || sourceEmail.endsWith('@gmail.com')) {
      const result = await db
        .prepare('DELETE FROM gmail_dot_alias_usages WHERE lower(alias_email) = ?')
        .bind(matchedAlias)
        .run();
      if (Number(result.meta?.changes ?? 0) === 0) {
        return { ...emptyResult, sourceEmail, aliasEmail: matchedAlias, mode: 'gmail', reason: 'alias_not_active' };
      }

      return {
        deactivated: true,
        mode: 'gmail',
        sourceEmail,
        aliasEmail: matchedAlias,
        removedAliases: [matchedAlias]
      };
    }

    const sourceUser = await getUserAuthByEmail(db, sourceEmail);
    if (!sourceUser?.id) {
      return { ...emptyResult, sourceEmail, aliasEmail: matchedAlias, reason: 'source_user_not_found' };
    }

    const directUser = await db
      .prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1')
      .bind(matchedAlias)
      .first<{ id: string }>();
    if (directUser?.id) {
      return { ...emptyResult, sourceEmail, aliasEmail: matchedAlias, reason: 'protected_alias' };
    }

    const result = await db
      .prepare(
        `
        DELETE FROM user_email_aliases
        WHERE lower(alias_email) = ?
          AND provider = ?
          AND user_id = ?
      `
      )
      .bind(matchedAlias, provider, sourceUser.id)
      .run();

    if (Number(result.meta?.changes ?? 0) === 0) {
      const existingAlias = await db
        .prepare('SELECT provider FROM user_email_aliases WHERE lower(alias_email) = ? LIMIT 1')
        .bind(matchedAlias)
        .first<{ provider: string }>();
      return {
        ...emptyResult,
        sourceEmail,
        aliasEmail: matchedAlias,
        mode: 'mailflare',
        reason: existingAlias?.provider ? 'protected_alias' : 'alias_not_active'
      };
    }

    return {
      deactivated: true,
      mode: 'mailflare',
      sourceEmail,
      aliasEmail: matchedAlias,
      removedAliases: [matchedAlias]
    };
  } catch (error) {
    if (
      isMissingOptionalTableError(error, 'dot_alias_generations') ||
      isMissingOptionalTableError(error, 'dot_alias_generation_items') ||
      isMissingOptionalTableError(error, 'gmail_dot_alias_usages') ||
      isMissingOptionalTableError(error, 'user_email_aliases')
    ) {
      return { ...emptyResult, reason: 'missing_table' };
    }
    throw error;
  }
}

async function getDotAliasGenerationItemsFromDb(db: D1Database, generationId: string): Promise<string[]> {
  if (!generationId) {
    return [];
  }

  const response = await db
    .prepare(
      `
      SELECT alias_email
      FROM dot_alias_generation_items
      WHERE generation_id = ?
      ORDER BY created_at ASC, alias_email ASC
    `
    )
    .bind(generationId)
    .all<{ alias_email: string }>();

  return (response.results ?? []).map((row) => String(row.alias_email ?? '').trim().toLowerCase()).filter(Boolean);
}

async function getDotAliasUsageMapFromDb(db: D1Database, emails: string[]): Promise<Map<string, DotAliasUsageDto>> {
  const normalizedEmails = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const usageMap = new Map<string, DotAliasUsageDto>();
  if (normalizedEmails.length === 0) {
    return usageMap;
  }

  for (const emailChunk of chunkList(normalizedEmails, 80)) {
    const placeholders = emailChunk.map(() => '?').join(', ');
    const directUsers = await db
      .prepare(
        `
        SELECT
          lower(email) AS matched_email,
          id AS user_id,
          email AS user_email
        FROM users
        WHERE lower(email) IN (${placeholders})
      `
      )
      .bind(...emailChunk)
      .all<{ matched_email: string; user_id: string; user_email: string }>();

    for (const row of directUsers.results ?? []) {
      const email = String(row.matched_email ?? '').trim().toLowerCase();
      if (!email) {
        continue;
      }
      usageMap.set(email, {
        email,
        used: true,
        usedByUserId: String(row.user_id ?? ''),
        usedByEmail: String(row.user_email ?? ''),
        source: 'user',
        provider: 'mailflare'
      });
    }

    try {
      const aliasUsers = await db
        .prepare(
          `
          SELECT
            lower(a.alias_email) AS matched_email,
            a.provider AS provider,
            u.id AS user_id,
            u.email AS user_email
          FROM user_email_aliases a
          INNER JOIN users u
            ON u.id = a.user_id
          WHERE lower(a.alias_email) IN (${placeholders})
        `
        )
        .bind(...emailChunk)
        .all<{ matched_email: string; provider: string; user_id: string; user_email: string }>();

      for (const row of aliasUsers.results ?? []) {
        const email = String(row.matched_email ?? '').trim().toLowerCase();
        if (!email || usageMap.has(email)) {
          continue;
        }
        usageMap.set(email, {
          email,
          used: true,
          usedByUserId: String(row.user_id ?? ''),
          usedByEmail: String(row.user_email ?? ''),
          source: 'alias',
          provider: String(row.provider ?? '')
        });
      }
    } catch (error) {
      if (!isMissingOptionalTableError(error, 'user_email_aliases')) {
        throw error;
      }
    }

    try {
      const gmailAliases = await db
        .prepare(
          `
          SELECT
            lower(alias_email) AS matched_email,
            source_email
          FROM gmail_dot_alias_usages
          WHERE lower(alias_email) IN (${placeholders})
        `
        )
        .bind(...emailChunk)
        .all<{ matched_email: string; source_email: string }>();

      for (const row of gmailAliases.results ?? []) {
        const email = String(row.matched_email ?? '').trim().toLowerCase();
        if (!email || usageMap.has(email)) {
          continue;
        }
        usageMap.set(email, {
          email,
          used: true,
          usedByUserId: '',
          usedByEmail: String(row.source_email ?? '').trim().toLowerCase(),
          source: 'gmail',
          provider: 'gmail'
        });
      }
    } catch (error) {
      if (!isMissingOptionalTableError(error, 'gmail_dot_alias_usages')) {
        throw error;
      }
    }
  }

  return usageMap;
}

function mapDotAliasGenerationRow(
  row: Record<string, unknown>,
  aliases: string[],
  usageMap = new Map<string, DotAliasUsageDto>()
): DotAliasGenerationDto {
  const normalizedAliases = aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean);

  return {
    id: String(row.id ?? ''),
    sourceEmail: String(row.source_email ?? ''),
    provider: String(row.provider ?? 'mailflare'),
    aliasCount: Number(row.alias_count ?? normalizedAliases.length),
    totalLabel: String(row.total_label ?? normalizedAliases.length),
    truncated: Number(row.truncated ?? 0) === 1,
    createdBy: String(row.created_by ?? ''),
    createdAt: String(row.created_at ?? ''),
    aliases: normalizedAliases,
    aliasUsage: normalizedAliases.map((alias) => createDotAliasUsage(alias, usageMap.get(alias)))
  };
}

function createDotAliasUsage(email: string, usage?: DotAliasUsageDto): DotAliasUsageDto {
  return (
    usage ?? {
      email,
      used: false,
      usedByUserId: '',
      usedByEmail: '',
      source: '',
      provider: ''
    }
  );
}

function chunkList<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function createUniqueEmailAliasInDb(
  db: D1Database,
  input: {
    domain: string;
    localPart: string;
  }
): Promise<string> {
  const domain = input.domain.trim().toLowerCase();
  const baseLocalPart = sanitizeAliasLocalPart(input.localPart);
  if (!domain || !baseLocalPart) {
    throw new Error('Invalid alias input');
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const localPart = `${baseLocalPart.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    const aliasEmail = `${localPart}@${domain}`;
    const exists = await emailOrAliasExistsInDb(db, aliasEmail);
    if (!exists) {
      return aliasEmail;
    }
  }

  throw new Error('Unable to generate unique alias');
}

async function emailOrAliasExistsInDb(db: D1Database, email: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  const directUser = await db.prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1').bind(normalizedEmail).first<{ id: string }>();
  if (directUser?.id) {
    return true;
  }

  try {
    const alias = await db
      .prepare('SELECT id FROM user_email_aliases WHERE lower(alias_email) = ? LIMIT 1')
      .bind(normalizedEmail)
      .first<{ id: string }>();
    return Boolean(alias?.id);
  } catch (error) {
    if (isMissingOptionalTableError(error, 'user_email_aliases')) {
      return false;
    }
    throw error;
  }
}

function sanitizeAliasLocalPart(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
  return sanitized || `alias-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function detectAndStoreGptPlusClaim(db: D1Database, input: DetectGptPlusClaimInput): Promise<void> {
  const subject = (input.parsedSubject || input.subject || '').trim();
  const sender = (input.parsedSender || input.sender || '').trim();
  const recipient = input.recipient.trim().toLowerCase();
  const searchText = buildGptSignalSearchText(input);
  if (isGptPlusDeactivationEmail(subject, sender, searchText)) {
    await storeGptPlusDeactivation(db, {
      ...input,
      subject,
      sender,
      recipient,
      detectedAccountEmail: extractAssociatedOpenAiAccountEmail(searchText)
    });
    return;
  }

  if (!isGptPlusClaimEmail(subject, sender)) {
    return;
  }

  try {
    await db
      .prepare(
        `
      INSERT INTO gpt_plus_claims (
        user_id,
        email_id,
        claimed_at,
        detected_subject,
        detected_sender,
        recipient,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'claimed')
      ON CONFLICT(user_id) DO UPDATE SET
        email_id = excluded.email_id,
        claimed_at = excluded.claimed_at,
        detected_subject = excluded.detected_subject,
        detected_sender = excluded.detected_sender,
        recipient = excluded.recipient,
        status = CASE
          WHEN gpt_plus_claims.status = 'deactivated' THEN 'deactivated'
          ELSE 'claimed'
        END
    `
      )
      .bind(
        input.userId,
        input.emailId,
        input.receivedAt || new Date().toISOString(),
        subject.slice(0, 998),
        sender.slice(0, 320),
        recipient.slice(0, 320)
      )
      .run();
  } catch (error) {
    if (!isMissingOptionalTableError(error, 'gpt_plus_claims')) {
      throw error;
    }
  }
}

async function backfillRecentGptPlusDeactivationsFromDb(db: D1Database): Promise<void> {
  const now = Date.now();
  if (now - lastGptPlusDeactivationBackfillAt < GPT_PLUS_DEACTIVATION_BACKFILL_INTERVAL_MS) {
    return;
  }
  lastGptPlusDeactivationBackfillAt = now;

  try {
    const response = await db
      .prepare(
        `
      SELECT
        id,
        user_id,
        sender,
        recipient,
        COALESCE(subject, parsed_subject, '') AS subject,
        COALESCE(snippet, '') AS snippet,
        COALESCE(parsed_text, body_text, '') AS body_text,
        COALESCE(parsed_html, body_html, '') AS body_html,
        received_at
      FROM emails
      WHERE deleted_at IS NULL
        AND (
          lower(sender) LIKE '%openai%'
          OR lower(COALESCE(parsed_from_email, '')) LIKE '%openai%'
          OR lower(COALESCE(body_text, '')) LIKE '%openai%'
          OR lower(COALESCE(parsed_text, '')) LIKE '%openai%'
          OR lower(COALESCE(parsed_html, '')) LIKE '%openai%'
        )
        AND (
          lower(COALESCE(body_text, '')) LIKE '%deactivating your access%'
          OR lower(COALESCE(parsed_text, '')) LIKE '%deactivating your access%'
          OR lower(COALESCE(parsed_html, '')) LIKE '%deactivating your access%'
          OR lower(COALESCE(body_text, '')) LIKE '%not permitted under our policies%'
          OR lower(COALESCE(parsed_text, '')) LIKE '%not permitted under our policies%'
          OR lower(COALESCE(parsed_html, '')) LIKE '%not permitted under our policies%'
        )
      ORDER BY received_at DESC
      LIMIT 100
    `
      )
      .all<Record<string, unknown>>();

    for (const row of response.results ?? []) {
      const input = {
        userId: String(row.user_id ?? ''),
        emailId: String(row.id ?? ''),
        sender: String(row.sender ?? ''),
        recipient: String(row.recipient ?? ''),
        subject: String(row.subject ?? ''),
        snippet: String(row.snippet ?? ''),
        bodyText: String(row.body_text ?? ''),
        bodyHtml: String(row.body_html ?? ''),
        receivedAt: String(row.received_at ?? '')
      };
      const searchText = buildGptSignalSearchText(input);
      if (input.userId && input.emailId && isGptPlusDeactivationEmail(input.subject, input.sender, searchText)) {
        await storeGptPlusDeactivation(db, {
          ...input,
          detectedAccountEmail: extractAssociatedOpenAiAccountEmail(searchText)
        });
      }
    }
  } catch {
    // This is opportunistic. A failed backfill should never block inbox/user pages.
  }
}

interface StoreGptPlusDeactivationInput extends DetectGptPlusClaimInput {
  detectedAccountEmail?: string;
}

async function storeGptPlusDeactivation(db: D1Database, input: StoreGptPlusDeactivationInput): Promise<void> {
  const subject = (input.parsedSubject || input.subject || '').trim();
  const sender = (input.parsedSender || input.sender || '').trim();
  const deactivatedAt = input.receivedAt || new Date().toISOString();
  const target = await resolveGptSignalTargetUser(db, {
    fallbackUserId: input.userId,
    fallbackEmail: input.recipient,
    detectedAccountEmail: input.detectedAccountEmail
  });

  try {
    const existing = await db
      .prepare(
        `
      SELECT claimed_at, detected_subject, detected_sender, recipient
      FROM gpt_plus_claims
      WHERE user_id = ?
      LIMIT 1
    `
      )
      .bind(target.userId)
      .first<Record<string, unknown>>();

    await db
      .prepare(
        `
      INSERT INTO gpt_plus_claims (
        user_id,
        email_id,
        claimed_at,
        detected_subject,
        detected_sender,
        recipient,
        status,
        deactivated_at,
        deactivated_email_id,
        deactivated_subject,
        deactivated_sender
      )
      VALUES (?, ?, ?, ?, ?, ?, 'deactivated', ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        status = 'deactivated',
        deactivated_at = excluded.deactivated_at,
        deactivated_email_id = excluded.deactivated_email_id,
        deactivated_subject = excluded.deactivated_subject,
        deactivated_sender = excluded.deactivated_sender
    `
      )
      .bind(
        target.userId,
        input.emailId,
        String(existing?.claimed_at ?? deactivatedAt),
        String(existing?.detected_subject ?? subject).slice(0, 998),
        String(existing?.detected_sender ?? sender).slice(0, 320),
        String(existing?.recipient ?? target.email).slice(0, 320),
        deactivatedAt,
        input.emailId,
        subject.slice(0, 998),
        sender.slice(0, 320)
      )
      .run();
  } catch (error) {
    if (isMissingOptionalColumnError(error, 'deactivated_at')) {
      await storeGptPlusDeactivationLegacy(db, input, target, subject, sender, deactivatedAt);
      return;
    }
    if (!isMissingOptionalTableError(error, 'gpt_plus_claims')) {
      throw error;
    }
  }
}

async function storeGptPlusDeactivationLegacy(
  db: D1Database,
  input: StoreGptPlusDeactivationInput,
  target: { userId: string; email: string },
  subject: string,
  sender: string,
  deactivatedAt: string
): Promise<void> {
  try {
    await db
      .prepare(
        `
      INSERT INTO gpt_plus_claims (
        user_id,
        email_id,
        claimed_at,
        detected_subject,
        detected_sender,
        recipient,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'deactivated')
      ON CONFLICT(user_id) DO UPDATE SET
        status = 'deactivated'
    `
      )
      .bind(target.userId, input.emailId, deactivatedAt, subject.slice(0, 998), sender.slice(0, 320), target.email.slice(0, 320))
      .run();
  } catch (error) {
    if (!isMissingOptionalTableError(error, 'gpt_plus_claims')) {
      throw error;
    }
  }
}

async function resolveGptSignalTargetUser(
  db: D1Database,
  input: { fallbackUserId: string; fallbackEmail: string; detectedAccountEmail?: string }
): Promise<{ userId: string; email: string }> {
  const fallback = {
    userId: input.fallbackUserId,
    email: input.fallbackEmail.trim().toLowerCase()
  };
  const detectedEmail = input.detectedAccountEmail?.trim().toLowerCase();
  if (!detectedEmail || detectedEmail === fallback.email) {
    return fallback;
  }

  const row = await db
    .prepare('SELECT id, email FROM users WHERE lower(email) = ? LIMIT 1')
    .bind(detectedEmail)
    .first<{ id: string; email: string }>();

  if (!row?.id) {
    return fallback;
  }

  return {
    userId: String(row.id),
    email: String(row.email || detectedEmail).toLowerCase()
  };
}

function isGptPlusClaimEmail(subject: string, sender: string): boolean {
  const normalizedSubject = subject.toLowerCase();
  const normalizedSender = sender.toLowerCase();
  const mentionsChatGpt = normalizedSubject.includes('chatgpt') || normalizedSender.includes('openai');
  const looksPlanClaim =
    normalizedSubject.includes('your new plan') ||
    normalizedSubject.includes('gpt plus') ||
    normalizedSubject.includes('chatgpt plus') ||
    (normalizedSubject.includes('plan') && normalizedSubject.includes('chatgpt'));
  return mentionsChatGpt && looksPlanClaim;
}

function isGptPlusDeactivationEmail(subject: string, sender: string, searchText: string): boolean {
  const normalizedSubject = subject.toLowerCase();
  const normalizedSender = sender.toLowerCase();
  const openAiRelated =
    normalizedSender.includes('openai') || normalizedSubject.includes('openai') || searchText.includes('openai');
  const looksLikePolicyDeactivation =
    searchText.includes('access deactivated') ||
    searchText.includes('deactivating your access') ||
    searchText.includes('deactivated your access') ||
    searchText.includes('your access to our services') ||
    searchText.includes('not permitted under our policies') ||
    (searchText.includes('deactivat') && searchText.includes('terms') && searchText.includes('policies'));
  const identifiesAccount =
    searchText.includes('associated with the email address') ||
    searchText.includes('user id:') ||
    searchText.includes('openai account');

  return openAiRelated && looksLikePolicyDeactivation && identifiesAccount;
}

function buildGptSignalSearchText(input: DetectGptPlusClaimInput): string {
  return normalizeSearchText(
    [
      input.parsedSubject || input.subject,
      input.parsedSender || input.sender,
      input.recipient,
      input.snippet,
      input.bodyText,
      input.bodyHtml ? htmlToPlainText(input.bodyHtml) : ''
    ].join('\n')
  );
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractAssociatedOpenAiAccountEmail(searchText: string): string {
  const associatedMatch = searchText.match(
    /associated with the email address\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i
  );
  if (associatedMatch?.[1]) {
    return associatedMatch[1].toLowerCase();
  }

  return '';
}

export async function getGptPlusClaimsFromDb(db: D1Database | undefined): Promise<GptPlusClaimDto[]> {
  if (!db) {
    return [];
  }

  await backfillRecentGptPlusDeactivationsFromDb(db);

  let results: Record<string, unknown>[] | undefined;
  try {
    const response = await db
      .prepare(
        `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id AS user_id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        CASE
          WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
          ELSE 'member'
        END AS role,
        COALESCE(c.initial_password, '') AS initial_password,
        g.claimed_at,
        g.email_id,
        g.detected_subject,
        g.detected_sender,
        g.recipient,
        COALESCE(g.status, 'claimed') AS status,
        COALESCE(g.deactivated_at, '') AS deactivated_at,
        COALESCE(g.deactivated_email_id, '') AS deactivated_email_id,
        COALESCE(g.deactivated_subject, '') AS deactivated_subject,
        COALESCE(g.deactivated_sender, '') AS deactivated_sender,
        (
          SELECT COUNT(*)
          FROM user_email_aliases a
          WHERE a.user_id = u.id
            AND a.provider = 'gpt_dot_alias'
        ) AS dot_alias_count
      FROM gpt_plus_claims g
      INNER JOIN users u
        ON u.id = g.user_id
      LEFT JOIN user_initial_credentials c
        ON c.user_id = u.id
      WHERE u.password_hash IS NOT NULL
      ORDER BY COALESCE(NULLIF(g.deactivated_at, ''), g.claimed_at) DESC, u.created_at DESC
      LIMIT 250
    `
      )
      .all<Record<string, unknown>>();
    results = response.results;
  } catch (error) {
    if (isMissingOptionalTableError(error, 'gpt_plus_claims') || isMissingOptionalTableError(error, 'user_initial_credentials')) {
      return [];
    }
    if (isMissingOptionalTableError(error, 'user_email_aliases') || isMissingOptionalColumnError(error, 'deactivated_at')) {
      return getLegacyGptPlusClaimsFromDb(db);
    }
    throw error;
  }

  return (results ?? []).map((row) => mapGptPlusClaimRow(row));
}

async function getLegacyGptPlusClaimsFromDb(db: D1Database): Promise<GptPlusClaimDto[]> {
  const response = await db
    .prepare(
      `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id AS user_id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        CASE
          WHEN u.id = (SELECT owner_id FROM owner) THEN 'owner'
          ELSE 'member'
        END AS role,
        COALESCE(c.initial_password, '') AS initial_password,
        g.claimed_at,
        g.email_id,
        g.detected_subject,
        g.detected_sender,
        g.recipient,
        COALESCE(g.status, 'claimed') AS status,
        0 AS dot_alias_count
      FROM gpt_plus_claims g
      INNER JOIN users u
        ON u.id = g.user_id
      LEFT JOIN user_initial_credentials c
        ON c.user_id = u.id
      WHERE u.password_hash IS NOT NULL
      ORDER BY g.claimed_at DESC, u.created_at DESC
      LIMIT 250
    `
    )
    .all<Record<string, unknown>>();

  return (response.results ?? []).map((row) => mapGptPlusClaimRow(row));
}

function mapGptPlusClaimRow(row: Record<string, unknown>): GptPlusClaimDto {
  const claimedAt = String(row.claimed_at ?? '');
  const status = String(row.status ?? '').toLowerCase() === 'deactivated' ? 'deactivated' : 'claimed';

  return {
    userId: String(row.user_id ?? ''),
    email: String(row.email ?? ''),
    displayName: String(row.display_name ?? ''),
    role: String(row.role ?? 'member'),
    initialPassword: String(row.initial_password ?? ''),
    claimedAt,
    expiresAt: getGptPlusExpiresAt(claimedAt),
    emailId: String(row.email_id ?? ''),
    detectedSubject: String(row.detected_subject ?? ''),
    detectedSender: String(row.detected_sender ?? ''),
    recipient: String(row.recipient ?? ''),
    status,
    deactivatedAt: String(row.deactivated_at ?? ''),
    deactivationEmailId: String(row.deactivated_email_id ?? ''),
    deactivationSubject: String(row.deactivated_subject ?? ''),
    deactivationSender: String(row.deactivated_sender ?? ''),
    dotAliasCount: Number(row.dot_alias_count ?? 0)
  };
}

function isMissingOptionalTableError(error: unknown, tableName: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('no such table') && message.toLowerCase().includes(tableName.toLowerCase());
}

function isMissingOptionalColumnError(error: unknown, columnName: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return (
    (normalized.includes('no such column') || normalized.includes('has no column named')) &&
    normalized.includes(columnName.toLowerCase())
  );
}

function getGptPlusExpiresAt(claimedAt: string): string {
  const baseDate = parseStoredDate(claimedAt);
  if (!baseDate) {
    return '';
  }

  return addCalendarMonthsUtc(baseDate, 1).toISOString();
}

function parseStoredDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addCalendarMonthsUtc(date: Date, months: number): Date {
  const targetMonthIndex = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(date.getUTCDate(), lastDayInTargetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      targetDay,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}

function parseHeaderParam(contentType: string, paramName: string): string {
  if (!contentType) {
    return '';
  }
  const regex = new RegExp(`${paramName}\\s*=\\s*("?)([^";\\r\\n]+)\\1`, 'i');
  const match = contentType.match(regex);
  return match ? String(match[2] ?? '').trim() : '';
}

function parseHeadersJson(headersJson: string): Record<string, string> {
  if (!headersJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(headersJson) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[String(key).toLowerCase()] = String(value ?? '');
    }
    return out;
  } catch {
    return {};
  }
}

function pickHeader(headers: Record<string, string>, name: string): string {
  return String(headers[name.toLowerCase()] ?? '').trim();
}

function normalizeAddressFromHeader(value: string): string {
  const trimmed = value.replace(/\\"/g, '"').trim();
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : trimmed).trim();
  return addr.replace(/^"+|"+$/g, '');
}

function parseMailboxHeader(value: string): { name: string; email: string } {
  const trimmed = value.replace(/\\"/g, '"').trim();
  if (!trimmed) {
    return { name: '', email: '' };
  }
  const angle = trimmed.match(/^(.*)<([^>]+)>/);
  if (angle) {
    const name = angle[1].trim().replace(/^"+|"+$/g, '').trim();
    const email = normalizeAddressFromHeader(angle[2]).toLowerCase();
    return { name, email };
  }
  const plain = normalizeAddressFromHeader(trimmed).toLowerCase();
  if (plain.includes('@')) {
    return { name: '', email: plain };
  }
  return { name: trimmed, email: '' };
}

function normalizeRawMimeInput(rawMime: string): string {
  const value = String(rawMime ?? '');
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string' && parsed.trim()) {
        return parsed;
      }
    } catch {
      // ignore malformed JSON-string payload and use the original value
    }
  }

  if (!value.includes('\n') && (trimmed.includes('\\r\\n') || trimmed.includes('\\n'))) {
    return trimmed.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n');
  }

  return value;
}

function looksLikeRawMimeLeak(value: string, boundary: string): boolean {
  const sample = String(value ?? '').slice(0, 2500);
  if (!sample) {
    return false;
  }

  if (/^\s*--[-_=a-zA-Z0-9]{6,}/m.test(sample) && /content-type\s*:/i.test(sample)) {
    return true;
  }

  if (/content-transfer-encoding\s*:/i.test(sample) && /mime-version\s*:/i.test(sample)) {
    return true;
  }

  if (boundary) {
    const normalizedBoundary = boundary.replace(/^"+|"+$/g, '');
    if (normalizedBoundary && (sample.includes(normalizedBoundary) || sample.includes(`--${normalizedBoundary}`))) {
      if (/content-type\s*:/i.test(sample)) {
        return true;
      }
    }
  }

  return false;
}

function extractBestBodyFromRawMime(
  rawMime: string,
  contentTypeHeader: string,
  transferEncodingHeader: string,
  boundary: string
): { text: string; html: string } {
  const rawBody = extractRawBodyFromMime(rawMime);
  if (!rawBody) {
    return { text: '', html: '' };
  }

  const normalizedContentType = contentTypeHeader.toLowerCase();
  const boundaryValue = boundary || parseHeaderParam(contentTypeHeader, 'boundary');
  if (normalizedContentType.includes('multipart/') && boundaryValue) {
    const parts = splitMultipartBody(rawBody, boundaryValue);
    let plainText = '';
    let htmlBody = '';

    for (const part of parts) {
      const parsedPart = parseMimePart(part);
      if (!parsedPart) {
        continue;
      }

      const partContentType = pickHeader(parsedPart.headers, 'content-type').toLowerCase();
      const partEncoding = pickHeader(parsedPart.headers, 'content-transfer-encoding') || transferEncodingHeader;
      const decodedBody = decodeTransferEncoding(parsedPart.body, partEncoding).trim();
      if (!decodedBody) {
        continue;
      }

      if (!plainText && partContentType.includes('text/plain')) {
        plainText = decodedBody;
      }
      if (!htmlBody && partContentType.includes('text/html')) {
        htmlBody = decodedBody;
      }
      if (plainText && htmlBody) {
        break;
      }
    }

    if (plainText || htmlBody) {
      return {
        text: plainText || htmlToPlainText(htmlBody),
        html: htmlBody
      };
    }
  }

  const decodedBody = decodeTransferEncoding(rawBody, transferEncodingHeader).trim();
  if (!decodedBody) {
    return { text: '', html: '' };
  }

  if (normalizedContentType.includes('text/html')) {
    return {
      text: htmlToPlainText(decodedBody),
      html: decodedBody
    };
  }

  return {
    text: decodedBody,
    html: ''
  };
}

function splitMultipartBody(rawBody: string, boundary: string): string[] {
  const normalizedBoundary = String(boundary ?? '').replace(/^"+|"+$/g, '').trim();
  if (!normalizedBoundary) {
    return [];
  }

  const delimiter = `--${normalizedBoundary}`;
  const closingDelimiter = `${delimiter}--`;
  const lines = rawBody.split(/\r?\n/);
  const parts: string[] = [];
  let collecting = false;
  let currentPart: string[] = [];

  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();
    if (line === delimiter) {
      if (collecting && currentPart.length > 0) {
        parts.push(currentPart.join('\n'));
      }
      collecting = true;
      currentPart = [];
      continue;
    }
    if (line === closingDelimiter) {
      if (collecting && currentPart.length > 0) {
        parts.push(currentPart.join('\n'));
      }
      break;
    }
    if (collecting) {
      currentPart.push(lineRaw);
    }
  }

  return parts;
}

function parseMimePart(part: string): { headers: Record<string, string>; body: string } | null {
  if (!part) {
    return null;
  }
  const parts = part.split(/\r?\n\r?\n/);
  if (parts.length < 2) {
    return null;
  }
  const headerBlock = parts.shift() ?? '';
  const body = parts.join('\n\n');
  return {
    headers: parseHeaderBlock(headerBlock),
    body
  };
}

function parseHeaderBlock(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let currentKey = '';

  for (const line of headerBlock.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    if ((line.startsWith(' ') || line.startsWith('\t')) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`.trim();
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    currentKey = key;
    headers[key] = headers[key] ? `${headers[key]}\n${value}` : value;
  }

  return headers;
}

function extractRawBodyFromMime(rawMime: string): string {
  if (!rawMime) {
    return '';
  }
  const parts = rawMime.split(/\r?\n\r?\n/);
  if (parts.length < 2) {
    return '';
  }
  return parts.slice(1).join('\n\n').trim();
}

function decodeTransferEncoding(body: string, encoding: string): string {
  const normalizedEncoding = encoding.trim().toLowerCase();
  if (!body || !normalizedEncoding) {
    return body;
  }

  if (normalizedEncoding.includes('quoted-printable')) {
    return decodeQuotedPrintable(body);
  }

  if (normalizedEncoding.includes('base64')) {
    return decodeBase64ToUtf8(body);
  }

  return body;
}

function decodeQuotedPrintable(value: string): string {
  const normalized = value.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (
      current === '=' &&
      index + 2 < normalized.length &&
      /[A-Fa-f0-9]/.test(normalized[index + 1]) &&
      /[A-Fa-f0-9]/.test(normalized[index + 2])
    ) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(normalized.charCodeAt(index) & 0xff);
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
}

function decodeBase64ToUtf8(value: string): string {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized) {
    return '';
  }

  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return value;
  }
}

function htmlToPlainText(html: string): string {
  if (!html) {
    return '';
  }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function textToSimpleHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\r?\n/g, '<br>');
}

function truncateNullable(value: string, max: number): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, max);
}

export async function getUserInboxFromDb(db: D1Database | undefined, userId: string): Promise<EmailDto[]> {
  if (!db) {
    return inboxFallback(userId);
  }

  const query = `
    SELECT
      id,
      sender,
      subject,
      snippet,
      received_at,
      is_read,
      is_starred,
      is_archived
    FROM emails
    WHERE user_id = ?
      AND deleted_at IS NULL
    ORDER BY is_archived ASC, received_at DESC
    LIMIT 100
  `;
  const { results } = await db.prepare(query).bind(userId).all<Record<string, unknown>>();
  return (results ?? []).map((row) => ({
    id: String(row.id),
    sender: String(row.sender ?? ''),
    subject: String(row.subject ?? '(Tanpa Subjek)'),
    snippet: String(row.snippet ?? ''),
    receivedAt: String(row.received_at ?? ''),
    isRead: Number(row.is_read ?? 0) === 1,
    isStarred: Number(row.is_starred ?? 0) === 1,
    isArchived: Number(row.is_archived ?? 0) === 1
  }));
}

export async function getEmailByIdFromDb(
  db: D1Database | undefined,
  userId: string,
  emailId: string
): Promise<EmailDetailDto | null> {
  if (!db) {
    return emailDetailFallback(userId, emailId);
  }

  const row = await db
    .prepare(
      `
      SELECT
        id,
        user_id,
        sender,
        recipient,
        subject,
        snippet,
        received_at,
        is_read,
        is_starred,
        is_archived,
        body_text,
        body_html,
        parsed_text,
        parsed_html
      FROM emails
      WHERE id = ?
        AND user_id = ?
        AND deleted_at IS NULL
      LIMIT 1
    `
    )
    .bind(emailId, userId)
    .first<Record<string, unknown>>();

  if (!row) {
    return null;
  }

  if (Number(row.is_read ?? 0) !== 1) {
    await db.prepare('UPDATE emails SET is_read = 1 WHERE id = ? AND user_id = ?').bind(emailId, userId).run();
  }

  const bodyText = String(row.body_text ?? row.parsed_text ?? row.snippet ?? '');
  const bodyHtml = String(row.body_html ?? row.parsed_html ?? '');

  return {
    id: String(row.id),
    userId: String(row.user_id),
    sender: String(row.sender ?? ''),
    recipient: String(row.recipient ?? ''),
    subject: String(row.subject ?? '(Tanpa Subjek)'),
    snippet: String(row.snippet ?? ''),
    receivedAt: String(row.received_at ?? ''),
    bodyText,
    bodyHtml,
    isRead: true,
    isStarred: Number(row.is_starred ?? 0) === 1,
    isArchived: Number(row.is_archived ?? 0) === 1
  };
}

export async function getUserArchivedEmailCountFromDb(db: D1Database | undefined, userId: string): Promise<number> {
  if (!db) {
    return 0;
  }

  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM emails WHERE user_id = ? AND deleted_at IS NULL AND is_archived = 1')
    .bind(userId)
    .first<{ count: number }>();

  return Number(row?.count ?? 0);
}

export async function applyEmailQuickActionInDb(
  db: D1Database | undefined,
  userId: string,
  emailId: string,
  action: EmailQuickAction,
  actor: string
): Promise<ApplyEmailQuickActionResult> {
  if (!db) {
    throw new Error('DB binding is required for update operation');
  }

  const beforeState = await getEmailActionState(db, userId, emailId);
  if (!beforeState) {
    return { updated: false, reason: 'not_found' };
  }

  if (beforeState.deletedAt) {
    return { updated: false, reason: 'already_deleted' };
  }

  if (action === 'archive' && beforeState.isArchived) {
    return { updated: false, reason: 'already_archived', email: beforeState };
  }

  if (action === 'star') {
    await db
      .prepare(
        `
        UPDATE emails
        SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END
        WHERE id = ? AND user_id = ?
      `
      )
      .bind(emailId, userId)
      .run();
  }

  if (action === 'archive') {
    await db.prepare('UPDATE emails SET is_archived = 1 WHERE id = ? AND user_id = ?').bind(emailId, userId).run();
  }

  if (action === 'delete') {
    await db
      .prepare("UPDATE emails SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) WHERE id = ? AND user_id = ?")
      .bind(emailId, userId)
      .run();
  }

  const afterState = await getEmailActionState(db, userId, emailId);
  if (!afterState) {
    return { updated: false, reason: 'not_found' };
  }

  await writeEmailStatusHistoryInDb(db, emailId, action, actor, buildEmailState(beforeState), buildEmailState(afterState));

  return {
    updated: true,
    email: afterState
  };
}

async function getEmailActionState(
  db: D1Database,
  userId: string,
  emailId: string
): Promise<EmailActionState | null> {
  const row = await db
    .prepare(
      `
      SELECT id, user_id, is_read, is_starred, is_archived, deleted_at
      FROM emails
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .bind(emailId, userId)
    .first<Record<string, unknown>>();

  if (!row) {
    return null;
  }

  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    isRead: Number(row.is_read ?? 0) === 1,
    isStarred: Number(row.is_starred ?? 0) === 1,
    isArchived: Number(row.is_archived ?? 0) === 1,
    deletedAt: row.deleted_at ? String(row.deleted_at) : null
  };
}

async function writeEmailStatusHistoryInDb(
  db: D1Database,
  emailId: string,
  action: string,
  actor: string,
  fromState: string,
  toState: string
): Promise<void> {
  try {
    await db
      .prepare(
        `
        INSERT INTO email_status_history (id, email_id, action, actor, from_state, to_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
      )
      .bind(crypto.randomUUID(), emailId, action, actor, fromState, toState)
      .run();
  } catch {
    // Ignore history failures.
  }
}

function buildEmailState(email: EmailActionState): string {
  return `read=${email.isRead ? 1 : 0},starred=${email.isStarred ? 1 : 0},archived=${email.isArchived ? 1 : 0},deleted=${email.deletedAt ? 1 : 0}`;
}

export async function getWorkerSettingsFromDb(db?: D1Database): Promise<WorkerSettingsPageDto> {
  if (!db) {
    return workerFallback;
  }

  const { results } = await db.prepare('SELECT key, value FROM worker_settings').all<Record<string, unknown>>();
  const rawSettings = new Map<string, string>();
  for (const row of results ?? []) {
    const key = String(row.key ?? '');
    if (!key) {
      continue;
    }
    rawSettings.set(key, String(row.value ?? ''));
  }

  return {
    settings: {
      botStatus: rawSettings.get('bot_status') || workerFallback.settings.botStatus,
      botTokenConfigured: Boolean(rawSettings.get('bot_token')?.trim()),
      webhookSecretConfigured: Boolean(rawSettings.get('webhook_secret')?.trim()),
      allowedIds: rawSettings.get('allowed_ids') || workerFallback.settings.allowedIds,
      forwardInbound: parseBooleanSetting(rawSettings.get('forward_inbound'), workerFallback.settings.forwardInbound),
      targetMode: rawSettings.get('target_mode') || workerFallback.settings.targetMode,
      defaultChatId: rawSettings.get('default_chat_id') || workerFallback.settings.defaultChatId,
      testChatId: rawSettings.get('test_chat_id') || workerFallback.settings.testChatId
    },
    webhook: {
      connected: Boolean(rawSettings.get('webhook_url')?.trim()),
      url: rawSettings.get('webhook_url') || workerFallback.webhook.url,
      ipAddress: rawSettings.get('webhook_ip_address') || workerFallback.webhook.ipAddress,
      maxConnections: parseNumberSetting(rawSettings.get('webhook_max_connections'), workerFallback.webhook.maxConnections),
      pendingUpdates: parseNumberSetting(rawSettings.get('webhook_pending_updates'), workerFallback.webhook.pendingUpdates),
      allowedUpdates: parseListSetting(rawSettings.get('webhook_allowed_updates'), workerFallback.webhook.allowedUpdates),
      lastErrorAt: '',
      lastErrorMessage: '',
      source: 'settings'
    }
  };
}

export async function updateWorkerSettingsInDb(
  db: D1Database | undefined,
  input: WorkerSettingsUpdateInput
): Promise<WorkerSettingsPageDto> {
  if (!db) {
    throw new Error('DB binding is required for update operation');
  }

  const nextValues: Array<[string, string]> = [];
  if (input.botToken !== undefined) {
    nextValues.push(['bot_token', input.botToken]);
    nextValues.push(['bot_status', input.botToken ? 'Terkonfigurasi' : 'Token belum ada']);
  }
  if (input.webhookSecret !== undefined) {
    nextValues.push(['webhook_secret', input.webhookSecret]);
  }
  if (input.allowedIds !== undefined) {
    nextValues.push(['allowed_ids', input.allowedIds]);
  }
  if (input.forwardInbound !== undefined) {
    nextValues.push(['forward_inbound', input.forwardInbound ? '1' : '0']);
  }
  if (input.targetMode !== undefined) {
    nextValues.push(['target_mode', input.targetMode]);
  }
  if (input.defaultChatId !== undefined) {
    nextValues.push(['default_chat_id', input.defaultChatId]);
  }
  if (input.testChatId !== undefined) {
    nextValues.push(['test_chat_id', input.testChatId]);
  }

  await Promise.all(
    nextValues.map(([key, value]) =>
      db
        .prepare(
          `
          INSERT INTO worker_settings (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `
        )
        .bind(key, value)
        .run()
    )
  );

  return getWorkerSettingsFromDb(db);
}

export async function createUserInDb(db: D1Database | undefined, input: CreateUserInput): Promise<UserDto> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName?.trim() || email;
  const passwordHash = input.passwordHash ?? null;
  const initialPassword = input.initialPassword?.trim() ?? '';
  const credentialSource = input.credentialSource?.trim() || 'create_user';
  const emailAliases = input.emailAliases ?? [];

  if (!db) {
    throw new Error('DB binding is required for create operation');
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `
      INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `
    )
    .bind(id, email, displayName, passwordHash)
    .run();

  if (initialPassword) {
    await storeInitialCredentialInDb(db, {
      userId: id,
      email,
      initialPassword,
      source: credentialSource
    });
  }

  for (const alias of emailAliases) {
    await storeUserEmailAliasInDb(db, {
      userId: id,
      aliasEmail: alias.aliasEmail,
      provider: alias.provider
    });
  }

  const outlookForwardingAddress =
    emailAliases.find((alias) => (alias.provider ?? '').trim() === 'outlook_forward')?.aliasEmail.trim().toLowerCase() ?? '';

  return {
    id,
    email,
    displayName,
    role: 'member',
    status: 'active',
    gptPlusClaimed: false,
    gptPlusClaimedAt: '',
    gptPlusStatus: undefined,
    gptPlusDeactivatedAt: '',
    gptPlusDeactivationEmailId: '',
    initialPassword,
    outlookForwardingAddress
  };
}

export async function updateUserInDb(
  db: D1Database | undefined,
  userId: string,
  input: UpdateUserInput
): Promise<UserDto | null> {
  if (!db) {
    throw new Error('DB binding is required for update operation');
  }

  const existing = await getUserByIdFromDb(db, userId);
  if (!existing) {
    return null;
  }

  const nextEmail = input.email?.trim().toLowerCase() ?? existing.email;
  const nextDisplayName = input.displayName?.trim() ?? existing.displayName;
  const existingAuth = await getUserAuthByEmail(db, existing.email);
  const nextPasswordHash = input.passwordHash ?? existingAuth?.passwordHash ?? null;

  await db
    .prepare(
      `
      UPDATE users
      SET email = ?, display_name = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
    )
    .bind(nextEmail, nextDisplayName, nextPasswordHash, userId)
    .run();

  return {
    ...existing,
    email: nextEmail,
    displayName: nextDisplayName
  };
}

export async function deleteUserInDb(db: D1Database | undefined, userId: string): Promise<DeleteUserResult> {
  if (!db) {
    throw new Error('DB binding is required for delete operation');
  }

  const existing = await getUserByIdFromDb(db, userId);
  if (!existing) {
    return { deleted: false, reason: 'not_found' };
  }

  const [emailRef, sessionRef] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM emails WHERE user_id = ?').bind(userId).first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM login_sessions WHERE user_id = ?').bind(userId).first<{ count: number }>()
  ]);

  const emailCount = Number(emailRef?.count ?? 0);
  const loginSessionCount = Number(sessionRef?.count ?? 0);

  if (emailCount > 0 || loginSessionCount > 0) {
    return {
      deleted: false,
      reason: 'has_dependencies',
      emailCount,
      loginSessionCount
    };
  }

  await deleteUserEmailAliasesInDb(db, userId);
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return { deleted: true };
}

export async function softDeleteUserInDb(db: D1Database | undefined, userId: string): Promise<SoftDeleteUserResult> {
  if (!db) {
    throw new Error('DB binding is required for delete operation');
  }

  const row = await db
    .prepare(
      `
      WITH owner AS (
        SELECT id AS owner_id
        FROM users
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
      SELECT
        u.id,
        u.email,
        COALESCE(u.display_name, u.email) AS display_name,
        u.password_hash,
        CASE WHEN u.id = (SELECT owner_id FROM owner) THEN 1 ELSE 0 END AS is_owner
      FROM users u
      WHERE u.id = ?
      LIMIT 1
    `
    )
    .bind(userId)
    .first<{ id: string; email: string; display_name: string; password_hash: string | null; is_owner: number }>();

  if (!row) {
    return { deleted: false, reason: 'not_found' };
  }

  if (Number(row.is_owner) === 1) {
    return { deleted: false, reason: 'protected_owner' };
  }

  if (!row.password_hash) {
    return { deleted: false, reason: 'already_deleted' };
  }

  const domain = (row.email.split('@')[1] ?? 'mailflare.local').toLowerCase();
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const tombstoneEmail = `deleted+${suffix}@${domain}`;
  const tombstoneName = `${row.display_name} (deleted)`.slice(0, 120);

  await db
    .prepare(
      `
      UPDATE users
      SET email = ?, display_name = ?, password_hash = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
    )
    .bind(tombstoneEmail, tombstoneName, userId)
    .run();

  await db.prepare('DELETE FROM login_sessions WHERE user_id = ?').bind(userId).run();
  await deleteUserEmailAliasesInDb(db, userId);

  return { deleted: true };
}

async function deleteUserEmailAliasesInDb(db: D1Database, userId: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM user_email_aliases WHERE user_id = ?').bind(userId).run();
  } catch (error) {
    if (!isMissingOptionalTableError(error, 'user_email_aliases')) {
      throw error;
    }
  }
}

const dashboardFallback: DashboardDto = {
  metrics: [
    { key: 'users', label: 'Pengguna Terdaftar', value: '12', delta: '+2 minggu ini', status: 'ok' },
    { key: 'emails', label: 'Data Email', value: '4,281', delta: '+340/hari', status: 'ok' },
    { key: 'unread', label: 'Email Belum Dibaca', value: '156', delta: 'Perlu dicek', status: 'warning' },
    { key: 'starred', label: 'Ditandai Admin', value: '89', status: 'ok' },
    { key: 'archived', label: 'Diarsipkan', value: '401', status: 'ok' },
    { key: 'deleted', label: 'Dihapus Sementara', value: '27', status: 'critical' }
  ]
};

const usersFallback: UserDto[] = [
  { id: 'u1', email: 'alex@mailflare.dev', displayName: 'Alex Flare', role: 'owner', status: 'active', totalEmails: 27, unreadEmails: 3 },
  { id: 'u2', email: 'ops@mailflare.dev', displayName: 'Ops Notify', role: 'member', status: 'active', totalEmails: 14, unreadEmails: 1 }
];

function inboxFallback(userId: string): EmailDto[] {
  return [
    {
      id: `${userId}-e1`,
      sender: 'postmaster@infra.mailflare.dev',
      subject: 'Optimasi uptime tanpa biaya tambahan',
      snippet: 'Kami menemukan peningkatan throughput pada tabel routing eu-west-1...',
      receivedAt: new Date().toISOString(),
      isRead: false,
      isStarred: true,
      isArchived: false
    },
    {
      id: `${userId}-e2`,
      sender: 'alerts@cloudflare.com',
      subject: 'Peringatan Keamanan: Masuk Baru',
      snippet: 'Akun Anda masuk dari perangkat baru...',
      receivedAt: new Date(Date.now() - 3600_000).toISOString(),
      isRead: true,
      isStarred: false,
      isArchived: true
    }
  ];
}

function emailDetailFallback(userId: string, emailId: string): EmailDetailDto | null {
  const summary = inboxFallback(userId).find((email) => email.id === emailId);
  if (!summary) {
    return null;
  }

  return {
    id: summary.id,
    userId,
    sender: summary.sender,
    recipient: `${userId}@mailflare.dev`,
    subject: summary.subject,
    snippet: summary.snippet,
    receivedAt: summary.receivedAt,
    bodyText: summary.snippet,
    bodyHtml: '',
    isRead: summary.isRead,
    isStarred: summary.isStarred,
    isArchived: summary.isArchived
  };
}

function parseBooleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

function parseNumberSetting(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseListSetting(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

const workerFallback: WorkerSettingsPageDto = {
  settings: {
    botStatus: 'Token belum ada',
    botTokenConfigured: false,
    webhookSecretConfigured: false,
    allowedIds: '',
    forwardInbound: false,
    targetMode: 'All Allowed IDs',
    defaultChatId: '',
    testChatId: ''
  },
  webhook: {
    connected: false,
    url: '',
    ipAddress: '',
    maxConnections: 0,
    pendingUpdates: 0,
    allowedUpdates: [],
    lastErrorAt: '',
    lastErrorMessage: '',
    source: 'settings'
  }
};
