import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';

type PublicErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export const GET: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
  }

  const url = new URL(request.url);
  const usernameRaw = (url.searchParams.get('username') ?? '').trim().toLowerCase();
  const invalidReason = validateUsername(usernameRaw);
  if (invalidReason) {
    return publicError(400, 'BAD_REQUEST', invalidReason);
  }

  const limit = parseIntegerRange(url.searchParams.get('limit'), 20, 1, 100);
  if (!limit.ok) {
    return publicError(400, 'BAD_REQUEST', limit.error);
  }
  const offset = parseIntegerRange(url.searchParams.get('offset'), 0, 0, 1_000_000);
  if (!offset.ok) {
    return publicError(400, 'BAD_REQUEST', offset.error);
  }

  const includeArchivedRaw = (url.searchParams.get('include_archived') ?? 'false').trim().toLowerCase();
  if (includeArchivedRaw !== 'true' && includeArchivedRaw !== 'false') {
    return publicError(400, 'BAD_REQUEST', 'include_archived harus true atau false');
  }
  const includeArchived = includeArchivedRaw === 'true';

  try {
    const user = await db
      .prepare(
        `
        SELECT id, email
        FROM users
        WHERE lower(substr(email, 1, instr(email, '@') - 1)) = lower(?)
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      )
      .bind(usernameRaw)
      .first<{ id: string; email: string }>();

    if (!user) {
      return publicError(404, 'NOT_FOUND', 'Pengguna tidak ditemukan');
    }

    const archiveCondition = includeArchived ? '' : 'AND is_archived = 0';
    const [countRow, listRows] = await Promise.all([
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM emails
          WHERE user_id = ?
            AND deleted_at IS NULL
            ${archiveCondition}
        `
        )
        .bind(user.id)
        .first<{ count: number }>(),
      db
        .prepare(
          `
          SELECT id, sender, subject, snippet, received_at, is_read, is_starred, is_archived
          FROM emails
          WHERE user_id = ?
            AND deleted_at IS NULL
            ${archiveCondition}
        `
        )
        .bind(user.id)
        .all<Record<string, unknown>>()
    ]);

    const emails = (listRows.results ?? [])
      .map((row) => ({
        id: String(row.id ?? ''),
        sender: String(row.sender ?? ''),
        subject: String(row.subject ?? '(Tanpa Subjek)'),
        snippet: String(row.snippet ?? ''),
        receivedAt: String(row.received_at ?? ''),
        isRead: Number(row.is_read ?? 0) === 1,
        isStarred: Number(row.is_starred ?? 0) === 1,
        isArchived: Number(row.is_archived ?? 0) === 1
      }))
      .sort((a, b) => getDateTime(b.receivedAt) - getDateTime(a.receivedAt) || b.id.localeCompare(a.id))
      .slice(offset.value, offset.value + limit.value);

    return json({
      ok: true,
      data: {
        user: {
          id: user.id,
          username: extractUsername(user.email),
          email: user.email
        },
        total: Number(countRow?.count ?? 0),
        limit: limit.value,
        offset: offset.value,
        includeArchived,
        emails
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
    }
    return publicError(500, 'INTERNAL_ERROR', 'Gagal memuat kotak masuk pengguna');
  }
};

function publicError(status: number, code: PublicErrorCode, message: string) {
  return json(
    {
      ok: false,
      error: {
        code,
        message
      }
    },
    { status }
  );
}

function getDateTime(value: string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function validateUsername(usernameRaw: string): string | null {
  if (!usernameRaw) {
    return 'Nama pengguna wajib diisi';
  }
  if (usernameRaw.length < 3 || usernameRaw.length > 64) {
    return 'Nama pengguna harus 3-64 karakter';
  }
  if (usernameRaw.includes('@')) {
    return 'Nama pengguna tidak boleh berisi @';
  }
  if (!/^[a-z0-9._-]+$/.test(usernameRaw)) {
    return 'Nama pengguna hanya boleh a-z, 0-9, titik, underscore, dan tanda hubung';
  }
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(usernameRaw)) {
    return 'Nama pengguna harus diawali dan diakhiri huruf atau angka';
  }
  return null;
}

function parseIntegerRange(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (!raw || !raw.trim()) {
    return { ok: true, value: fallback };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, error: 'Parameter query harus berupa integer' };
  }
  if (parsed < min || parsed > max) {
    return { ok: false, error: `Parameter query harus berada dalam rentang ${min}-${max}` };
  }
  return { ok: true, value: parsed };
}

function extractUsername(email: string): string {
  return String(email.split('@')[0] ?? '').toLowerCase();
}
