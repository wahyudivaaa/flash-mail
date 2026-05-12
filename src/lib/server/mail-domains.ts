import type { MailDomainDto } from '$lib/types/dto';

export interface MailDomainsEnv {
  MAILFLARE_USER_DOMAIN?: string;
  CLOUDFLARE_ZONE_ID?: string;
}

interface PersistedMailDomainRecord {
  domain?: string;
  zoneId?: string;
  status?: string;
  nameservers?: unknown;
  isDefault?: boolean;
  emailRoutingEnabled?: boolean;
  emailRoutingStatus?: string;
  lastSetupMessage?: string;
  lastSyncedAt?: string;
}

const MAIL_DOMAINS_KEY = 'mail_domains_json';
const LEGACY_DEFAULT_DOMAIN_KEY = 'user_email_domain';

export function sanitizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
}

export function isValidDomain(domain: string): boolean {
  if (!domain || domain.length > 253) {
    return false;
  }

  const labels = domain.split('.');
  if (labels.length < 2) {
    return false;
  }

  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export async function getMailDomains(
  db: D1Database | undefined,
  env: MailDomainsEnv | undefined
): Promise<MailDomainDto[]> {
  const fallback = buildEnvFallbackDomains(env);
  if (!db) {
    return fallback;
  }

  const persisted = await getWorkerSettingValue(db, MAIL_DOMAINS_KEY);
  const domains = parsePersistedDomains(persisted, fallback);
  const merged = mergeDomains(domains, fallback);

  if (merged.length === 0) {
    const legacyDefault = sanitizeDomain(await getWorkerSettingValue(db, LEGACY_DEFAULT_DOMAIN_KEY));
    if (isValidDomain(legacyDefault)) {
      return [
        {
          domain: legacyDefault,
          zoneId: '',
          status: 'unknown',
          nameservers: [],
          isDefault: true,
          emailRoutingEnabled: false,
          emailRoutingStatus: 'unknown',
          lastSetupMessage: 'Dimuat dari pengaturan worker lama',
          lastSyncedAt: ''
        }
      ];
    }
  }

  return ensureSingleDefault(merged);
}

export async function getDefaultMailDomain(
  db: D1Database | undefined,
  env: MailDomainsEnv | undefined,
  sessionEmail?: string
): Promise<string> {
  const domains = await getMailDomains(db, env);
  const explicitDefault = domains.find((domain) => domain.isDefault)?.domain;
  if (explicitDefault) {
    return explicitDefault;
  }

  const sessionDomain = sanitizeDomain((sessionEmail?.split('@')[1] ?? '').trim());
  if (isValidDomain(sessionDomain)) {
    return sessionDomain;
  }

  const envDomain = sanitizeDomain(env?.MAILFLARE_USER_DOMAIN ?? '');
  if (isValidDomain(envDomain)) {
    return envDomain;
  }

  return domains[0]?.domain ?? 'mailflare.local';
}

export async function resolveRequestedMailDomain(
  db: D1Database | undefined,
  env: MailDomainsEnv | undefined,
  requestedDomain?: string,
  sessionEmail?: string
): Promise<string> {
  const normalizedRequested = sanitizeDomain(requestedDomain ?? '');
  if (normalizedRequested) {
    if (!isValidDomain(normalizedRequested)) {
      throw new Error('Invalid domain format');
    }

    const domains = await getMailDomains(db, env);
    const managed = domains.find((domain) => domain.domain === normalizedRequested);
    if (!managed) {
      throw new Error('Requested domain is not configured');
    }

    return managed.domain;
  }

  return getDefaultMailDomain(db, env, sessionEmail);
}

export async function getMailDomainByName(
  db: D1Database | undefined,
  env: MailDomainsEnv | undefined,
  domain: string
): Promise<MailDomainDto | null> {
  const normalizedDomain = sanitizeDomain(domain);
  if (!normalizedDomain) {
    return null;
  }

  const domains = await getMailDomains(db, env);
  return domains.find((entry) => entry.domain === normalizedDomain) ?? null;
}

export async function getZoneIdForEmailDomain(
  db: D1Database | undefined,
  env: MailDomainsEnv | undefined,
  emailOrDomain: string
): Promise<string> {
  const normalizedEmailOrDomain = sanitizeDomain(emailOrDomain.includes('@') ? emailOrDomain.split('@')[1] ?? '' : emailOrDomain);
  if (!normalizedEmailOrDomain) {
    return '';
  }

  const configured = await getMailDomainByName(db, env, normalizedEmailOrDomain);
  if (configured?.zoneId) {
    return configured.zoneId;
  }

  const envDomain = sanitizeDomain(env?.MAILFLARE_USER_DOMAIN ?? '');
  if (normalizedEmailOrDomain === envDomain) {
    return String(env?.CLOUDFLARE_ZONE_ID ?? '').trim();
  }

  return '';
}

export async function upsertMailDomain(
  db: D1Database,
  env: MailDomainsEnv | undefined,
  next: Partial<MailDomainDto> & Pick<MailDomainDto, 'domain'>
): Promise<MailDomainDto[]> {
  const normalizedDomain = sanitizeDomain(next.domain);
  if (!isValidDomain(normalizedDomain)) {
      throw new Error('Invalid domain format');
  }

  const current = await getMailDomains(db, env);
  const existingIndex = current.findIndex((domain) => domain.domain === normalizedDomain);
  const currentRecord = existingIndex >= 0 ? current[existingIndex] : null;
  const incomingDefault = next.isDefault ?? currentRecord?.isDefault ?? current.length === 0;

  const record: MailDomainDto = {
    domain: normalizedDomain,
    zoneId: String(next.zoneId ?? currentRecord?.zoneId ?? '').trim(),
    status: String(next.status ?? currentRecord?.status ?? 'unknown').trim() || 'unknown',
    nameservers: normalizeNameservers(next.nameservers ?? currentRecord?.nameservers ?? []),
    isDefault: incomingDefault,
    emailRoutingEnabled: Boolean(next.emailRoutingEnabled ?? currentRecord?.emailRoutingEnabled ?? false),
    emailRoutingStatus: String(next.emailRoutingStatus ?? currentRecord?.emailRoutingStatus ?? 'unknown').trim() || 'unknown',
    lastSetupMessage: String(next.lastSetupMessage ?? currentRecord?.lastSetupMessage ?? '').trim(),
    lastSyncedAt: String(next.lastSyncedAt ?? currentRecord?.lastSyncedAt ?? '').trim()
  };

  const updated = [...current];
  if (existingIndex >= 0) {
    updated[existingIndex] = record;
  } else {
    updated.push(record);
  }

  const persisted = ensureSingleDefault(
    updated.map((domain) => ({
      ...domain,
      isDefault: domain.domain === normalizedDomain ? incomingDefault : incomingDefault ? false : domain.isDefault
    }))
  );
  await persistMailDomains(db, persisted);
  return persisted;
}

export async function setDefaultMailDomain(
  db: D1Database,
  env: MailDomainsEnv | undefined,
  domain: string
): Promise<MailDomainDto[]> {
  const normalizedDomain = sanitizeDomain(domain);
  const current = await getMailDomains(db, env);
  if (!current.some((entry) => entry.domain === normalizedDomain)) {
      throw new Error('Domain not found');
  }

  const updated = ensureSingleDefault(
    current.map((entry) => ({
      ...entry,
      isDefault: entry.domain === normalizedDomain
    }))
  );
  await persistMailDomains(db, updated);
  return updated;
}

export async function removeMailDomain(
  db: D1Database,
  env: MailDomainsEnv | undefined,
  domain: string
): Promise<MailDomainDto[]> {
  const normalizedDomain = sanitizeDomain(domain);
  const current = await getMailDomains(db, env);
  const filtered = current.filter((entry) => entry.domain !== normalizedDomain);
  if (filtered.length === current.length) {
    throw new Error('Domain not found');
  }

  const updated = ensureSingleDefault(filtered);
  await persistMailDomains(db, updated);
  return updated;
}

async function persistMailDomains(db: D1Database, domains: MailDomainDto[]): Promise<void> {
  const sanitized = ensureSingleDefault(domains).map((domain) => ({
    domain: domain.domain,
    zoneId: domain.zoneId,
    status: domain.status,
    nameservers: normalizeNameservers(domain.nameservers),
    isDefault: domain.isDefault,
    emailRoutingEnabled: domain.emailRoutingEnabled,
    emailRoutingStatus: domain.emailRoutingStatus,
    lastSetupMessage: domain.lastSetupMessage,
    lastSyncedAt: domain.lastSyncedAt
  }));

  await upsertWorkerSettingValue(db, MAIL_DOMAINS_KEY, JSON.stringify(sanitized));
  const defaultDomain = sanitized.find((domain) => domain.isDefault)?.domain ?? '';
  await upsertWorkerSettingValue(db, LEGACY_DEFAULT_DOMAIN_KEY, defaultDomain);
}

function buildEnvFallbackDomains(env: MailDomainsEnv | undefined): MailDomainDto[] {
  const envDomain = sanitizeDomain(env?.MAILFLARE_USER_DOMAIN ?? '');
  if (!isValidDomain(envDomain)) {
    return [];
  }

  return [
    {
      domain: envDomain,
      zoneId: String(env?.CLOUDFLARE_ZONE_ID ?? '').trim(),
      status: 'unknown',
      nameservers: [],
      isDefault: true,
      emailRoutingEnabled: false,
      emailRoutingStatus: 'unknown',
      lastSetupMessage: 'Dimuat dari environment worker',
      lastSyncedAt: ''
    }
  ];
}

function parsePersistedDomains(raw: string, fallback: MailDomainDto[]): MailDomainDto[] {
  if (!raw.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = flattenPersistedDomainEntries(parsed);
    if (entries.length === 0) {
      return fallback;
    }

    return entries
      .map((entry) => normalizePersistedDomain(entry))
      .filter((entry): entry is MailDomainDto => Boolean(entry));
  } catch {
    return fallback;
  }
}

function flattenPersistedDomainEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenPersistedDomainEntries(entry));
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as PersistedMailDomainRecord & { value?: unknown };
  if (isValidDomain(sanitizeDomain(String(record.domain ?? '')))) {
    return [value];
  }

  // PowerShell can accidentally wrap arrays as { value: [...], Count: n } when piping JSON.
  if (Array.isArray(record.value)) {
    return flattenPersistedDomainEntries(record.value);
  }

  return [];
}

function normalizePersistedDomain(value: unknown): MailDomainDto | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as PersistedMailDomainRecord;
  const domain = sanitizeDomain(String(raw.domain ?? ''));
  if (!isValidDomain(domain)) {
    return null;
  }

  return {
    domain,
    zoneId: String(raw.zoneId ?? '').trim(),
    status: String(raw.status ?? 'unknown').trim() || 'unknown',
    nameservers: normalizeNameservers(raw.nameservers ?? []),
    isDefault: raw.isDefault === true,
    emailRoutingEnabled: raw.emailRoutingEnabled === true,
    emailRoutingStatus: String(raw.emailRoutingStatus ?? 'unknown').trim() || 'unknown',
    lastSetupMessage: String(raw.lastSetupMessage ?? '').trim(),
    lastSyncedAt: String(raw.lastSyncedAt ?? '').trim()
  };
}

function mergeDomains(primary: MailDomainDto[], secondary: MailDomainDto[]): MailDomainDto[] {
  const map = new Map<string, MailDomainDto>();
  for (const entry of [...primary, ...secondary]) {
    const existing = map.get(entry.domain);
    if (!existing) {
      map.set(entry.domain, { ...entry, nameservers: normalizeNameservers(entry.nameservers) });
      continue;
    }

    map.set(entry.domain, {
      ...existing,
      ...entry,
      zoneId: entry.zoneId || existing.zoneId,
      status: entry.status || existing.status,
      nameservers: normalizeNameservers(entry.nameservers.length > 0 ? entry.nameservers : existing.nameservers),
      emailRoutingStatus: entry.emailRoutingStatus || existing.emailRoutingStatus,
      lastSetupMessage: entry.lastSetupMessage || existing.lastSetupMessage,
      lastSyncedAt: entry.lastSyncedAt || existing.lastSyncedAt,
      isDefault: existing.isDefault || entry.isDefault,
      emailRoutingEnabled: existing.emailRoutingEnabled || entry.emailRoutingEnabled
    });
  }

  return Array.from(map.values());
}

function ensureSingleDefault(domains: MailDomainDto[]): MailDomainDto[] {
  const normalized = [...domains]
    .map((domain) => ({
      ...domain,
      domain: sanitizeDomain(domain.domain),
      nameservers: normalizeNameservers(domain.nameservers)
    }))
    .filter((domain) => isValidDomain(domain.domain))
    .sort((left, right) => left.domain.localeCompare(right.domain));

  if (normalized.length === 0) {
    return [];
  }

  let defaultDomain = normalized.find((domain) => domain.isDefault)?.domain ?? normalized[0].domain;
  return normalized.map((domain) => ({
    ...domain,
    isDefault: domain.domain === defaultDomain
  }));
}

function normalizeNameservers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => String(entry ?? '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

async function getWorkerSettingValue(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare('SELECT value FROM worker_settings WHERE key = ? LIMIT 1').bind(key).first<{ value: string | null }>();
  return String(row?.value ?? '');
}

async function upsertWorkerSettingValue(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO worker_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `
    )
    .bind(key, value)
    .run();
}
