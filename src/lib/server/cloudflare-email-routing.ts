import { resolveCloudflareWorkerName } from '$lib/server/cloudflare-domain-setup';
import { getZoneIdForEmailDomain, getMailDomains, type MailDomainsEnv } from '$lib/server/mail-domains';
import { APP_BRAND_NAME } from '$lib/config/brand';
import { getExternalMailRoutingMessage, isExternalMailDomain } from '$lib/server/external-mail-providers';

export interface CloudflareEmailRoutingEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
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
  result_info?: {
    page?: number;
    per_page?: number;
    count?: number;
    total_count?: number;
    total_pages?: number;
  };
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

  // Same rule as the catch-all path: only use the zone that actually owns this
  // domain. Blending in the env-wide CLOUDFLARE_ZONE_ID created rules on
  // flashdev.org for addresses on unrelated managed domains.
  const zoneId = await getZoneIdForEmailDomain(db, env as MailDomainsEnv | undefined, normalizedEmail);
  const validZoneId = isCloudflareZoneId(zoneId)
    ? zoneId
    : token
      ? await resolveZoneIdByDomainName(token, env?.CLOUDFLARE_ACCOUNT_ID, domain)
      : '';
  const workerName = resolveCloudflareWorkerName(env);

  if (!token || !validZoneId || !workerName) {
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

  // Prefer catch-all worker routing so brand-new mailboxes receive mail
  // without waiting for per-address rule propagation / hitting rule limits.
  try {
    const catchAll = await ensureCatchAllEmailRoutingRule(env, domain, db);
    if (catchAll.ok && catchAll.ruleId) {
      return {
        ok: true,
        skipped: catchAll.skipped,
        ruleId: catchAll.ruleId,
        message: catchAll.message
      };
    }
  } catch (error) {
    // Fall back to per-address rule if catch-all API fails for this zone.
    console.warn(
      `[email-routing] catch-all failed for ${domain}, fallback per-address: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const existing = await findExistingRule(token, validZoneId, normalizedEmail, workerName);
  if (existing) {
    return {
      ok: true,
      skipped: false,
      ruleId: existing.id ?? '',
      message: 'Aturan Email Routing sudah ada'
    };
  }

  const created = await createRoutingRule(token, validZoneId, normalizedEmail, workerName);
  return {
    ok: true,
    skipped: false,
    ruleId: created.id ?? '',
    message: 'Aturan Email Routing dibuat'
  };
}

/**
 * Ensure a catch-all Email Routing rule that sends ALL inbound mail for a
 * domain to the Mail Flare worker. This is the reliable path for farming:
 * create_user no longer depends on a fresh per-address rule being active
 * within seconds of OTP send.
 */
export async function ensureCatchAllEmailRoutingRule(
  env: CloudflareEmailRoutingEnv | undefined,
  domainOrEmail: string,
  db?: D1Database
): Promise<EnsureEmailRoutingRuleResult> {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const raw = domainOrEmail.trim().toLowerCase();
  const domain = raw.includes('@') ? raw.split('@')[1] ?? '' : raw.replace(/^@+/, '');
  if (!domain) {
    return { ok: false, skipped: true, ruleId: '', message: 'Domain routing tidak valid' };
  }
  if (isExternalMailDomain(domain)) {
    return {
      ok: true,
      skipped: true,
      ruleId: '',
      message: getExternalMailRoutingMessage(domain)
    };
  }

  // Resolve the zone for THIS domain only. Falling back to the env-wide
  // CLOUDFLARE_ZONE_ID used to point new domains at the default zone
  // (flashdev.org), which silently created the catch-all rule on the wrong
  // zone and left the new domain unable to receive mail.
  let zoneId = await getZoneIdForEmailDomain(db, env as MailDomainsEnv | undefined, domain);
  // Zone id must be a UUID. If mail_domains has garbage/empty, resolve via CF API by domain name.
  if (!isCloudflareZoneId(zoneId)) {
    zoneId = '';
  }
  if (!zoneId && token) {
    zoneId = await resolveZoneIdByDomainName(token, env?.CLOUDFLARE_ACCOUNT_ID, domain);
  }
  const workerName = resolveCloudflareWorkerName(env);
  if (!token || !zoneId || !workerName) {
    return {
      ok: false,
      skipped: true,
      ruleId: '',
      message: !token
        ? 'API Email Routing Cloudflare belum dikonfigurasi'
        : !zoneId
          ? `Zone Cloudflare tidak ditemukan untuk domain ${domain}`
          : 'Worker Email Routing belum dikonfigurasi'
    };
  }

  // Check dedicated catch_all resource first (authoritative).
  try {
    const catchAllResponse = await fetch(
      `${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/rules/catch_all`,
      { headers: buildHeaders(token) }
    );
    const catchAllPayload = (await catchAllResponse.json().catch(() => null)) as CloudflareApiResponse<EmailRoutingRule> | null;
    const existingDedicated = catchAllPayload?.result;
    const dedicatedWorker = existingDedicated?.actions?.some(
      (action) => action.type === 'worker' && action.value?.includes(workerName)
    );
    if (
      catchAllResponse.ok &&
      catchAllPayload?.success &&
      existingDedicated &&
      existingDedicated.enabled !== false &&
      dedicatedWorker
    ) {
      return {
        ok: true,
        skipped: false,
        ruleId: existingDedicated.id ?? 'catch_all',
        message: `Catch-all Email Routing ke worker sudah aktif untuk ${domain}`
      };
    }
  } catch {
    // fall through to create/update
  }

  const created = await createCatchAllRoutingRule(token, zoneId, domain, workerName);
  return {
    ok: true,
    skipped: false,
    ruleId: created.id ?? 'catch_all',
    message: `Catch-all Email Routing dibuat untuk ${domain} → ${workerName}`
  };
}

export async function ensureCatchAllEmailRoutingForManagedDomains(
  env: CloudflareEmailRoutingEnv | undefined,
  db?: D1Database
): Promise<{
  ok: boolean;
  results: Array<{ domain: string; ok: boolean; ruleId: string; message: string }>;
  message: string;
}> {
  const domains = await getMailDomains(db, env as MailDomainsEnv | undefined);
  const managed = domains
    .map((entry) => entry.domain)
    .filter((domain) => domain && !isExternalMailDomain(domain));
  const results: Array<{ domain: string; ok: boolean; ruleId: string; message: string }> = [];

  for (const domain of managed) {
    try {
      const result = await ensureCatchAllEmailRoutingRule(env, domain, db);
      results.push({
        domain,
        ok: result.ok,
        ruleId: result.ruleId,
        message: result.message
      });
    } catch (error) {
      results.push({
        domain,
        ok: false,
        ruleId: '',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const failed = results.filter((row) => !row.ok);
  return {
    ok: failed.length === 0,
    results,
    message:
      failed.length === 0
        ? `Catch-all siap untuk ${results.length} domain`
        : `Catch-all gagal di ${failed.length}/${results.length} domain`
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

export async function deleteEmailRoutingRulesForEmails(
  env: CloudflareEmailRoutingEnv | undefined,
  emails: string[],
  db?: D1Database
): Promise<DeleteEmailRoutingRuleResult> {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const workerName = resolveCloudflareWorkerName(env);
  const managedEmails = [
    ...new Set(
      emails
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        .filter((email) => !isExternalMailDomain(email.split('@')[1] ?? ''))
    )
  ];

  if (managedEmails.length === 0) {
    return {
      ok: true,
      skipped: true,
      deletedRuleIds: [],
      message: 'Tidak ada alias domain Mail Flare yang perlu dihapus routing.'
    };
  }

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
  for (const [domain, domainEmails] of groupedEmails.entries()) {
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
    const emailSet = new Set(domainEmails);
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

  return {
    ok: true,
    skipped: false,
    deletedRuleIds,
    message: deletedRuleIds.length > 0 ? 'Aturan Email Routing alias dihapus' : 'Tidak ada aturan Email Routing untuk alias ini'
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
  const perPage = 50;
  const rules: EmailRoutingRule[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/rules?per_page=${perPage}&page=${page}`,
      {
        headers: buildHeaders(token)
      }
    );
    const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<EmailRoutingRule[]> | null;
    if (!response.ok || !payload?.success) {
      throw new Error(formatCloudflareError('Gagal memuat daftar aturan Email Routing', payload));
    }

    rules.push(...(payload.result ?? []));
    totalPages = getTotalRoutingRulePages(payload.result_info, perPage);
    page += 1;
  }

  return rules;
}

function getTotalRoutingRulePages(
  resultInfo: CloudflareApiResponse<EmailRoutingRule[]>['result_info'],
  fallbackPerPage: number
): number {
  const explicitTotalPages = Number(resultInfo?.total_pages ?? 0);
  if (explicitTotalPages > 0) {
    return explicitTotalPages;
  }

  const totalCount = Number(resultInfo?.total_count ?? 0);
  const perPage = Number(resultInfo?.per_page ?? fallbackPerPage);
  if (totalCount > 0 && perPage > 0) {
    return Math.max(1, Math.ceil(totalCount / perPage));
  }

  return 1;
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

async function createCatchAllRoutingRule(
  token: string,
  zoneId: string,
  domain: string,
  workerName: string
): Promise<EmailRoutingRule> {
  // Catch-all is a special resource — not a normal routing rule.
  // GET/PUT: /zones/{zone_id}/email/routing/rules/catch_all
  // Creating with matchers type=all on /rules returns "Invalid rule operation".
  const catchAllUrl = `${CLOUDFLARE_API_BASE}/zones/${zoneId}/email/routing/rules/catch_all`;
  const getResponse = await fetch(catchAllUrl, {
    headers: buildHeaders(token)
  });
  const getPayload = (await getResponse.json().catch(() => null)) as CloudflareApiResponse<EmailRoutingRule> | null;
  if (getResponse.ok && getPayload?.success && getPayload.result) {
    const existing = getPayload.result;
    const sendsToWorker = existing.actions?.some(
      (action) => action.type === 'worker' && action.value?.includes(workerName)
    );
    if (existing.enabled !== false && sendsToWorker) {
      return existing;
    }
  }

  const response = await fetch(catchAllUrl, {
    method: 'PUT',
    headers: buildHeaders(token),
    body: JSON.stringify({
      name: `${APP_BRAND_NAME} catch-all ${domain}`,
      enabled: true,
      matchers: [
        {
          type: 'all'
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
    throw new Error(formatCloudflareError(`Gagal membuat catch-all Email Routing untuk ${domain}`, payload));
  }
  return payload.result;
}

function isCloudflareZoneId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(String(value || '').trim());
}

async function resolveZoneIdByDomainName(
  token: string,
  accountId: string | undefined,
  domain: string
): Promise<string> {
  const query = new URLSearchParams({
    name: domain,
    per_page: '20'
  });
  if (accountId?.trim()) {
    query.set('account.id', accountId.trim());
  }
  const response = await fetch(`${CLOUDFLARE_API_BASE}/zones?${query.toString()}`, {
    headers: buildHeaders(token)
  });
  const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<Array<{ id?: string; name?: string }>> | null;
  if (!response.ok || !payload?.success) {
    return '';
  }
  const match = (payload.result ?? []).find(
    (zone) => String(zone.name ?? '').trim().toLowerCase() === domain.toLowerCase()
  );
  return String(match?.id ?? '').trim();
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
