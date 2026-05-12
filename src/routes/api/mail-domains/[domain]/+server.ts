import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureCloudflareMailboxDomainSetup } from '$lib/server/cloudflare-domain-setup';
import { getMailDomainByName, getMailDomains, removeMailDomain, sanitizeDomain, setDefaultMailDomain, upsertMailDomain } from '$lib/server/mail-domains';

export const PATCH: RequestHandler = async ({ platform, params, request, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const normalizedDomain = sanitizeDomain(params.domain ?? '');
  if (!normalizedDomain) {
    return json({ error: 'Domain wajib diisi' }, { status: 400 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  const action = String(body?.action ?? '').trim().toLowerCase();
  if (!action) {
    return json({ error: 'Aksi wajib diisi' }, { status: 400 });
  }

  try {
    if (action === 'set-default') {
      const domains = await setDefaultMailDomain(db, platform?.env, normalizedDomain);
      return json({ ok: true, payload: { domains } });
    }

    if (action === 'sync-cloudflare') {
      const existing = await getMailDomainByName(db, platform?.env, normalizedDomain);
      if (!existing) {
        return json({ error: 'Domain tidak ditemukan' }, { status: 404 });
      }

      const setup = await ensureCloudflareMailboxDomainSetup(platform?.env, normalizedDomain);
      const domains = await upsertMailDomain(db, platform?.env, {
        domain: normalizedDomain,
        zoneId: setup.zoneId || existing.zoneId,
        status: setup.zoneStatus,
        nameservers: setup.nameservers,
        isDefault: existing.isDefault,
        emailRoutingEnabled: setup.emailRoutingEnabled,
        emailRoutingStatus: setup.emailRoutingStatus,
        lastSetupMessage: setup.message,
        lastSyncedAt: new Date().toISOString()
      });

      return json({
        ok: true,
        payload: {
          domains,
          setup
        }
      });
    }

    return json({ error: 'Aksi tidak didukung' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Domain not found')) {
      return json({ error: 'Domain tidak ditemukan' }, { status: 404 });
    }
    return json({ error: message || 'Gagal memperbarui domain kotak masuk' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ platform, params, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const normalizedDomain = sanitizeDomain(params.domain ?? '');
  if (!normalizedDomain) {
    return json({ error: 'Domain wajib diisi' }, { status: 400 });
  }

  try {
    const activeUsers = await db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM users
        WHERE lower(substr(email, instr(email, '@') + 1)) = ?
          AND password_hash IS NOT NULL
      `
      )
      .bind(normalizedDomain)
      .first<{ count: number }>();

    if (Number(activeUsers?.count ?? 0) > 0) {
      return json({ error: 'Domain masih memiliki pengguna aktif' }, { status: 409 });
    }

    const domainsBefore = await getMailDomains(db, platform?.env);
    if (domainsBefore.length <= 1) {
      return json({ error: 'Minimal satu domain kotak masuk harus tetap dikonfigurasi' }, { status: 409 });
    }

    const domains = await removeMailDomain(db, platform?.env, normalizedDomain);
    return json({ ok: true, payload: { domains } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Domain not found')) {
      return json({ error: 'Domain tidak ditemukan' }, { status: 404 });
    }
    return json({ error: message || 'Gagal menghapus domain kotak masuk' }, { status: 500 });
  }
};
