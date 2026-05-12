import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDotAliasInfo, getReceivableDotAliases } from '$lib/email-dot-aliases';
import { ensureEmailRoutingRulesForUsers } from '$lib/server/cloudflare-email-routing';
import { getUserByIdFromDb, getUserEmailAliasesInDb, storeUserEmailAliasesIfAvailableInDb } from '$lib/server/db';
import { GMAIL_MAIL_DOMAIN, isExternalMailDomain } from '$lib/server/external-mail-providers';

const GPT_DOT_ALIAS_PROVIDER = 'gpt_dot_alias';

export const GET: RequestHandler = async ({ platform, params, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const user = await getUserByIdFromDb(db, params.userId);
  if (!user) {
    return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
  }

  const payload = await buildAliasPayload(db, user.id, user.email);
  return json(payload);
};

export const POST: RequestHandler = async ({ platform, params, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const user = await getUserByIdFromDb(db, params.userId);
  if (!user) {
    return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
  }

  const aliases = getReceivableDotAliases(user.email);
  if (aliases.length === 0) {
    return json({ error: 'Email ini tidak punya variasi dot alias yang valid' }, { status: 400 });
  }

  const domain = user.email.split('@')[1]?.trim().toLowerCase() ?? '';
  if (domain === GMAIL_MAIL_DOMAIN) {
    return json({
      ...(await buildAliasPayload(db, user.id, user.email, aliases)),
      ok: true,
      routing: {
        ok: true,
        skipped: true,
        ruleIds: [],
        createdRuleIds: [],
        existingRuleIds: [],
        message: 'Alias dot Gmail aktif otomatis di Gmail. Mail Flare hanya menerima jika forwarding Gmail sudah aktif.'
      }
    });
  }

  if (isExternalMailDomain(domain)) {
    return json({ error: 'Alias dot otomatis hanya didukung untuk Gmail atau domain Mail Flare yang dikelola Cloudflare.' }, { status: 400 });
  }

  const stored = await storeUserEmailAliasesIfAvailableInDb(db, {
    userId: user.id,
    aliases,
    provider: GPT_DOT_ALIAS_PROVIDER
  });

  const routing = await ensureEmailRoutingRulesForUsers(platform?.env, stored.savedAliases, db).catch((error) => ({
    ok: false,
    skipped: false,
    ruleIds: [],
    createdRuleIds: [],
    existingRuleIds: [],
    message: error instanceof Error ? error.message : String(error)
  }));

  const payload = await buildAliasPayload(db, user.id, user.email);
  return json({
    ...payload,
    ok: routing.ok,
    createdAliases: stored.createdAliases,
    existingAliases: stored.existingAliases,
    skippedAliases: stored.skippedAliases,
    routing
  });
};

async function buildAliasPayload(db: D1Database, userId: string, email: string, overrideActiveAliases?: string[]) {
  const info = getDotAliasInfo(email);
  const activeAliases =
    overrideActiveAliases ?? (await getUserEmailAliasesInDb(db, userId, GPT_DOT_ALIAS_PROVIDER));

  return {
    email,
    aliases: info?.aliases.filter((alias) => alias !== info.email) ?? [],
    activeAliases,
    total: info?.total ?? 0,
    totalLabel: info?.totalLabel ?? '0',
    truncated: Boolean(info?.truncated)
  };
}
