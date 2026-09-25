import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectMailDomainReadiness, provisionMailDomain } from '$lib/server/mail-domain-provision';
import { getMailDomains, isValidDomain, sanitizeDomain, upsertMailDomain } from '$lib/server/mail-domains';

export const GET: RequestHandler = async ({ platform, url }) => {
  const db = platform?.env?.DB;
  const domains = await getMailDomains(db, platform?.env);

  // Domains saved before readiness tracking existed carry no state, which made
  // the settings page fall back to raw status labels. Verifying is a live
  // Cloudflare round trip per domain, so it only runs when asked for.
  if (url.searchParams.get('verify') !== '1' || !db) {
    return json({ ok: true, payload: { domains } });
  }

  const verified = await Promise.all(
    domains.map(async (record) => {
      const readiness = await inspectMailDomainReadiness(platform?.env, db, record);
      return { ...record, ...toReadinessFields(readiness) };
    })
  );

  return json({ ok: true, payload: { domains: verified } });
};

function toReadinessFields(readiness: {
  ready: boolean;
  state: string;
  delegationInstructions: string;
  zoneStatus: string;
  nameservers: string[];
  emailRoutingEnabled: boolean;
  emailRoutingStatus: string;
  message: string;
}) {
  return {
    ready: readiness.ready,
    readinessState: readiness.state,
    delegationInstructions: readiness.delegationInstructions,
    status: readiness.zoneStatus,
    nameservers: readiness.nameservers,
    emailRoutingEnabled: readiness.emailRoutingEnabled,
    emailRoutingStatus: readiness.emailRoutingStatus,
    lastSetupMessage: readiness.message
  };
}

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
    // Provisioning runs both Cloudflare steps -- zone + Email Routing DNS, then
    // the catch-all routing rule -- so a freshly added domain can accept mail
    // right away instead of needing a separate repair call.
    const provision = setupCloudflare
      ? await provisionMailDomain(platform?.env, db, normalizedDomain)
      : null;

    const domains = await upsertMailDomain(db, platform?.env, {
      domain: normalizedDomain,
      zoneId: provision?.zoneId ?? '',
      status: provision?.zoneStatus ?? 'unknown',
      nameservers: provision?.nameservers ?? [],
      isDefault: setDefault,
      emailRoutingEnabled: provision?.emailRoutingEnabled ?? false,
      emailRoutingStatus: provision?.emailRoutingStatus ?? 'unknown',
      lastSetupMessage: provision?.message ?? 'Penyiapan Cloudflare dilewati',
      lastSyncedAt: new Date().toISOString(),
      ready: provision?.ready ?? false,
      readinessState: provision?.state ?? '',
      delegationInstructions: provision?.delegationInstructions ?? ''
    });

    return json({
      ok: true,
      payload: {
        domains,
        provision,
        setup: provision
          ? {
              ok: provision.state !== 'failed',
              created: provision.zoneCreated,
              zoneId: provision.zoneId,
              zoneStatus: provision.zoneStatus,
              nameservers: provision.nameservers,
              emailRoutingEnabled: provision.emailRoutingEnabled,
              emailRoutingStatus: provision.emailRoutingStatus,
              message: provision.message
            }
          : {
              ok: true,
              created: false,
              zoneId: '',
              zoneStatus: 'unknown',
              nameservers: [],
              emailRoutingEnabled: false,
              emailRoutingStatus: 'unknown',
              message: 'Penyiapan Cloudflare dilewati'
            }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message || 'Gagal menambahkan domain kotak masuk' }, { status: 500 });
  }
};