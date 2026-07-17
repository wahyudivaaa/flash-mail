import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';

type PublicErrorCode = 'UNAUTHORIZED' | 'BAD_REQUEST' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'SERVICE_UNAVAILABLE';

type DestinationBody = {
  email?: unknown;
};

type CloudflareApiResponse<T> = {
  success: boolean;
  errors?: Array<{ code?: number | string; message?: string }>;
  result?: T;
};

type DestinationAddress = {
  id?: string;
  tag?: string;
  email?: string;
  verified?: string | null;
  created?: string;
  modified?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export const GET: RequestHandler = async ({ platform, request, url }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) return json(auth.error, { status: auth.status });

  const email = normalizeEmail(url.searchParams.get('email'));
  if (!email) return publicError(400, 'BAD_REQUEST', 'Email wajib valid');

  const config = getCloudflareConfig(platform?.env);
  if (!config.ok) return publicError(503, 'SERVICE_UNAVAILABLE', config.message);

  try {
    const destination = await findDestination(config.token, config.accountId, email);
    return json({
      ok: true,
      destination: destination ? serializeDestination(destination) : null
    });
  } catch (error) {
    return publicError(502, 'SERVICE_UNAVAILABLE', errorMessage(error));
  }
};

export const POST: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) return json(auth.error, { status: auth.status });

  let body: DestinationBody;
  try {
    body = (await request.json()) as DestinationBody;
  } catch {
    return publicError(400, 'BAD_REQUEST', 'Payload JSON tidak valid');
  }

  const email = normalizeEmail(body.email);
  if (!email) return publicError(400, 'BAD_REQUEST', 'Email wajib valid');

  const config = getCloudflareConfig(platform?.env);
  if (!config.ok) return publicError(503, 'SERVICE_UNAVAILABLE', config.message);

  try {
    const existing = await findDestination(config.token, config.accountId, email);
    if (existing) {
      return json({
        ok: true,
        created: false,
        destination: serializeDestination(existing)
      });
    }

    const created = await createDestination(config.token, config.accountId, email);
    return json({
      ok: true,
      created: true,
      destination: serializeDestination(created)
    });
  } catch (error) {
    return publicError(502, 'SERVICE_UNAVAILABLE', errorMessage(error));
  }
};

function getCloudflareConfig(env: App.Platform['env'] | undefined): { ok: true; token: string; accountId: string } | { ok: false; message: string } {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  if (!token || !accountId) {
    return { ok: false, message: 'Cloudflare token/account belum dikonfigurasi' };
  }
  return { ok: true, token, accountId };
}

async function findDestination(token: string, accountId: string, email: string): Promise<DestinationAddress | null> {
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/email/routing/addresses?per_page=50&page=${page}`, {
      headers: buildHeaders(token)
    });
    const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<DestinationAddress[]> | null;
    if (!response.ok || !payload?.success) {
      throw new Error(formatCloudflareError('Gagal memuat destination email Cloudflare', payload));
    }

    const destinations = payload.result ?? [];
    const match = destinations.find((destination) => normalizeEmail(destination.email) === email);
    if (match) return match;
    if (destinations.length < 50) break;
  }
  return null;
}

async function createDestination(token: string, accountId: string, email: string): Promise<DestinationAddress> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/email/routing/addresses`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ email })
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<DestinationAddress> | null;
  if (!response.ok || !payload?.success || !payload.result) {
    throw new Error(formatCloudflareError('Gagal membuat destination email Cloudflare', payload));
  }
  return payload.result;
}

function serializeDestination(destination: DestinationAddress) {
  return {
    id: String(destination.id ?? destination.tag ?? ''),
    email: normalizeEmail(destination.email),
    verified: Boolean(destination.verified),
    verifiedAt: destination.verified ?? null,
    createdAt: destination.created ?? null,
    modifiedAt: destination.modified ?? null
  };
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EMAIL_RE.test(email) && email.length <= 254 ? email : '';
}

function buildHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

function formatCloudflareError(prefix: string, payload: CloudflareApiResponse<unknown> | null): string {
  const details = payload?.errors?.map((error) => `${error.code || 'ERR'} ${error.message || ''}`.trim()).filter(Boolean).join('; ');
  return details ? `${prefix}: ${details}` : prefix;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Cloudflare email destination failed');
}

function publicError(status: number, code: PublicErrorCode, message: string) {
  return json(
    {
      ok: false,
      error: {
        code,
        message
      }
    },
    { status }
  );
}
