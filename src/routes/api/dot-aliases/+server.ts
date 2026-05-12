import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDotAliasInfo, getReceivableDotAliases } from '$lib/email-dot-aliases';
import { ensureEmailRoutingRulesForUsers } from '$lib/server/cloudflare-email-routing';
import {
  getDotAliasGenerationsFromDb,
  getUserAuthByEmail,
  storeDotAliasGenerationInDb,
  storeUserEmailAliasesIfAvailableInDb
} from '$lib/server/db';
import { GMAIL_MAIL_DOMAIN, isExternalMailDomain } from '$lib/server/external-mail-providers';

const DOT_ALIAS_TOOL_PROVIDER = 'dot_alias_tool';

export const GET: RequestHandler = async ({ platform, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const generations = await getDotAliasGenerationsFromDb(platform?.env?.DB);
  return json({ ok: true, generations });
};

export const POST: RequestHandler = async ({ platform, request, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase() ?? '';
  const info = getDotAliasInfo(email);
  const aliases = getReceivableDotAliases(email);
  if (!info || aliases.length === 0) {
    return json({ error: 'Email ini tidak punya variasi dot alias yang valid' }, { status: 400 });
  }

  const domain = info.email.split('@')[1]?.trim().toLowerCase() ?? '';
  const provider = domain === GMAIL_MAIL_DOMAIN ? 'gmail' : isExternalMailDomain(domain) ? domain : 'mailflare';
  const generation = await storeDotAliasGenerationInDb(db, {
    sourceEmail: info.email,
    provider,
    aliases,
    totalLabel: info.totalLabel,
    truncated: info.truncated,
    createdBy: locals.sessionEmail
  });

  const activation = await maybeActivateMailFlareAliases(db, platform?.env, info.email, provider, aliases);
  const generations = await getDotAliasGenerationsFromDb(db);
  return json({
    ok: true,
    generation,
    generations,
    activation
  });
};

async function maybeActivateMailFlareAliases(
  db: D1Database,
  env: App.Platform['env'] | undefined,
  email: string,
  provider: string,
  aliases: string[]
) {
  if (provider === 'gmail') {
    return {
      attempted: false,
      ok: true,
      message: 'Alias dot Gmail tersimpan. Di Gmail, variasi dot otomatis masuk ke inbox utama Gmail.'
    };
  }

  if (provider !== 'mailflare') {
    return {
      attempted: false,
      ok: true,
      message: 'Alias disimpan sebagai riwayat. Domain eksternal tidak dibuatkan routing Cloudflare otomatis.'
    };
  }

  const user = await getUserAuthByEmail(db, email);
  if (!user?.id || !user.passwordHash) {
    return {
      attempted: false,
      ok: true,
      message: 'Alias disimpan sebagai riwayat. Agar bisa menerima di Mail Flare, email utama harus sudah ada sebagai pengguna aktif.'
    };
  }

  const stored = await storeUserEmailAliasesIfAvailableInDb(db, {
    userId: user.id,
    aliases,
    provider: DOT_ALIAS_TOOL_PROVIDER
  });

  const routing = await ensureEmailRoutingRulesForUsers(env, stored.savedAliases, db).catch((error) => ({
    ok: false,
    skipped: false,
    ruleIds: [],
    createdRuleIds: [],
    existingRuleIds: [],
    message: error instanceof Error ? error.message : String(error)
  }));

  return {
    attempted: true,
    ok: routing.ok,
    message: routing.message,
    createdAliases: stored.createdAliases,
    existingAliases: stored.existingAliases,
    skippedAliases: stored.skippedAliases,
    routing
  };
}
