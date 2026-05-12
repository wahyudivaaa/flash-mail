import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMailDomainByName, sanitizeDomain } from '$lib/server/mail-domains';
import { createOutlookMailbox, getOutlookConfigStatus } from '$lib/server/outlook';

export const POST: RequestHandler = async ({ platform, request, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const status = getOutlookConfigStatus(platform?.env);
  if (!status.graphConfigured) {
    return json(
      {
        error:
          'Microsoft Graph belum siap. Tambahkan OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, dan OUTLOOK_LICENSE_SKU_ID ke secrets/vars Worker.'
      },
      { status: 501 }
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        email?: string;
        displayName?: string;
        password?: string;
      }
    | null;

  if (!body?.email) {
    return json({ error: 'Email Outlook wajib diisi' }, { status: 400 });
  }

  const domain = sanitizeDomain(body.email.split('@')[1] ?? '');
  if (!domain) {
    return json({ error: 'Domain Outlook tidak valid' }, { status: 400 });
  }

  const managedDomain = await getMailDomainByName(platform?.env?.DB, platform?.env, domain);
  if (!managedDomain) {
    return json({ error: 'Domain belum terdaftar di Domain Kotak Masuk sistem ini' }, { status: 400 });
  }

  try {
    const mailbox = await createOutlookMailbox(platform?.env, {
      email: body.email,
      displayName: body.displayName,
      password: body.password
    });

    return json({
      ok: true,
      payload: {
        mailbox
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message || 'Gagal membuat mailbox Outlook' }, { status: 500 });
  }
};
