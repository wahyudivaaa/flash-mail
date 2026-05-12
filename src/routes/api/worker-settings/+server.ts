import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateWorkerSettingsInDb } from '$lib/server/db';
import { getWorkerSettings } from '$lib/server/services/worker-settings.service';

export const GET: RequestHandler = async (event) => {
  const payload = await getWorkerSettings(event);
  return json(payload);
};

export const PATCH: RequestHandler = async ({ platform, request, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        botToken?: string;
        webhookSecret?: string;
        allowedIds?: string;
        forwardInbound?: boolean;
        targetMode?: string;
        defaultChatId?: string;
        testChatId?: string;
      }
    | null;

  if (!body) {
    return json({ error: 'Isi JSON tidak valid' }, { status: 400 });
  }

  const botToken = body.botToken !== undefined ? body.botToken.trim() : undefined;
  const webhookSecret = body.webhookSecret !== undefined ? body.webhookSecret.trim() : undefined;
  const allowedIds = body.allowedIds?.trim();
  const targetMode = body.targetMode?.trim();
  const defaultChatId = body.defaultChatId?.trim();
  const testChatId = body.testChatId?.trim();
  const forwardInbound = body.forwardInbound;

  if (
    botToken === undefined &&
    webhookSecret === undefined &&
    allowedIds === undefined &&
    targetMode === undefined &&
    defaultChatId === undefined &&
    testChatId === undefined &&
    forwardInbound === undefined
  ) {
    return json({ error: 'Tidak ada kolom untuk diperbarui' }, { status: 400 });
  }

  if (botToken !== undefined && botToken.length > 300) {
    return json({ error: 'Token bot terlalu panjang' }, { status: 400 });
  }
  if (webhookSecret !== undefined && webhookSecret.length > 300) {
    return json({ error: 'Token rahasia webhook terlalu panjang' }, { status: 400 });
  }
  if (allowedIds !== undefined && allowedIds.length > 1000) {
    return json({ error: 'Daftar ID yang diizinkan terlalu panjang' }, { status: 400 });
  }
  if (targetMode !== undefined && targetMode.length > 80) {
    return json({ error: 'Mode target terlalu panjang' }, { status: 400 });
  }
  if (defaultChatId !== undefined && defaultChatId.length > 80) {
    return json({ error: 'Chat ID bawaan terlalu panjang' }, { status: 400 });
  }
  if (testChatId !== undefined && testChatId.length > 80) {
    return json({ error: 'Chat ID tes terlalu panjang' }, { status: 400 });
  }
  if (forwardInbound !== undefined && typeof forwardInbound !== 'boolean') {
    return json({ error: 'Nilai teruskan email masuk harus boolean' }, { status: 400 });
  }

  try {
    const payload = await updateWorkerSettingsInDb(platform?.env?.DB, {
      botToken,
      webhookSecret,
      allowedIds,
      forwardInbound,
      targetMode,
      defaultChatId,
      testChatId
    });
    return json({ ok: true, payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DB binding is required')) {
      return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
    }
    return json({ error: 'Gagal memperbarui pengaturan worker' }, { status: 500 });
  }
};
