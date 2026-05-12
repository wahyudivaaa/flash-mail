import { resolveCloudflareWorkerName } from '$lib/server/cloudflare-domain-setup';
import { getZoneIdForEmailDomain, type MailDomainsEnv } from '$lib/server/mail-domains';
import { APP_BRAND_NAME } from '$lib/config/brand';
import { getExternalMailRoutingMessage, isExternalMailDomain } from '$lib/server/external-mail-providers';

export interface CloudflareEmailRoutingEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_EMAIL_WORKER_NAME?: string;
  MAILFLARE_EMAIL_WORKER_NAME?: string;
}

export interface EnsureEmailRoutingRuleResult {
  ok: boolean;
  skipped: boolean;
  ruleId: string;
  message: string;
}

export interface EnsureEmailRoutingRulesResult {
  ok: boolean;
  skipped: boolean;
  ruleIds: string[];
  createdRuleIds: string[];
  existingRuleIds: string[];
  message: string;
}

export interface DeleteEmailRoutingRuleResult {
  ok: boolean;
  skipped: boolean;
  deletedRuleIds: string[];
  message: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

interface EmailRoutingRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export async function ensureEmailRoutingRuleForUser(
  env: CloudflareEmailRoutingEnv | undefined,
  email: string,
  db?: D1Database
): Promise<EnsureEmailRoutingRuleResult> {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const normalizedEmail = email.trim().toLowerCase();
  const domain = normalizedEmail.split('@')[1] ?? '';
  if (isExternalMailDomain(domain)) {
    return {
      ok: true,
      skipped: true,
      ruleId: '',
      message: getExternalMailRoutingMessage(domain)
    };
  }

  const zoneId =
    (await getZoneIdForEmailDomain(db, env as MailDomainsEnv | undefined, normalizedEmail)) || env?.CLOUDFLARE_ZONE_ID?.trim() || '';
  const workerName = resolveCloudflareWorkerName(env);

  if (!token || !zoneId || !workerName) {
    return {
      ok: false,
      skipped: true,
      ruleId: '',
      message: 'API Email Routing Cloudflare belum dikonfigurasi'
    };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return {
      ok: false,
      skipped: true,
      ruleId: '',
      message: 'Alamat email untuk aturan perutean tidak valid'
    };
  }

  const existing = await findExistingRule(token, zoneId, normalizedEmail, workerName);
  if (existing) {
    return {
      ok: true,
      skipped: false,
      ruleId: existing.id ?? '',
      message: 'Aturan Email Routing sudah ada'
    };
  }

  const created = await createRoutingRule(token, zoneId, normalizedEmail, workerName);
  return {
    ok: true,
    skipped: false,
    ruleId: created.id ?? '',
    message: 'Aturan Email Routing dibuat'
  };
}

export async function deleteEmailRoutingRulesForUser(
  env: CloudflareEmailRoutingEnv | undefined,
  email: string,
  db?: D1Database
): Promise<DeleteEmailRoutingRuleResult> {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const normalizedEmail = email.trim().toLowerCase();
  const routingEmails = await getRoutingEmailsForUser(db, normalizedEmail);
  const managedEmails = routingEmails.filter((candidate) => !isExternalMailDomain(candidate.split('@')[1] ?? ''));
  if (managedEmails.length === 0) {
    return {
      ok: true,
      skipped: true,
      deletedRuleIds: [],
      message: 'Routing Cloudflare dilewati karena akun memakai domain email eksternal.'
    };
  }

  const workerName = resolveCloudflareWorkerName(env);

  if (!token || !workerName) {
    return {
      ok: false,
      skipped: true,
      deletedRuleIds: [],
      message: 'API Email Routing Cloudflare belum dikonfigurasi'
    };
  }

  const deletedRuleIds: string[] = [];
  const groupedEmails = groupEmailsByDomain(managedEmails);
  for (const [domain, emails] of groupedEmails.entries()) {
    const zoneId = await getZoneIdForEmailDomain(db, env as MailDomainsEnv | undefined, domain);
    if (!zoneId) {
      return {
        ok: false,
        skipped: true,
        deletedRuleIds,
        message: `Zone ID untuk ${domain} belum dikonfigurasi`
      };
    }

    const rules = await listRoutingRules(token, zoneId);
    const emailSet = new Set(emails);
    for (const rule of rules) {
      const matchedEmail = getRuleMatchedEmail(rule);
      const sendsToWorker = rule.actions?.some((action) => action.type === 'worker' && action.value?.includes(workerName));
      if (!rule.id || !matchedEmail || !emailSet.has(matchedEmail) || !sendsToWorker) {
        continue;
      }
      await deleteRoutingRule(token, zoneId, rule.id);
      deletedRuleIds.push(rule.id);
    }
  }

  if (deletedRuleIds.length === 0) {
    return {
      ok: true,
      skipped: false,
      deletedRuleIds: [],
      message: 'Tidak ada aturan Email Routing untuk pengguna ini'
    };
  }

  return {
    ok: true,
    skipped: false,
    deletedRuleIds,
    message: deletedRuleIds.length === 1 ? 'Aturan Email Routing dihapus' : 'Aturan Email Routing dihapus'
  };
}

export async function ensureEmailRoutingRulesForUsers(
  env: CloudflareEmailRoutingEnv | undefined,
  emails: string[],
  db?: D1Database
): Promise<EnsureEmailRoutingRulesResult> {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const workerName = resolveCloudflareWorkerName(env);
  const normalizedEmails = [
    ...new Set(
      emails
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        .filter((email) => !isExternalMailDomain(email.split('@')[1] ?? ''))
    )
  ];

  if (normalizedEmails.length === 0) {
    return {
      ok: true,
      skipped: true,
      ruleIds: [],
      createdRuleIds: [],
      existingRuleIds: [],
      message: 'Tidak ada alias domain Mail Flare yang perlu dibuat routing.'
    };
  }

  if (!token || !workerName) {
    return {
      ok: false,
      skipped: true,
      ruleIds: [],
      createdRuleIds: [],
      existingRuleIds: [],
      message: 'API Email Routing Cloudflare belum dikonfigurasi'
    };
  }

  const createdRuleIds: string[] = [];
  const existingRuleIds: string[] = [];
  const groupedEmails = groupEmailsByDomain(normalizedEmails);
  for (const [domain, domainEmails] of groupedEmails.entries()) {
    const zoneId = await getZoneIdForEmailDomain(db, env as MailDomainsEnv | undefined, domain);
    if (!zoneId) {
      return {
        ok: false,
        skipped: true,
        ruleIds: [...existingRuleIds, ...createdRuleIds],
        createdRuleIds,
        existingRuleIds,
        message: `Zone ID untuk ${domain} belum dikonfigurasi`
      };
    }

    const rules = await listRoutingRules(token, zoneId);
    for (const email of domainEmails) {
      const existing = findRuleInList(rules, email, workerName);
      if (existing?.id) {
        existingRuleIds.push(existing.id);
        continue;
      }

      const created = await createRoutingRule(token, zoneId, email, workerName);
      if (created.id) {
        createdRuleIds.push(created.id);
      }
      rules.push(created);
    }
  }

  const total = existingRuleIds.length + createdRuleIds.length;
  return {
    ok: true,
    skipped: false,
    ruleIds: [...existingRuleIds, ...createdRuleIds],
    createdRuleIds,
    existingRuleIds,
    message:
      createdRuleIds.length > 0
        ? `${createdRuleIds.length} aturan Email Routing alias dibuat.`
        : `${total} aturan Email Routing alias sudah siap.`
  };
}

async function findExistingRule(
  token: string,
  zoneId: string,
  email: string,
  workerName: string
): Promise<EmailRoutingRule | null> {
  return (await findExistingRules(token, zoneId, email, workerName))[0] ?? null;
}

async function findExistingRules(
  token: string,
  zoneId: string,
  email: string,
  workerName: string
): Promise<EmailRoutingRule[]> {
  const rules = await listRoutingRules(token, zoneId);
  return rules.filter((rule) => Boolean(findRuleInList([rule], email, workerName)));
}

async function listRoutingRules(token: string, zoneId: string): Promise<EmailRoutingRule[]> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/rules?per_page=1000`, {
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<EmailRoutingRule[]> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Gagal memuat daftar aturan Email Routing', payload));
  }

  return payload.result ?? [];
}

function findRuleInList(rules: EmailRoutingRule[], email: string, workerName: string): EmailRoutingRule | null {
  return (
    rules.find((rule) => {
      const matchedEmail = getRuleMatchedEmail(rule);
      const sendsToWorker = rule.actions?.some(
        (action) => action.type === 'worker' && action.value?.includes(workerName)
      );
      return matchedEmail === email && Boolean(sendsToWorker);
    }) ?? null
  );
}

function getRuleMatchedEmail(rule: EmailRoutingRule): string {
  const matcher = rule.matchers?.find((item) => item.field === 'to' && item.value);
  return String(matcher?.value ?? '').trim().toLowerCase();
}

function groupEmailsByDomain(emails: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const email of emails) {
    const domain = email.split('@')[1] ?? '';
    if (!domain) {
      continue;
    }
    grouped.set(domain, [...(grouped.get(domain) ?? []), email]);
  }
  return grouped;
}

async function getRoutingEmailsForUser(db: D1Database | undefined, email: string): Promise<string[]> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!db || !normalizedEmail) {
    return normalizedEmail ? [normalizedEmail] : [];
  }

  try {
    const row = await db
      .prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1')
      .bind(normalizedEmail)
      .first<{ id: string }>();
    if (!row?.id) {
      return [normalizedEmail];
    }

    const response = await db
      .prepare(
        `
        SELECT alias_email
        FROM user_email_aliases
        WHERE user_id = ?
      `
      )
      .bind(String(row.id))
      .all<{ alias_email: string }>();

    return [
      normalizedEmail,
      ...(response.results ?? []).map((alias) => String(alias.alias_email ?? '').trim().toLowerCase()).filter(Boolean)
    ];
  } catch {
    return [normalizedEmail];
  }
}

async function createRoutingRule(token: string, zoneId: string, email: string, workerName: string): Promise<EmailRoutingRule> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/rules`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      name: `${APP_BRAND_NAME} ${email}`,
      enabled: true,
      priority: 0,
      matchers: [
        {
          type: 'literal',
          field: 'to',
          value: email
        }
      ],
      actions: [
        {
          type: 'worker',
          value: [workerName]
        }
      ]
    })
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<EmailRoutingRule> | null;
  if (!response.ok || !payload?.success || !payload.result) {
    throw new Error(formatCloudflareError('Gagal membuat aturan Email Routing', payload));
  }
  return payload.result;
}

async function deleteRoutingRule(token: string, zoneId: string, ruleId: string): Promise<void> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/rules/${ruleId}`, {
    method: 'DELETE',
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<unknown> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Gagal menghapus aturan Email Routing', payload));
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
