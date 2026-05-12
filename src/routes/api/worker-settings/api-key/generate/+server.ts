import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { API_KEY_NAME_WORKER_SETTINGS, generateApiKeyIfAbsent, normalizeApiKeyName } from '$lib/server/api-key';
import { sendApiKeyIssuedTelegramNotification } from '$lib/server/telegram';

export const POST: RequestHandler = async ({ locals, platform, request }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }
  if (locals.sessionRole !== 'owner') {
    return json({ error: 'Akses ditolak' }, { status: 403 });
  }

  try {
    const body = (await request.json().catch(() => null)) as { name?: string } | null;
    const name = normalizeApiKeyName(body?.name || API_KEY_NAME_WORKER_SETTINGS);
    const createdBy = `web:${locals.sessionEmail ?? 'owner'}`;
    const result = await generateApiKeyIfAbsent(platform?.env?.DB, {
      createdBy,
      name
    });

    if (!result.ok) {
      return json(
        {
          ok: false,
          error: 'Kunci API aktif sudah ada',
          payload: {
            hasActiveKey: true,
            activeKey: result.activeKey
          }
        },
        { status: 409 }
      );
    }

    await sendApiKeyIssuedTelegramNotification(platform?.env?.DB, platform?.env, {
      apiKey: result.issued.apiKey,
      action: 'generated',
      createdBy,
      source: name
    }).catch(() => 0);

    return json({
      ok: true,
      payload: {
        apiKey: result.issued.apiKey,
        activeKey: result.issued.activeKey
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }
    return json({ error: 'Gagal membuat kunci API' }, { status: 500 });
  }
};
