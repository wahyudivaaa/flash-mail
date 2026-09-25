import { ensureCloudflareMailboxDomainSetup } from '$lib/server/cloudflare-domain-setup';
import { ensureCatchAllEmailRoutingRule } from '$lib/server/cloudflare-email-routing';
import { getMailDomainByName, type MailDomainsEnv } from '$lib/server/mail-domains';
import type { MailDomainDto } from '$lib/types/dto';

export interface MailDomainProvisionEnv extends MailDomainsEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_WORKER_NAME?: string;
  MAILFLARE_EMAIL_WORKER_NAME?: string;
}

export type MailDomainReadinessState =
  | 'ready'
  | 'awaiting-nameservers'
  | 'routing-pending'
  | 'failed';

export interface MailDomainProvisionResult {
  domain: string;
  state: MailDomainReadinessState;
  ready: boolean;
  zoneId: string;
  zoneStatus: string;
  nameservers: string[];
  emailRoutingEnabled: boolean;
  emailRoutingStatus: string;
  catchAllRuleId: string;
  /** True when a new Cloudflare zone had to be created for this domain. */
  zoneCreated: boolean;
  /** True when this domain's nameservers differ from the account's usual pair. */
  nameserversChanged: boolean;
  /** Nameservers the registrar should be pointed at, ready to paste. */
  delegationInstructions: string;
  steps: string[];
  message: string;
}

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Provision a mailbox domain so that mailboxes created on it can receive mail
 * immediately, without a separate repair step.
 *
 * Two things have to be true for a domain to accept inbound mail:
 *   1. Cloudflare owns a zone for it with Email Routing DNS published.
 *   2. A catch-all Email Routing rule sends every address on that domain to the
 *      Mail Flare worker.
 *
 * Step 1 already lived in `ensureCloudflareMailboxDomainSetup`, but step 2 was
 * only reachable through the separate `/api/public/v1/ensure_routing` endpoint.
 * Adding a domain therefore used to leave a window where `create_user`
 * succeeded and mail silently bounced. This function closes that gap by running
 * both steps and reporting exactly what still needs doing, if anything.
 */
export async function provisionMailDomain(
  env: MailDomainProvisionEnv | undefined,
  db: D1Database | undefined,
  rawDomain: string
): Promise<MailDomainProvisionResult> {
  const domain = rawDomain.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
  const steps: string[] = [];

  const setup = await ensureCloudflareMailboxDomainSetup(env, domain);
  steps.push(
    setup.created
      ? `Cloudflare zone dibuat (${setup.zoneId})`
      : setup.zoneId
        ? `Cloudflare zone sudah ada (${setup.zoneId})`
        : 'Cloudflare zone tidak tersedia'
  );
  steps.push(
    setup.emailRoutingEnabled
      ? `Email Routing aktif (${setup.emailRoutingStatus})`
      : `Email Routing belum aktif (${setup.emailRoutingStatus})`
  );

  const zoneActive = setup.zoneStatus === 'active';
  let catchAllRuleId = '';
  let catchAllMessage = '';

  if (zoneActive) {
    const catchAll = await ensureCatchAllEmailRoutingRule(env, domain, db);
    catchAllRuleId = catchAll.ruleId;
    catchAllMessage = catchAll.message;
    steps.push(catchAll.ok ? catchAll.message : `Catch-all gagal: ${catchAll.message}`);
  } else {
    const zoneStatus = setup.zoneStatus || 'pending';
    catchAllMessage = `Catch-all menunggu zone aktif (status saat ini: ${zoneStatus})`;
    steps.push(catchAllMessage);
  }

  const currentRecord = db ? await getMailDomainByName(db, env, domain) : null;
  const nameserversChanged = Boolean(
    currentRecord &&
      currentRecord.nameservers.length > 0 &&
      setup.nameservers.length > 0 &&
      setup.nameservers.join(',') !== currentRecord.nameservers.join(',')
  );

  const state = resolveReadinessState(setup, zoneActive, catchAllRuleId);
  const ready = state === 'ready';

  return {
    domain,
    state,
    ready,
    zoneId: setup.zoneId,
    zoneStatus: setup.zoneStatus,
    nameservers: setup.nameservers,
    emailRoutingEnabled: setup.emailRoutingEnabled,
    emailRoutingStatus: setup.emailRoutingStatus,
    catchAllRuleId,
    zoneCreated: setup.created,
    nameserversChanged,
    delegationInstructions:
      setup.nameservers.length > 0
        ? `Arahkan nameserver domain ${domain} ke: ${setup.nameservers.join(', ')}`
        : '',
    steps,
    message: buildMessage(domain, state, setup.zoneStatus, catchAllMessage, setup.nameservers)
  };
}

function resolveReadinessState(
  setup: { ok: boolean; status?: string; zoneStatus: string; emailRoutingEnabled: boolean },
  zoneActive: boolean,
  catchAllRuleId: string
): MailDomainReadinessState {
  if (!setup.ok) {
    return 'failed';
  }
  if (!zoneActive) {
    return 'awaiting-nameservers';
  }
  if (!setup.emailRoutingEnabled || !catchAllRuleId) {
    return 'routing-pending';
  }
  return 'ready';
}

function buildMessage(
  domain: string,
  state: MailDomainReadinessState,
  zoneStatus: string,
  catchAllMessage: string,
  nameservers: string[]
): string {
  switch (state) {
    case 'ready':
      return `${domain} siap dipakai. Kotak masuk baru di domain ini langsung bisa menerima email.`;
    case 'awaiting-nameservers':
      return `${domain} terdaftar, tapi Cloudflare masih menunggu delegasi nameserver (status zone: ${zoneStatus}). ${
        nameservers.length > 0 ? `Arahkan nameserver ke: ${nameservers.join(', ')}.` : ''
      }`.trim();
    case 'routing-pending':
      return `${domain} sudah aktif di Cloudflare, tapi catch-all Email Routing belum siap. ${catchAllMessage}`.trim();
    default:
      return `Penyiapan ${domain} gagal. ${catchAllMessage}`.trim();
  }
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

interface CloudflareZoneSummary {
  id?: string;
  name?: string;
  status?: string;
  name_servers?: string[];
}

/**
 * Read the live readiness of an already-registered mailbox domain without
 * changing anything. Used to refresh the status shown in the settings page.
 */
export async function inspectMailDomainReadiness(
  env: MailDomainProvisionEnv | undefined,
  db: D1Database | undefined,
  record: MailDomainDto
): Promise<MailDomainProvisionResult> {
  const domain = record.domain;
  const token = String(env?.CLOUDFLARE_API_TOKEN ?? '').trim();
  const steps: string[] = [];

  if (!token || !record.zoneId) {
    return {
      domain,
      state: record.zoneId ? 'routing-pending' : 'failed',
      ready: false,
      zoneId: record.zoneId,
      zoneStatus: record.status,
      nameservers: record.nameservers,
      emailRoutingEnabled: record.emailRoutingEnabled,
      emailRoutingStatus: record.emailRoutingStatus,
      catchAllRuleId: '',
      zoneCreated: false,
      nameserversChanged: false,
      delegationInstructions: '',
      steps: ['Cloudflare API belum dikonfigurasi'],
      message: 'Cloudflare API belum dikonfigurasi, status tidak bisa diverifikasi'
    };
  }

  const zone = await fetchZone(token, record.zoneId);
  const zoneStatus = String(zone?.status ?? record.status ?? 'unknown').toLowerCase();
  const nameservers =
    zone?.name_servers && zone.name_servers.length > 0 ? zone.name_servers : record.nameservers;
  steps.push(`Zone ${domain} status: ${zoneStatus}`);

  let catchAllRuleId = '';
  let catchAllMessage = 'Catch-all belum diperiksa';
  if (zoneStatus === 'active') {
    const catchAll = await ensureCatchAllEmailRoutingRule(env, domain, db);
    catchAllRuleId = catchAll.ruleId;
    catchAllMessage = catchAll.message;
    steps.push(catchAll.ok ? catchAll.message : `Catch-all bermasalah: ${catchAll.message}`);
  }

  const routingEnabled = record.emailRoutingEnabled;
  const state: MailDomainReadinessState =
    zoneStatus !== 'active'
      ? 'awaiting-nameservers'
      : !routingEnabled || !catchAllRuleId
        ? 'routing-pending'
        : 'ready';

  return {
    domain,
    state,
    ready: state === 'ready',
    zoneId: record.zoneId,
    zoneStatus,
    nameservers,
    emailRoutingEnabled: routingEnabled,
    emailRoutingStatus: record.emailRoutingStatus,
    catchAllRuleId,
    zoneCreated: false,
    nameserversChanged: false,
    delegationInstructions:
      nameservers.length > 0 ? `Arahkan nameserver domain ${domain} ke: ${nameservers.join(', ')}` : '',
    steps,
    message: buildMessage(domain, state, zoneStatus, catchAllMessage, nameservers)
  };
}

async function fetchZone(token: string, zoneId: string): Promise<CloudflareZoneSummary | null> {
  try {
    const response = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    });
    const payload = (await response.json().catch(() => null)) as CloudflareApiResponse<CloudflareZoneSummary> | null;
    if (!response.ok || !payload?.success) {
      return null;
    }
    return payload.result ?? null;
  } catch {
    return null;
  }
}