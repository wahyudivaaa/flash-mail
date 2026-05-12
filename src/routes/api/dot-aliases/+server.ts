import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  getStandaloneDotAliasInfo,
  isGmailDotTrickDomain,
  MAX_DOT_ALIAS_VARIANTS,
  MAX_STANDALONE_DOT_ALIAS_VARIANTS
} from '$lib/email-dot-aliases';
import { ensureEmailRoutingRulesForUsers } from '$lib/server/cloudflare-email-routing';
import {
  deleteDotAliasGenerationInDb,
  getDotAliasGenerationsFromDb,
  getUserAuthByEmail,
  storeDotAliasGenerationInDb,
  storeUserEmailAliasesIfAvailableInDb
} from '$lib/server/db';
import { isExternalMailDomain } from '$lib/server/external-mail-providers';

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
  const info = getStandaloneDotAliasInfo(email);
  const aliases =
    info?.aliases.filter((alias) => alias !== info.email).slice(0, MAX_STANDALONE_DOT_ALIAS_VARIANTS) ?? [];
  if (!info || aliases.length === 0) {
    return json({ error: 'Email ini tidak punya variasi dot alias yang valid' }, { status: 400 });
  }

  const domain = info.email.split('@')[1]?.trim().toLowerCase() ?? '';
  const provider = isGmailDotTrickDomain(domain) ? 'gmail' : isExternalMailDomain(domain) ? domain : 'mailflare';
  const generation = await storeDotAliasGenerationInDb(db, {
    sourceEmail: info.email,
    provider,
    aliases,
    totalLabel: info.totalVariantsLabel,
    truncated: info.truncated,
    createdBy: locals.sessionEmail
  });

  const activation = await maybeActivateMailFlareAliases(db, platform?.env, info.email, provider, aliases);
  const generations = await getDotAliasGenerationsFromDb(db);
  const refreshedGeneration = generations.find((item) => item.id === generation.id) ?? generation;
  return json({
    ok: true,
    generation: refreshedGeneration,
    generations,
    activation,
    capacity: info.capacity
  });
};

export const DELETE: RequestHandler = async ({ platform, request, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  const id = body?.id?.trim() ?? '';
  if (!id) {
    return json({ error: 'ID riwayat wajib dikirim' }, { status: 400 });
  }

  const result = await deleteDotAliasGenerationInDb(db, id);
  if (!result.deleted) {
    if (result.reason === 'missing_table') {
      return json({ error: 'Tabel riwayat dot alias belum tersedia' }, { status: 503 });
    }
    return json({ error: 'Riwayat dot alias tidak ditemukan' }, { status: 404 });
  }

  const generations = await getDotAliasGenerationsFromDb(db);
  return json({ ok: true, generations });
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

  const receivableAliases = aliases.slice(0, MAX_DOT_ALIAS_VARIANTS);
  const stored = await storeUserEmailAliasesIfAvailableInDb(db, {
    userId: user.id,
    aliases: receivableAliases,
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
    message:
      aliases.length > receivableAliases.length
        ? `${routing.message} Untuk keamanan, auto-routing Cloudflare diaktifkan untuk ${receivableAliases.length} alias pertama dari ${aliases.length} alias tersimpan.`
        : routing.message,
    createdAliases: stored.createdAliases,
    existingAliases: stored.existingAliases,
    skippedAliases: stored.skippedAliases,
    routing
  };
}
