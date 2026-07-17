import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticatePublicApiRequest } from '$lib/server/api-key';

type PublicErrorCode = 'UNAUTHORIZED' | 'BAD_REQUEST' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'SERVICE_UNAVAILABLE';

type SendEmailBody = {
  to?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  fromEmail?: unknown;
  fromName?: unknown;
};

type EmailBinding = {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<unknown>;
};

type SendAttempt = {
  ok: boolean;
  configured: boolean;
  provider: string;
  error?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FROM_EMAIL = 'supportflashotp@flashdev.store';
const DEFAULT_FROM_NAME = 'Flash OTP';
const MAX_SUBJECT_LENGTH = 180;
const MAX_HTML_LENGTH = 120_000;
const MAX_TEXT_LENGTH = 20_000;

export const POST: RequestHandler = async ({ platform, request }) => {
  const auth = await authenticatePublicApiRequest(platform?.env?.DB, request);
  if (!auth.ok) {
    return json(auth.error, { status: auth.status });
  }

  const env = platform?.env;
  const allowedFrom = normalizeAllowedFrom(env?.MAILFLARE_ALLOWED_SENDERS);
  const defaultFromEmail = env?.MAILFLARE_DEFAULT_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;
  const defaultFromName = env?.MAILFLARE_DEFAULT_FROM_NAME?.trim() || DEFAULT_FROM_NAME;

  let body: SendEmailBody;
  try {
    body = (await request.json()) as SendEmailBody;
  } catch {
    return publicError(400, 'BAD_REQUEST', 'Payload JSON tidak valid');
  }

  const to = normalizeEmail(body.to);
  const fromEmail = normalizeEmail(typeof body.fromEmail === 'string' && body.fromEmail ? body.fromEmail : defaultFromEmail);
  const fromName = normalizeText(body.fromName, 80) || defaultFromName;
  const subject = normalizeText(body.subject, MAX_SUBJECT_LENGTH);
  const html = normalizeText(body.html, MAX_HTML_LENGTH);
  const text = normalizeText(body.text, MAX_TEXT_LENGTH);

  if (!to || !fromEmail || !subject || (!html && !text)) {
    return publicError(400, 'BAD_REQUEST', 'to, subject, dan html/text wajib valid');
  }

  if (!allowedFrom.has(fromEmail)) {
    return publicError(400, 'BAD_REQUEST', 'Alamat pengirim tidak diizinkan');
  }

  const sentViaBinding = isEnabled(env?.MAILFLARE_ENABLE_CLOUDFLARE_BINDING)
    ? await sendViaCloudflareBinding(env?.EMAIL, {
        to,
        fromEmail,
        fromName,
        subject,
        html,
        text
      })
    : {
        ok: false,
        configured: false,
        provider: 'cloudflare_binding',
        error: 'Cloudflare binding dinonaktifkan untuk email transactional'
      };
  if (sentViaBinding.ok) return json({ ok: true, provider: 'cloudflare_binding' });

  const sentViaRest = isEnabled(env?.MAILFLARE_ENABLE_CLOUDFLARE_REST)
    ? await sendViaCloudflareRest(env, {
        to,
        fromEmail,
        subject,
        html,
        text
      })
    : {
        ok: false,
        configured: false,
        provider: 'cloudflare_rest',
        error: 'Cloudflare REST Email Sending dinonaktifkan'
      };
  if (sentViaRest.ok) return json({ ok: true, provider: 'cloudflare_rest' });

  const sentViaMailChannels = isEnabled(env?.MAILFLARE_ENABLE_MAILCHANNELS)
    ? await sendViaMailChannels(env, {
        to,
        fromEmail,
        fromName,
        subject,
        html,
        text
      })
    : {
        ok: false,
        configured: false,
        provider: 'mailchannels',
        error: 'MailChannels dinonaktifkan karena perlu otorisasi domain'
      };
  if (sentViaMailChannels.ok) return json({ ok: true, provider: 'mailchannels' });

  const attempts = [sentViaBinding, sentViaRest, sentViaMailChannels];
  if (!attempts.some((attempt) => attempt.configured)) {
    return publicError(503, 'SERVICE_UNAVAILABLE', `Provider email outbound belum dikonfigurasi: ${summarizeAttempts(attempts)}`);
  }

  return publicError(
    502,
    'SERVICE_UNAVAILABLE',
    summarizeAttempts(attempts)
  );
};

async function sendViaCloudflareBinding(
  binding: EmailBinding | undefined,
  message: { to: string; fromEmail: string; fromName: string; subject: string; html: string; text: string }
): Promise<SendAttempt> {
  if (!binding) return { ok: false, configured: false, provider: 'cloudflare_binding', error: 'Binding EMAIL tidak tersedia' };
  try {
    await binding.send({
      to: message.to,
      from: { email: message.fromEmail, name: message.fromName },
      subject: message.subject,
      html: message.html || undefined,
      text: message.text || undefined
    });
    return { ok: true, configured: true, provider: 'cloudflare_binding' };
  } catch (error) {
    return { ok: false, configured: true, provider: 'cloudflare_binding', error: errorMessage(error) };
  }
}

async function sendViaCloudflareRest(
  env: App.Platform['env'] | undefined,
  message: { to: string; fromEmail: string; subject: string; html: string; text: string }
): Promise<SendAttempt> {
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env?.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    return { ok: false, configured: false, provider: 'cloudflare_rest', error: 'REST API token/account belum lengkap' };
  }

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        to: message.to,
        from: message.fromEmail,
        subject: message.subject,
        html: message.html || undefined,
        text: message.text || undefined
      })
    });
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ code?: number | string; message?: string }>;
    } | null;
    return {
      ok: response.ok && payload?.success === true,
      configured: true,
      provider: 'cloudflare_rest',
      error:
        response.ok && payload?.success === true
          ? undefined
          : payload?.errors?.map((item) => `${item.code || 'ERR'} ${item.message || ''}`.trim()).join('; ') ||
            `Cloudflare REST HTTP ${response.status}`
    };
  } catch (error) {
    return { ok: false, configured: true, provider: 'cloudflare_rest', error: errorMessage(error) };
  }
}

async function sendViaMailChannels(
  env: App.Platform['env'] | undefined,
  message: { to: string; fromEmail: string; fromName: string; subject: string; html: string; text: string }
): Promise<SendAttempt> {
  const apiKey = env?.MAILCHANNELS_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      provider: 'mailchannels',
      error: 'MailChannels API key belum dikonfigurasi'
    };
  }

  try {
    const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: {
          email: message.fromEmail,
          name: message.fromName
        },
        subject: message.subject,
        content: [
          ...(message.text ? [{ type: 'text/plain', value: message.text }] : []),
          ...(message.html ? [{ type: 'text/html', value: message.html }] : [])
        ]
      })
    });
    const errorText = response.ok || response.status === 202 ? '' : await response.text().catch(() => '');
    return {
      ok: response.ok || response.status === 202,
      configured: true,
      provider: 'mailchannels',
      error: response.ok || response.status === 202 ? undefined : `MailChannels HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`
    };
  } catch (error) {
    return { ok: false, configured: true, provider: 'mailchannels', error: errorMessage(error) };
  }
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EMAIL_RE.test(email) && email.length <= 254 ? email : '';
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeAllowedFrom(value: string | undefined): Set<string> {
  const configured = (value || DEFAULT_FROM_EMAIL)
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
  return new Set(configured.length ? configured : [DEFAULT_FROM_EMAIL]);
}

function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function summarizeAttempts(attempts: SendAttempt[]): string {
  return attempts
    .filter((attempt) => attempt.configured || attempt.error)
    .map((attempt) => `${attempt.provider}: ${attempt.error || 'ditolak'}`)
    .join(' | ')
    .slice(0, 240);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown email provider error');
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
