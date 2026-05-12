import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserByIdFromDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, platform }) => {
  const userId = locals.sessionUserId;
  if (!userId) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const user = await getUserByIdFromDb(platform?.env?.DB, userId);
  if (!user) {
    return json({ error: 'Pengguna tidak ditemukan' }, { status: 404 });
  }

  return json({ user });
};
