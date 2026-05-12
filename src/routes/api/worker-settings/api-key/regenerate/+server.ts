import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { regenerateApiKey } from '$lib/server/api-key';
import { sendApiKeyIssuedTelegramNotification } from '$lib/server/telegram';

export const POST: RequestHandler = async ({ locals, platform }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  try {
    const createdBy = `web:${locals.sessionEmail ?? 'owner'}`;
    const issued = await regenerateApiKey(platform?.env?.DB, {
      createdBy,
      name: 'worker-settings'
    });

    await sendApiKeyIssuedTelegramNotification(platform?.env?.DB, platform?.env, {
      apiKey: issued.apiKey,
      action: 'regenerated',
      createdBy,
      source: 'admin-web'
    }).catch(() => 0);

    return json({
      ok: true,
      payload: {
        apiKey: issued.apiKey,
        activeKey: issued.activeKey
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }
    return json({ error: 'Gagal membuat ulang kunci API' }, { status: 500 });
  }
};
