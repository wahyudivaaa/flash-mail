import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';
import { getUserAuthByEmail, softDeleteUserInDb } from '$lib/server/db';
import { deleteEmailRoutingRulesForUser } from '$lib/server/cloudflare-email-routing';
import { resolveRequestedMailDomain, type MailDomainsEnv } from '$lib/server/mail-domains';
import {
  getExternalMailProvider,
  isExternalMailDomain,
  normalizeExternalMailDomain
} from '$lib/server/external-mail-providers';

type PublicErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

/**
 * Soft-delete a mailbox user via public API key.
 *
 * Body (JSON):
 *   { "email": "user@domain" }
 *   OR { "username": "user", "domain": "domain" }
 *
 * Behavior mirrors admin DELETE /api/users/[userId]:
 *   - remove CF email routing rules for the address
 *   - soft-delete user (password_hash=NULL, tombstone email)
 */
export const POST: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return publicError(400, 'BAD_REQUEST', 'Isi JSON wajib dikirim');
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: string; username?: string; domain?: string }
    | null;

  const email = await resolveTargetEmail(body, platform?.env?.DB, platform?.env);
  if (!email.ok) {
    return publicError(email.status, email.code, email.message);
  }

  const db = platform?.env?.DB;
  if (!db) {
    return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
  }

  try {
    const existing = await getUserAuthByEmail(db, email.value);
    if (!existing) {
      // Idempotent: already gone is success for farm cleanup
      return json({
        ok: true,
        data: {
          email: email.value,
          deleted: false,
          alreadyDeleted: true,
          reason: 'not_found'
        }
      });
    }

    if (!existing.passwordHash) {
      return json({
        ok: true,
        data: {
          email: email.value,
          userId: existing.id,
          deleted: false,
          alreadyDeleted: true,
          reason: 'already_deleted'
        }
      });
    }

    const routing = await deleteEmailRoutingRulesForUser(
      platform?.env,
      existing.email,
      db
    ).catch((error) => ({
      ok: false,
      skipped: false,
      deletedRuleIds: [] as string[],
      message: error instanceof Error ? error.message : String(error)
    }));

    const result = await softDeleteUserInDb(db, existing.id);
    if (!result.deleted && result.reason === 'protected_owner') {
      return publicError(400, 'BAD_REQUEST', 'Akun pemilik tidak bisa dinonaktifkan');
    }
    if (!result.deleted && result.reason === 'not_found') {
      return json({
        ok: true,
        data: {
          email: email.value,
          userId: existing.id,
          deleted: false,
          alreadyDeleted: true,
          reason: 'not_found'
        }
      });
    }
    if (!result.deleted && result.reason === 'already_deleted') {
      return json({
        ok: true,
        data: {
          email: email.value,
          userId: existing.id,
          deleted: false,
          alreadyDeleted: true,
          reason: 'already_deleted'
        }
      });
    }

    return json({
      ok: true,
      data: {
        email: email.value,
        userId: existing.id,
        deleted: true,
        alreadyDeleted: false,
        routing: {
          ok: routing.ok,
          skipped: routing.skipped,
          deletedRuleIds: routing.deletedRuleIds,
          message: routing.message
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
    }
    return publicError(500, 'INTERNAL_ERROR', 'Gagal menghapus pengguna');
  }
};

// Also accept DELETE method with same body semantics (some clients prefer DELETE).
export const DELETE: RequestHandler = POST;

async function resolveTargetEmail(
  body: { email?: string; username?: string; domain?: string } | null,
  db: D1Database | undefined,
  env: MailDomainsEnv | undefined
): Promise<
  | { ok: true; value: string }
  | { ok: false; status: number; code: PublicErrorCode; message: string }
> {
  const rawEmail = (body?.email ?? '').trim().toLowerCase();
  if (rawEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'Format email tidak valid' };
    }
    return { ok: true, value: rawEmail };
  }

  const usernameRaw = (body?.username ?? '').trim().toLowerCase();
  if (!usernameRaw) {
    return {
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: 'email atau username wajib diisi'
    };
  }
  if (usernameRaw.includes('@')) {
    return {
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: 'username tidak boleh berisi @ — kirim lewat field email'
    };
  }
  if (!/^[a-z0-9._-]+$/.test(usernameRaw)) {
    return {
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: 'username hanya boleh a-z, 0-9, titik, underscore, dan tanda hubung'
    };
  }

  try {
    const requestedDomain = normalizeExternalMailDomain(body?.domain);
    const configuredDomain = isExternalMailDomain(requestedDomain)
      ? requestedDomain
      : await resolveRequestedMailDomain(db, env, requestedDomain);
    return { ok: true, value: `${usernameRaw}@${configuredDomain}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Requested domain is not configured')) {
      return {
        ok: false,
        status: 400,
        code: 'BAD_REQUEST',
        message: 'Domain yang diminta belum dikonfigurasi'
      };
    }
    if (message.includes('Invalid domain format')) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'Format domain tidak valid' };
    }
    return {
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: 'Gagal resolve domain untuk username'
    };
  }
}

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
