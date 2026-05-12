import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveRequestedMailDomain } from '$lib/server/mail-domains';
import { generateRandomUserLocalPart } from '$lib/server/random-username';
import { isExternalMailDomain, normalizeExternalMailDomain } from '$lib/server/external-mail-providers';

export const GET: RequestHandler = async ({ locals, platform, url }) => {
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const requestedDomain = normalizeExternalMailDomain(url.searchParams.get('domain'));

  try {
    const domain = isExternalMailDomain(requestedDomain)
      ? requestedDomain
      : await resolveRequestedMailDomain(db, platform?.env, requestedDomain, locals.sessionEmail);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const username = generateRandomUserLocalPart();
      const email = `${username}@${domain}`;
      const existing = await db.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>();

      if (!existing) {
        return json({ username, email, domain });
      }
    }

    return json({ error: 'Belum bisa membuat nama pengguna unik. Silakan coba lagi.' }, { status: 409 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Requested domain is not configured')) {
      return json({ error: 'Domain yang diminta belum dikonfigurasi' }, { status: 400 });
    }
    if (message.includes('Invalid domain format')) {
      return json({ error: 'Format domain tidak valid' }, { status: 400 });
    }

    return json({ error: 'Gagal membuat nama pengguna' }, { status: 500 });
  }
};
