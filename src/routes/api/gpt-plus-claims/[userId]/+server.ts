import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteEmailRoutingRulesForUser } from '$lib/server/cloudflare-email-routing';
import { getUserByIdFromDb, softDeleteUserInDb } from '$lib/server/db';

export const DELETE: RequestHandler = async ({ platform, params, request, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const confirmation = request.headers.get('x-mailflare-confirm');
  if (confirmation !== 'delete-deactivated-gpt-user') {
    return json({ error: 'Header konfirmasi hapus akun GPT belum dikirim' }, { status: 400 });
  }

  try {
    const existingUser = await getUserByIdFromDb(platform?.env?.DB, params.userId);
    if (!existingUser) {
      return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
    }

    if (existingUser.gptPlusStatus !== 'deactivated') {
      return json({ error: 'Akun GPT ini belum berstatus dinonaktifkan' }, { status: 409 });
    }

    const routing = await deleteEmailRoutingRulesForUser(platform?.env, existingUser.email, platform?.env?.DB).catch((error) => ({
      ok: false,
      skipped: false,
      deletedRuleIds: [],
      message: error instanceof Error ? error.message : String(error)
    }));

    const result = await softDeleteUserInDb(platform?.env?.DB, params.userId);
    if (!result.deleted && result.reason === 'not_found') {
      return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
    }
    if (!result.deleted && result.reason === 'protected_owner') {
      return json({ error: 'Akun pemilik tidak bisa dinonaktifkan' }, { status: 400 });
    }
    if (!result.deleted && result.reason === 'already_deleted') {
      return json({ ok: true, alreadyDeleted: true, routing });
    }

    return json({
      ok: true,
      routing: {
        ok: routing.ok,
        skipped: routing.skipped,
        deletedRuleIds: routing.deletedRuleIds,
        message: routing.message
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }

    return json({ error: 'Gagal menghapus akun GPT yang dinonaktifkan' }, { status: 500 });
  }
};
