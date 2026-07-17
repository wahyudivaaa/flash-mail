import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';
import {
  ensureCatchAllEmailRoutingForManagedDomains,
  ensureCatchAllEmailRoutingRule
} from '$lib/server/cloudflare-email-routing';

type PublicErrorCode = 'UNAUTHORIZED' | 'BAD_REQUEST' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'SERVICE_UNAVAILABLE';

/**
 * Ensure Cloudflare Email Routing catch-all rules for farm domains.
 *
 * POST body optional: { "domain": "flashdev.org" }
 * Without domain: ensure catch-all for every managed mail domain.
 *
 * This is the fix path for "create_user OK but OTP never arrives":
 * new addresses no longer need a per-address rule to receive mail.
 */
export const POST: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
  }

  let domain = '';
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as { domain?: string } | null;
    domain = String(body?.domain ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@+/, '');
  }

  try {
    if (domain) {
      const result = await ensureCatchAllEmailRoutingRule(platform?.env, domain, db);
      return json({
        ok: result.ok,
        data: {
          mode: 'single',
          domain,
          ruleId: result.ruleId,
          skipped: result.skipped,
          message: result.message
        }
      });
    }

    const bulk = await ensureCatchAllEmailRoutingForManagedDomains(platform?.env, db);
    return json({
      ok: bulk.ok,
      data: {
        mode: 'all_managed',
        message: bulk.message,
        results: bulk.results
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return publicError(500, 'INTERNAL_ERROR', `Gagal memastikan Email Routing: ${message}`);
  }
};

export const GET: RequestHandler = async ({ platform, request }) => {
  // Same as POST without body — convenience for curl/browser smoke checks.
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }
  const db = platform?.env?.DB;
  if (!db) {
    return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
  }
  try {
    const bulk = await ensureCatchAllEmailRoutingForManagedDomains(platform?.env, db);
    return json({
      ok: bulk.ok,
      data: {
        mode: 'all_managed',
        message: bulk.message,
        results: bulk.results
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return publicError(500, 'INTERNAL_ERROR', `Gagal memastikan Email Routing: ${message}`);
  }
};

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
