import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildOutlookDnsPlan, getOutlookConfigStatus } from '$lib/server/outlook';

export const GET: RequestHandler = async ({ platform, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  return json({
    ok: true,
    payload: {
      status: getOutlookConfigStatus(platform?.env)
    }
  });
};

export const POST: RequestHandler = async ({ platform, request, locals }) => {
  if (!locals.authenticated) {
    return json({ error: 'Belum masuk' }, { status: 401 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Isi JSON wajib dikirim' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        domain?: string;
        initialDomain?: string;
        verificationTxt?: string;
        includeDmarc?: boolean;
      }
    | null;

  if (!body) {
    return json({ error: 'Isi JSON tidak valid' }, { status: 400 });
  }

  try {
    const plan = buildOutlookDnsPlan(
      {
        domain: body.domain ?? '',
        initialDomain: body.initialDomain,
        verificationTxt: body.verificationTxt,
        includeDmarc: body.includeDmarc
      },
      platform?.env
    );

    return json({
      ok: true,
      payload: {
        plan,
        status: getOutlookConfigStatus(platform?.env)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message || 'Gagal membuat rencana DNS Outlook' }, { status: 400 });
  }
};
