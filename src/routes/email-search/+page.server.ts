import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  if (event.locals.sessionRole !== 'owner') {
    throw error(403, 'Akses ditolak');
  }

  return {
    initialQuery: event.url.searchParams.get('q') ?? ''
  };
};
