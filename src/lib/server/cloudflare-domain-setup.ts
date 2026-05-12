export interface CloudflareDomainSetupEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_WORKER_NAME?: string;
  MAILFLARE_EMAIL_WORKER_NAME?: string;
}

export interface CloudflareMailboxDomainSetupResult {
  ok: boolean;
  created: boolean;
  zoneId: string;
  zoneStatus: string;
  nameservers: string[];
  emailRoutingEnabled: boolean;
  emailRoutingStatus: string;
  message: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

interface CloudflareZone {
  id: string;
  name: string;
  status?: string;
  name_servers?: string[];
}

interface EmailRoutingSettings {
  enabled?: boolean;
  status?: string;
  name?: string;
}

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export async function ensureCloudflareMailboxDomainSetup(
  env: CloudflareDomainSetupEnv | undefined,
  domain: string
): Promise<CloudflareMailboxDomainSetupResult> {
  const token = String(env?.CLOUDFLARE_API_TOKEN ?? '').trim();
  const accountId = String(env?.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const normalizedDomain = domain.trim().toLowerCase();

  if (!token || !accountId) {
    return {
      ok: false,
      created: false,
      zoneId: '',
      zoneStatus: 'unconfigured',
      nameservers: [],
      emailRoutingEnabled: false,
      emailRoutingStatus: 'unconfigured',
      message: 'Token API atau account Cloudflare belum dikonfigurasi'
    };
  }

  const existingZone = await findZoneByName(token, accountId, normalizedDomain);
  const zone = existingZone ?? (await createZone(token, accountId, normalizedDomain));
  const created = !existingZone;
  const zoneStatus = String(zone.status ?? '').trim().toLowerCase() || 'unknown';
  const nameservers = normalizeNameservers(zone.name_servers ?? []);

  try {
    if (zoneStatus === 'pending') {
      await requestActivationCheck(token, zone.id).catch(() => undefined);
    }

    let routing = await getEmailRoutingSettings(token, zone.id);
    if (routing.status === 'unconfigured' || routing.status === 'misconfigured' || routing.status === 'unlocked') {
      await enableEmailRoutingDns(token, zone.id);
      routing = await getEmailRoutingSettings(token, zone.id);
    } else if (routing.status === 'misconfigured/locked') {
      await unlockEmailRoutingDns(token, zone.id);
      routing = await getEmailRoutingSettings(token, zone.id);
    }

    return {
      ok: true,
      created,
      zoneId: zone.id,
      zoneStatus,
      nameservers,
      emailRoutingEnabled: routing.enabled,
      emailRoutingStatus: routing.status,
      message: created ? 'Zone dibuat dan Email Routing Cloudflare tersinkron' : 'Email Routing Cloudflare tersinkron'
    };
  } catch (error) {
    return {
      ok: false,
      created,
      zoneId: zone.id,
      zoneStatus,
      nameservers,
      emailRoutingEnabled: false,
      emailRoutingStatus: 'error',
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function syncCloudflareMailboxDomain(
  env: CloudflareDomainSetupEnv | undefined,
  zoneId: string
): Promise<CloudflareMailboxDomainSetupResult> {
  const token = String(env?.CLOUDFLARE_API_TOKEN ?? '').trim();
  const normalizedZoneId = zoneId.trim();
  if (!token || !normalizedZoneId) {
    return {
      ok: false,
      created: false,
      zoneId: normalizedZoneId,
      zoneStatus: 'unconfigured',
      nameservers: [],
      emailRoutingEnabled: false,
      emailRoutingStatus: 'unconfigured',
      message: 'Token API atau zone Cloudflare belum dikonfigurasi'
    };
  }

  const zone = await getZone(token, normalizedZoneId);
  return ensureCloudflareMailboxDomainSetup(
    {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: env?.CLOUDFLARE_ACCOUNT_ID
    },
    zone.name
  );
}

export function resolveCloudflareWorkerName(env: CloudflareDomainSetupEnv | undefined): string {
  return String(env?.CLOUDFLARE_EMAIL_WORKER_NAME ?? env?.MAILFLARE_EMAIL_WORKER_NAME ?? '').trim();
}

async function findZoneByName(token: string, accountId: string, domain: string): Promise<CloudflareZone | null> {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/zones?name=${encodeURIComponent(domain)}&account.id=${encodeURIComponent(accountId)}&per_page=20`,
    {
      headers: buildHeaders(token)
    }
  );
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<CloudflareZone[]> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Gagal memuat daftar zone Cloudflare', payload));
  }

  return payload.result?.find((zone) => String(zone.name ?? '').trim().toLowerCase() === domain) ?? null;
}

async function createZone(token: string, accountId: string, domain: string): Promise<CloudflareZone> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      account: { id: accountId },
      name: domain,
      type: 'full'
    })
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<CloudflareZone> | null;
  if (!response.ok || !payload?.success || !payload.result) {
    throw new Error(formatCloudflareError('Gagal membuat zone Cloudflare', payload));
  }

  return payload.result;
}

async function getZone(token: string, zoneId: string): Promise<CloudflareZone> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}`, {
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<CloudflareZone> | null;
  if (!response.ok || !payload?.success || !payload.result) {
    throw new Error(formatCloudflareError('Gagal memuat zone Cloudflare', payload));
  }

  return payload.result;
}

async function requestActivationCheck(token: string, zoneId: string): Promise<void> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/activation_check`, {
    method: 'PUT',
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<unknown> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Gagal meminta pengecekan aktivasi zone', payload));
  }
}

async function getEmailRoutingSettings(token: string, zoneId: string): Promise<{ enabled: boolean; status: string }> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing`, {
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<EmailRoutingSettings> | null;
  if (!response.ok || !payload?.success || !payload.result) {
    throw new Error(formatCloudflareError('Gagal memuat pengaturan Email Routing', payload));
  }

  return {
    enabled: payload.result.enabled === true,
    status: String(payload.result.status ?? '').trim().toLowerCase() || 'unknown'
  };
}

async function enableEmailRoutingDns(token: string, zoneId: string): Promise<void> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/dns`, {
    method: 'POST',
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<unknown> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Gagal mengaktifkan DNS Email Routing', payload));
  }
}

async function unlockEmailRoutingDns(token: string, zoneId: string): Promise<void> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/dns`, {
    method: 'PATCH',
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<unknown> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Gagal membuka kunci DNS Email Routing', payload));
  }
}

function buildHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

function formatCloudflareError(prefix: string, payload: CloudflareApiResponse<unknown> | null): string {
  const details = payload?.errors?.map((error) => error.message || error.code).filter(Boolean).join('; ');
  return details ? `${prefix}: ${details}` : prefix;
}

function normalizeNameservers(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean)));
}
