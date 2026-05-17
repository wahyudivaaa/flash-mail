import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureEmailRoutingRuleForUser } from '$lib/server/cloudflare-email-routing';
import { getUserByIdFromDb } from '$lib/server/db';

export const POST: RequestHandler = async ({ platform, params, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const user = await getUserByIdFromDb(platform?.env?.DB, params.userId);
  if (!user) {
    return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
  }
  if (user.status !== 'active') {
    return json({ error: 'Pengguna belum aktif' }, { status: 400 });
  }

  const routing = await ensureEmailRoutingRuleForUser(platform?.env, user.email, platform?.env?.DB).catch((error) => ({
    ok: false,
    skipped: false,
    ruleId: '',
    message: error instanceof Error ? error.message : String(error)
  }));

  return json({ ok: routing.ok, user, routing });
};
