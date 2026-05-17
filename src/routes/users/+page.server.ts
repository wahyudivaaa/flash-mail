import type { PageServerLoad } from './$types';
import { getUsers } from '$lib/server/services/users.service';
import { getMailDomains } from '$lib/server/mail-domains';

export const load: PageServerLoad = async (event) => {
  const initialQuery = event.url.searchParams.get('q') ?? '';
  const users = await getUsers(event, initialQuery);
  const domains = await getMailDomains(event.platform?.env?.DB, event.platform?.env);
  return { users, domains, initialQuery };
};
