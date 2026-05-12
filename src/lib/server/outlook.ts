import type { OutlookConfigStatusDto, OutlookDnsPlanDto, OutlookDnsRecordDto, OutlookMailboxResultDto } from '$lib/types/dto';
import { isValidDomain, sanitizeDomain } from '$lib/server/mail-domains';

export interface OutlookEnv {
  OUTLOOK_TENANT_ID?: string;
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  OUTLOOK_LICENSE_SKU_ID?: string;
  OUTLOOK_INITIAL_DOMAIN?: string;
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_LICENSE_SKU_ID?: string;
  MICROSOFT_INITIAL_DOMAIN?: string;
}

export interface OutlookDnsPlanInput {
  domain: string;
  initialDomain?: string;
  verificationTxt?: string;
  includeDmarc?: boolean;
}

export interface CreateOutlookMailboxInput {
  email: string;
  displayName?: string;
  password?: string;
}

interface OutlookGraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  licenseSkuId: string;
}

interface MicrosoftGraphUser {
  id?: string;
  userPrincipalName?: string;
  displayName?: string;
}

interface MicrosoftGraphErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

export function getOutlookConfigStatus(env: OutlookEnv | undefined): OutlookConfigStatusDto {
  const tenantId = getEnvValue(env, 'OUTLOOK_TENANT_ID', 'MICROSOFT_TENANT_ID');
  const clientId = getEnvValue(env, 'OUTLOOK_CLIENT_ID', 'MICROSOFT_CLIENT_ID');
  const clientSecret = getEnvValue(env, 'OUTLOOK_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET');
  const licenseSkuId = getEnvValue(env, 'OUTLOOK_LICENSE_SKU_ID', 'MICROSOFT_LICENSE_SKU_ID');
  const initialDomain = normalizeOptionalDomain(getEnvValue(env, 'OUTLOOK_INITIAL_DOMAIN', 'MICROSOFT_INITIAL_DOMAIN'));

  return {
    graphConfigured: Boolean(tenantId && clientId && clientSecret && licenseSkuId),
    tenantConfigured: Boolean(tenantId),
    clientConfigured: Boolean(clientId),
    secretConfigured: Boolean(clientSecret),
    licenseConfigured: Boolean(licenseSkuId),
    initialDomain
  };
}

export async function createOutlookMailbox(
  env: OutlookEnv | undefined,
  input: CreateOutlookMailboxInput
): Promise<OutlookMailboxResultDto> {
  const config = getOutlookGraphConfig(env);
  if (!config) {
    throw new Error('Microsoft Graph belum dikonfigurasi. Isi OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, dan OUTLOOK_LICENSE_SKU_ID.');
  }

  const email = normalizeEmail(input.email);
  if (!email) {
    throw new Error('Format email Outlook tidak valid');
  }

  const displayName = String(input.displayName ?? '').trim() || email.split('@')[0];
  const password = String(input.password ?? '').trim() || generateStrongPassword();
  const accessToken = await getMicrosoftGraphToken(config);
  const user = await graphJson<MicrosoftGraphUser>(accessToken, '/users', {
    method: 'POST',
    body: JSON.stringify({
      accountEnabled: true,
      displayName,
      mailNickname: buildMailNickname(email),
      userPrincipalName: email,
      passwordProfile: {
        forceChangePasswordNextSignIn: false,
        password
      }
    })
  });

  const userId = String(user.id ?? '').trim();
  if (!userId) {
    throw new Error('Microsoft Graph tidak mengembalikan ID user Outlook');
  }

  await graphJson<unknown>(accessToken, `/users/${encodeURIComponent(userId)}/assignLicense`, {
    method: 'POST',
    body: JSON.stringify({
      addLicenses: [
        {
          skuId: config.licenseSkuId
        }
      ],
      removeLicenses: []
    })
  });

  return {
    id: userId,
    email,
    displayName: String(user.displayName ?? displayName),
    initialPassword: password,
    licenseAssigned: true,
    message: 'Mailbox Outlook berhasil dibuat dan license Microsoft 365 sudah ditetapkan.'
  };
}

export function buildOutlookDnsPlan(input: OutlookDnsPlanInput, env?: OutlookEnv): OutlookDnsPlanDto {
  const domain = sanitizeDomain(input.domain);
  if (!isValidDomain(domain)) {
    throw new Error('Format domain Outlook tidak valid');
  }

  const config = getOutlookConfigStatus(env);
  const initialDomain = normalizeOptionalDomain(input.initialDomain ?? config.initialDomain);
  const verificationTxt = normalizeVerificationTxt(input.verificationTxt ?? '');
  const includeDmarc = input.includeDmarc !== false;
  const mxTarget = `${domain.replace(/\./g, '-')}.mail.protection.outlook.com`;
  const records: OutlookDnsRecordDto[] = [];

  if (verificationTxt) {
    records.push({
      type: 'TXT',
      name: '@',
      value: verificationTxt,
      ttl: 'Auto',
      purpose: 'Verifikasi domain Microsoft 365',
      required: true,
      conflictsWithCloudflareRouting: false,
      note: 'Nilai MS=... harus diambil dari Microsoft 365 admin center untuk tenant kamu.'
    });
  }

  records.push(
    {
      type: 'MX',
      name: '@',
      value: mxTarget,
      priority: 0,
      ttl: 'Auto',
      purpose: 'Mengirim email masuk ke Exchange Online / Outlook',
      required: true,
      conflictsWithCloudflareRouting: true,
      note: 'Record ini menggantikan MX Cloudflare Email Routing pada domain yang sama.'
    },
    {
      type: 'TXT',
      name: '@',
      value: 'v=spf1 include:spf.protection.outlook.com -all',
      ttl: 'Auto',
      purpose: 'SPF untuk email keluar Microsoft 365',
      required: true,
      conflictsWithCloudflareRouting: true,
      note: 'Satu domain hanya boleh punya satu SPF TXT. Gabungkan manual kalau sudah ada SPF lain.'
    },
    {
      type: 'CNAME',
      name: 'autodiscover',
      value: 'autodiscover.outlook.com',
      ttl: 'Auto',
      purpose: 'Autodiscover Outlook',
      required: true,
      conflictsWithCloudflareRouting: false,
      note: 'Dipakai Outlook untuk menemukan konfigurasi mailbox otomatis.'
    }
  );

  if (initialDomain) {
    const dkimDomainKey = domain.replace(/\./g, '-');
    records.push(
      {
        type: 'CNAME',
        name: 'selector1._domainkey',
        value: `selector1-${dkimDomainKey}._domainkey.${initialDomain}`,
        ttl: 'Auto',
        purpose: 'DKIM selector 1 Microsoft 365',
        required: false,
        conflictsWithCloudflareRouting: false,
        note: 'Aktifkan DKIM di Microsoft 365 Defender/Exchange setelah record tersambung.'
      },
      {
        type: 'CNAME',
        name: 'selector2._domainkey',
        value: `selector2-${dkimDomainKey}._domainkey.${initialDomain}`,
        ttl: 'Auto',
        purpose: 'DKIM selector 2 Microsoft 365',
        required: false,
        conflictsWithCloudflareRouting: false,
        note: 'Nilai ini bergantung pada domain awal tenant .onmicrosoft.com.'
      }
    );
  }

  if (includeDmarc) {
    records.push({
      type: 'TXT',
      name: '_dmarc',
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      ttl: 'Auto',
      purpose: 'DMARC monitoring awal',
      required: false,
      conflictsWithCloudflareRouting: false,
      note: 'Mulai dari p=none agar aman, lalu naikkan ke quarantine/reject setelah pengiriman stabil.'
    });
  }

  const warnings = [
    'Jika MX domain dipindah ke Outlook, email masuk tidak lagi diproses oleh Cloudflare Email Routing/Mail Flare untuk domain itu.',
    'Verifikasi domain Microsoft 365 membutuhkan TXT MS=... yang unik dari Microsoft admin center.',
    'Mailbox Outlook baru membutuhkan tenant Microsoft 365 Business/Exchange Online dan license yang masih tersedia.'
  ];

  if (!initialDomain) {
    warnings.push('Isi domain awal tenant .onmicrosoft.com agar rencana DKIM bisa dihitung.');
  }

  if (!config.graphConfigured) {
    warnings.push('Otomatisasi pembuatan mailbox belum aktif karena kredensial Microsoft Graph belum lengkap di environment Worker.');
  }

  return {
    domain,
    mxTarget,
    initialDomain,
    graphConfigured: config.graphConfigured,
    canCreateMailbox: config.graphConfigured,
    records,
    warnings,
    nextSteps: [
      'Tambahkan domain di Microsoft 365 admin center, lalu salin TXT verifikasi MS=... ke form ini.',
      'Pasang record verifikasi dulu di Cloudflare dan jalankan Verify dari Microsoft 365.',
      'Setelah domain verified, baru pindahkan MX/SPF/Autodiscover ke Outlook jika siap mematikan Cloudflare Email Routing untuk domain itu.',
      'Konfigurasi Microsoft Graph diperlukan bila nanti sistem ini ingin membuat mailbox Outlook otomatis.'
    ]
  };
}

function getEnvValue(env: OutlookEnv | undefined, primary: keyof OutlookEnv, fallback: keyof OutlookEnv): string {
  return String(env?.[primary] ?? env?.[fallback] ?? '').trim();
}

function getOutlookGraphConfig(env: OutlookEnv | undefined): OutlookGraphConfig | null {
  const tenantId = getEnvValue(env, 'OUTLOOK_TENANT_ID', 'MICROSOFT_TENANT_ID');
  const clientId = getEnvValue(env, 'OUTLOOK_CLIENT_ID', 'MICROSOFT_CLIENT_ID');
  const clientSecret = getEnvValue(env, 'OUTLOOK_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET');
  const licenseSkuId = getEnvValue(env, 'OUTLOOK_LICENSE_SKU_ID', 'MICROSOFT_LICENSE_SKU_ID');

  if (!tenantId || !clientId || !clientSecret || !licenseSkuId) {
    return null;
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    licenseSkuId
  };
}

async function getMicrosoftGraphToken(config: OutlookGraphConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default'
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const payload = (await response.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || 'Gagal mengambil token Microsoft Graph');
  }

  return payload.access_token;
}

async function graphJson<T>(accessToken: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const payload = (await response.json().catch(() => null)) as T | MicrosoftGraphErrorResponse | null;
  if (!response.ok) {
    const graphError = payload as MicrosoftGraphErrorResponse | null;
    throw new Error(graphError?.error?.message || `Microsoft Graph gagal (${response.status})`);
  }

  return payload as T;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain || !isValidDomain(sanitizeDomain(domain))) {
    return '';
  }
  if (!/^[a-z0-9][a-z0-9._%+-]{0,62}$/.test(localPart)) {
    return '';
  }
  return `${localPart}@${sanitizeDomain(domain)}`;
}

function buildMailNickname(email: string): string {
  const localPart = email.split('@')[0] ?? 'mailbox';
  const nickname = localPart.replace(/[^a-z0-9]/gi, '').slice(0, 60);
  return nickname || `mailbox${Date.now()}`;
}

function generateStrongPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!#%+-_=';
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  const suffix = symbols[bytes[0] % symbols.length];
  return `Cmf${suffix}${body}9`;
}

function normalizeOptionalDomain(value: string): string {
  const domain = sanitizeDomain(value);
  return isValidDomain(domain) ? domain : '';
}

function normalizeVerificationTxt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return /^MS=ms/i.test(trimmed) ? trimmed : `MS=${trimmed.replace(/^ms/i, 'ms')}`;
}
