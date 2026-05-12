import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';
import { getExternalMailProvider } from '$lib/server/external-mail-providers';
import { getMailDomains } from '$lib/server/mail-domains';

type PublicErrorCode = 'UNAUTHORIZED' | 'BAD_REQUEST' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'SERVICE_UNAVAILABLE';

export const GET: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }

  const db = platform?.env?.DB;
  if (!db) {
    return publicError(503, 'SERVICE_UNAVAILABLE', 'Database belum dikonfigurasi');
  }

  try {
    const url = new URL(request.url);
    const apiBaseUrl = `${url.origin}/api/public/v1`;
    const domains = await getMailDomains(db, platform?.env);
    const defaultDomain = domains.find((domain) => domain.isDefault)?.domain ?? domains[0]?.domain ?? '';

    return json({
      ok: true,
      data: {
        service: {
          id: 'flash-mail-flare',
          label: 'Flash Mail Flare',
          apiVersion: 'v1',
          apiBaseUrl,
          compatibility: ['shiromail']
        },
        defaultDomain,
        domains: domains.map((domain) => {
          const externalProvider = getExternalMailProvider(domain.domain);
          return {
            domain: domain.domain,
            isDefault: domain.domain === defaultDomain,
            status: domain.status,
            emailRoutingStatus: domain.emailRoutingStatus,
            provider: externalProvider?.domain ?? 'mailflare',
            providerLabel: externalProvider?.label ?? 'Mail Flare',
            routingMode: externalProvider ? 'forwarding' : 'cloudflare_email_routing',
            canCreateUser: true
          };
        }),
        endpoints: {
          createUser: `${apiBaseUrl}/create_user`,
          listUser: `${apiBaseUrl}/list_user`,
          userMailbox: `${apiBaseUrl}/user_mailbox`,
          readEmail: `${apiBaseUrl}/read_email`,
          domains: `${apiBaseUrl}/domains`
        }
      }
    });
  } catch {
    return publicError(500, 'INTERNAL_ERROR', 'Gagal memuat daftar domain');
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
