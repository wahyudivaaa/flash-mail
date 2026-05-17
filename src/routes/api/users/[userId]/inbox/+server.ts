import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserArchivedEmailCountFromDb, getUserInboxFromDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, platform, params, request }) => {
  const sessionUserId = locals.sessionUserId;
  const isOwner = locals.sessionRole === 'owner';
  if (!sessionUserId) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }
  if (!isOwner && sessionUserId !== params.userId) {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const query = new URL(request.url).searchParams.get('q') ?? '';
  const [emails, archivedCount] = await Promise.all([
    getUserInboxFromDb(platform?.env?.DB, params.userId, { query }),
    getUserArchivedEmailCountFromDb(platform?.env?.DB, params.userId)
  ]);
  return json({ userId: params.userId, emails, archivedCount });
};
