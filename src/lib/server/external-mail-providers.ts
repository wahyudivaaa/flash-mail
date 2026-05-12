export const OUTLOOK_MAIL_DOMAIN = 'outlook.com';
export const GMAIL_MAIL_DOMAIN = 'gmail.com';

export interface ExternalMailProvider {
  domain: string;
  label: string;
  aliasPrefix: string;
  aliasProvider: string;
}

const EXTERNAL_MAIL_DOMAIN_ALIASES = new Map<string, string>([
  ['outlook', OUTLOOK_MAIL_DOMAIN],
  [OUTLOOK_MAIL_DOMAIN, OUTLOOK_MAIL_DOMAIN],
  ['gmail', GMAIL_MAIL_DOMAIN],
  [GMAIL_MAIL_DOMAIN, GMAIL_MAIL_DOMAIN]
]);

const EXTERNAL_MAIL_PROVIDERS: ExternalMailProvider[] = [
  {
    domain: OUTLOOK_MAIL_DOMAIN,
    label: 'Outlook',
    aliasPrefix: 'outlook',
    aliasProvider: 'outlook_forward'
  },
  {
    domain: GMAIL_MAIL_DOMAIN,
    label: 'Gmail',
    aliasPrefix: 'gmail',
    aliasProvider: 'gmail_forward'
  }
];

const EXTERNAL_MAIL_PROVIDER_MAP = new Map(EXTERNAL_MAIL_PROVIDERS.map((provider) => [provider.domain, provider]));

export function normalizeExternalMailDomain(raw: string | undefined | null): string {
  const normalized = String(raw ?? '').trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
  return EXTERNAL_MAIL_DOMAIN_ALIASES.get(normalized) ?? normalized;
}

export function isExternalMailDomain(raw: string | undefined | null): boolean {
  return EXTERNAL_MAIL_PROVIDER_MAP.has(normalizeExternalMailDomain(raw));
}

export function getExternalMailProvider(raw: string | undefined | null): ExternalMailProvider | null {
  return EXTERNAL_MAIL_PROVIDER_MAP.get(normalizeExternalMailDomain(raw)) ?? null;
}

export function getExternalMailProviders(): ExternalMailProvider[] {
  return EXTERNAL_MAIL_PROVIDERS;
}

export function getExternalMailRoutingMessage(domain: string): string {
  const provider = getExternalMailProvider(domain);
  if (provider) {
    return `Routing langsung ke ${provider.domain} dilewati karena domain dikelola ${provider.label}.`;
  }

  return 'Routing langsung ke domain email eksternal dilewati.';
}
