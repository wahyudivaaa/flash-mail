import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getKiroGithubClaimsFromDb } from '$lib/server/db';

export const load: PageServerLoad = async (event) => {
  if (event.locals.sessionRole !== 'owner') {
    throw error(403, 'Akses ditolak');
  }

  const claims = await getKiroGithubClaimsFromDb(event.platform?.env?.DB);
  return { claims };
};
