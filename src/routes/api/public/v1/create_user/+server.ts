import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';
import { createUniqueEmailAliasInDb, createUserInDb } from '$lib/server/db';
import { generateSecurePassword, hashPassword } from '$lib/server/security';
import { sendUserCreatedTelegramNotification } from '$lib/server/telegram';
import { ensureEmailRoutingRuleForUser } from '$lib/server/cloudflare-email-routing';
import { getMailDomains, resolveRequestedMailDomain, type MailDomainsEnv } from '$lib/server/mail-domains';
import {
  getExternalMailRoutingMessage,
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

export const POST: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return publicError(400, 'BAD_REQUEST', 'Isi JSON wajib dikirim');
  }

  const body = (await request.json().catch(() => null)) as { username?: string; domain?: string } | null;
  const usernameRaw = body?.username?.trim().toLowerCase() ?? '';
  const requestedDomain = normalizeExternalMailDomain(body?.domain);
  const invalidReason = validateUsername(usernameRaw);
  if (invalidReason) {
    return publicError(400, 'BAD_REQUEST', invalidReason);
  }

  try {
    const db = platform?.env?.DB;
    if (!db) {
      return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
    }

    const configuredDomain = isExternalMailDomain(requestedDomain)
      ? requestedDomain
      : await resolveRequestedMailDomain(db, platform?.env, requestedDomain);
    const externalProvider = getExternalMailProvider(configuredDomain);
    const email = `${usernameRaw}@${configuredDomain}`;
    const externalForwardingAddress = externalProvider
      ? await createUniqueEmailAliasInDb(db, {
          domain: await resolveForwardingMailDomain(db, platform?.env),
          localPart: `${externalProvider.aliasPrefix}-${usernameRaw}`
        })
      : '';
    const generatedPassword = generateSecurePassword(18);
    const passwordHash = await hashPassword(generatedPassword);
    const user = await createUserInDb(db, {
      email,
      displayName: usernameRaw,
      passwordHash,
      initialPassword: generatedPassword,
      credentialSource: `api-key:${auth.key.id}`,
      emailAliases: externalForwardingAddress
        ? [
            {
              aliasEmail: externalForwardingAddress,
              provider: externalProvider?.aliasProvider
            }
          ]
        : []
    });
    const routing = externalProvider
      ? await ensureEmailRoutingRuleForUser(platform?.env, externalForwardingAddress, db)
          .then((result) => ({
            ...result,
            message: result.ok
              ? `Alamat penampung ${externalProvider.label} siap: ${externalForwardingAddress}. Atur ${externalProvider.label} untuk meneruskan email ke alamat ini.`
              : result.message
          }))
          .catch((error) => ({
            ok: false,
            skipped: false,
            ruleId: '',
            message: `${getExternalMailRoutingMessage(configuredDomain)} Gagal menyiapkan alamat penampung ${externalForwardingAddress}: ${
              error instanceof Error ? error.message : String(error)
            }`
          }))
      : await ensureEmailRoutingRuleForUser(platform?.env, email, db).catch((error) => ({
          ok: false,
          skipped: false,
          ruleId: '',
          message: error instanceof Error ? error.message : String(error)
        }));

    await sendUserCreatedTelegramNotification(db, platform?.env, {
      username: usernameRaw,
      email,
      password: generatedPassword,
      createdBy: `api-key:${auth.key.id}`
    }).catch(() => 0);

    return json(
      {
        ok: true,
        data: {
          user,
          credentials: {
            username: usernameRaw,
            email,
            password: generatedPassword,
            outlookForwardingAddress: externalForwardingAddress
          },
          routing: {
            ok: routing.ok,
            skipped: routing.skipped,
            ruleId: routing.ruleId,
            message: routing.message
          }
        }
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('unique') || message.toLowerCase().includes('users.email')) {
      return publicError(409, 'CONFLICT', 'Nama pengguna sudah ada pada domain yang dipilih');
    }
    if (message.includes('DB binding is required')) {
      return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
    }
    if (message.includes('Requested domain is not configured')) {
      return publicError(400, 'BAD_REQUEST', 'Domain yang diminta belum dikonfigurasi');
    }
    if (message.includes('Invalid domain format')) {
      return publicError(400, 'BAD_REQUEST', 'Format domain tidak valid');
    }
    if (message.includes('No managed forwarding domain configured')) {
      return publicError(400, 'BAD_REQUEST', 'Belum ada domain Mail Flare untuk alamat penampung Outlook');
    }
    return publicError(500, 'INTERNAL_ERROR', 'Gagal membuat pengguna');
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

async function resolveForwardingMailDomain(db: D1Database, env: MailDomainsEnv | undefined): Promise<string> {
  const domains = await getMailDomains(db, env);
  const defaultDomain = domains.find((domain) => domain.isDefault && !isExternalMailDomain(domain.domain))?.domain;
  if (defaultDomain) {
    return defaultDomain;
  }

  const firstManagedDomain = domains.find((domain) => !isExternalMailDomain(domain.domain))?.domain;
  if (firstManagedDomain) {
    return firstManagedDomain;
  }

  throw new Error('No managed forwarding domain configured');
}
