import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchEmailsAcrossUsersFromDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, platform, request }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get('q') ?? '';
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const results = await searchEmailsAcrossUsersFromDb(platform?.env?.DB, { query, limit });

  return json({
    query: query.trim(),
    results,
    count: results.length
  });
};
