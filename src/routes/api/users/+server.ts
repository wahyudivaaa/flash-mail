import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createUniqueEmailAliasInDb, createUserInDb, getUsersFromDb } from '$lib/server/db';
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

export const GET: RequestHandler = async ({ platform, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const users = await getUsersFromDb(platform?.env?.DB);
  return json({ users });
};

export const POST: RequestHandler = async ({ platform, request, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { username?: string; domain?: string } | null;
  const usernameRaw = body?.username?.trim().toLowerCase() ?? '';
  const requestedDomain = normalizeExternalMailDomain(body?.domain);

  if (!usernameRaw) {
    return json({ error: 'Nama pengguna wajib diisi' }, { status: 400 });
  }
  if (usernameRaw.length < 3 || usernameRaw.length > 64) {
    return json({ error: 'Nama pengguna harus 3-64 karakter' }, { status: 400 });
  }
  if (usernameRaw.includes('@')) {
    return json({ error: 'Nama pengguna tidak boleh berisi @' }, { status: 400 });
  }
  if (!/^[a-z0-9._-]+$/.test(usernameRaw)) {
    return json({ error: 'Nama pengguna hanya boleh a-z, 0-9, titik, underscore, dan tanda hubung' }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(usernameRaw)) {
    return json({ error: 'Nama pengguna harus diawali dan diakhiri huruf atau angka' }, { status: 400 });
  }

  try {
    const db = platform?.env?.DB;
    if (!db) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }

    const configuredDomain = isExternalMailDomain(requestedDomain)
      ? requestedDomain
      : await resolveRequestedMailDomain(db, platform?.env, requestedDomain, locals.sessionEmail);
    const externalProvider = getExternalMailProvider(configuredDomain);
    const email = `${usernameRaw}@${configuredDomain}`;
    const externalForwardingAddress = externalProvider
      ? await createUniqueEmailAliasInDb(db, {
          domain: await resolveForwardingMailDomain(db, platform?.env, locals.sessionEmail),
          localPart: `${externalProvider.aliasPrefix}-${usernameRaw}`
        })
      : '';
    const generatedPassword = generateSecurePassword(18);
    const passwordHash = await hashPassword(generatedPassword);
    const createdBy = locals.sessionEmail ?? 'dashboard-admin';
    const user = await createUserInDb(db, {
      email,
      displayName: usernameRaw,
      passwordHash,
      initialPassword: generatedPassword,
      credentialSource: createdBy,
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
    const telegramSentTo = await sendUserCreatedTelegramNotification(db, platform?.env, {
      username: usernameRaw,
      email,
      password: generatedPassword,
      createdBy
    }).catch(() => 0);

    return json(
      {
        ok: true,
        user,
        credentials: {
          username: usernameRaw,
          email,
          password: generatedPassword,
          outlookForwardingAddress: externalForwardingAddress
        },
        telegram: {
          sentTo: telegramSentTo
        },
        routing: {
          ok: routing.ok,
          skipped: routing.skipped,
          ruleId: routing.ruleId,
          message: routing.message
        }
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('unique') || message.toLowerCase().includes('users.email')) {
      return json({ error: 'Nama pengguna sudah ada pada domain yang dipilih' }, { status: 409 });
    }
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }
    if (message.includes('Requested domain is not configured')) {
      return json({ error: 'Domain yang diminta belum dikonfigurasi' }, { status: 400 });
    }
    if (message.includes('Invalid domain format')) {
      return json({ error: 'Format domain tidak valid' }, { status: 400 });
    }
    if (message.includes('No managed forwarding domain configured')) {
      return json({ error: 'Belum ada domain Mail Flare untuk alamat penampung Outlook' }, { status: 400 });
    }

    return json({ error: 'Gagal membuat pengguna' }, { status: 500 });
  }
};

async function resolveForwardingMailDomain(
  db: D1Database,
  env: MailDomainsEnv | undefined,
  sessionEmail?: string
): Promise<string> {
  const domains = await getMailDomains(db, env);
  const defaultDomain = domains.find((domain) => domain.isDefault && !isExternalMailDomain(domain.domain))?.domain;
  if (defaultDomain) {
    return defaultDomain;
  }

  const firstManagedDomain = domains.find((domain) => !isExternalMailDomain(domain.domain))?.domain;
  if (firstManagedDomain) {
    return firstManagedDomain;
  }

  const sessionDomain = sessionEmail?.split('@')[1]?.trim().toLowerCase() ?? '';
  if (sessionDomain && !isExternalMailDomain(sessionDomain)) {
    return sessionDomain;
  }

  throw new Error('No managed forwarding domain configured');
}
