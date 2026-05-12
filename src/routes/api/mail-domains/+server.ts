import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureCloudflareMailboxDomainSetup } from '$lib/server/cloudflare-domain-setup';
import { getMailDomains, isValidDomain, sanitizeDomain, upsertMailDomain } from '$lib/server/mail-domains';

export const GET: RequestHandler = async ({ platform }) => {
  const domains = await getMailDomains(platform?.env?.DB, platform?.env);
  return json({
    ok: true,
    payload: {
      domains
    }
  });
};

export const POST: RequestHandler = async ({ platform, request, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return json({ error: 'Database belum dikonfigurasi' }, { status: 503 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        domain?: string;
        setDefault?: boolean;
        setupCloudflare?: boolean;
      }
    | null;

  const normalizedDomain = sanitizeDomain(body?.domain ?? '');
  if (!isValidDomain(normalizedDomain)) {
    return json({ error: 'Format domain tidak valid' }, { status: 400 });
  }

  const setupCloudflare = body?.setupCloudflare !== false;
  const setDefault = body?.setDefault === true;

  try {
    const setupResult = setupCloudflare
      ? await ensureCloudflareMailboxDomainSetup(platform?.env, normalizedDomain)
      : {
          ok: true,
          created: false,
          zoneId: '',
          zoneStatus: 'unknown',
          nameservers: [],
          emailRoutingEnabled: false,
          emailRoutingStatus: 'unknown',
          message: 'Penyiapan Cloudflare dilewati'
        };

    const domains = await upsertMailDomain(db, platform?.env, {
      domain: normalizedDomain,
      zoneId: setupResult.zoneId,
      status: setupResult.zoneStatus,
      nameservers: setupResult.nameservers,
      isDefault: setDefault,
      emailRoutingEnabled: setupResult.emailRoutingEnabled,
      emailRoutingStatus: setupResult.emailRoutingStatus,
      lastSetupMessage: setupResult.message,
      lastSyncedAt: new Date().toISOString()
    });

    return json({
      ok: true,
      payload: {
        domains,
        setup: setupResult
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message || 'Gagal menambahkan domain kotak masuk' }, { status: 500 });
  }
};
