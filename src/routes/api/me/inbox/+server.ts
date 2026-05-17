import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUserArchivedEmailCountFromDb, getUserInboxFromDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, platform, request }) => {
  const userId = locals.sessionUserId;
  if (!userId) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const query = new URL(request.url).searchParams.get('q') ?? '';
  const [emails, archivedCount] = await Promise.all([
    getUserInboxFromDb(platform?.env?.DB, userId, { query }),
    getUserArchivedEmailCountFromDb(platform?.env?.DB, userId)
  ]);
  return json({ userId, emails, archivedCount });
};
