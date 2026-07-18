import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGrokClaimsFromDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ platform, locals }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const claims = await getGrokClaimsFromDb(platform?.env?.DB);
  return json({ claims });
};
