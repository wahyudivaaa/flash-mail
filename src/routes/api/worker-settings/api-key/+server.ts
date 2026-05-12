import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { API_KEY_NAME_WORKER_SETTINGS, getActiveApiKeyStatus, normalizeApiKeyName } from '$lib/server/api-key';

export const GET: RequestHandler = async ({ locals, platform, request }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const name = normalizeApiKeyName(url.searchParams.get('name') || API_KEY_NAME_WORKER_SETTINGS);
    const status = await getActiveApiKeyStatus(platform?.env?.DB, name);
    return json({
      ok: true,
      payload: status
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }
    return json({ error: 'Gagal memuat status kunci API' }, { status: 500 });
  }
};
