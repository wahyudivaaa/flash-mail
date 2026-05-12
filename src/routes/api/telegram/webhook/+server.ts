import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { processTelegramWebhookUpdate, verifyTelegramWebhookSecret } from '$lib/server/telegram';

export const POST: RequestHandler = async ({ request, platform }) => {
  const db = platform?.env?.DB;
  if (!db) {
    return json({ ok: true });
  }

  const secretHeader = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const validSecret = await verifyTelegramWebhookSecret(db, platform?.env, secretHeader);
  if (!validSecret) {
    return json({ error: 'Token rahasia webhook tidak valid' }, { status: 401 });
  }

  const update = await request.json().catch(() => null);
  if (!update) {
    return json({ error: 'Payload JSON tidak valid' }, { status: 400 });
  }

  await processTelegramWebhookUpdate({
    db,
    env: platform?.env,
    update
  });

  return json({ ok: true });
};
