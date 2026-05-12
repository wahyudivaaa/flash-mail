import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDotAliasGenerationsFromDb } from '$lib/server/db';

export const load: PageServerLoad = async (event) => {
  if (event.locals.sessionRole !== 'owner') {
    throw error(403, 'Akses ditolak');
  }

  const generations = await getDotAliasGenerationsFromDb(event.platform?.env?.DB);
  return { generations };
};
