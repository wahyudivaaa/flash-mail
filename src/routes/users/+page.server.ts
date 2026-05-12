import type { PageServerLoad } from './$types';
import { getUsers } from '$lib/server/services/users.service';
import { getMailDomains } from '$lib/server/mail-domains';

export const load: PageServerLoad = async (event) => {
  const users = await getUsers(event);
  const domains = await getMailDomains(event.platform?.env?.DB, event.platform?.env);
  return { users, domains };
};
