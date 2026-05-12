export const MAX_DOT_ALIAS_VARIANTS = 48;
export const MAX_STANDALONE_DOT_ALIAS_VARIANTS = 1000;
export const GMAIL_DOT_TRICK_DOMAINS = ['gmail.com', 'googlemail.com'] as const;

export interface DotAliasCapacity {
  domain: string;
  baseLocalPart: string;
  baseLocalPartLength: number;
  dotSlotCount: number;
  totalVariantsLabel: string;
  totalAdditionalAliasesLabel: string;
  standaloneAliasLimit: number;
  storableAliasCount: number;
  storableAliasCountLabel: string;
  omittedAdditionalAliasesLabel: string;
  isGmailDotTrickDomain: boolean;
}

export interface DotAliasInfo {
  email: string;
  domain: string;
  aliases: string[];
  total: number;
  totalLabel: string;
  truncated: boolean;
  baseLocalPart: string;
  baseLocalPartLength: number;
  dotSlotCount: number;
  totalVariantsLabel: string;
  totalAdditionalAliasesLabel: string;
  standaloneAliasLimit: number;
  storableAliasCount: number;
  storableAliasCountLabel: string;
  omittedAdditionalAliasesLabel: string;
  isGmailDotTrickDomain: boolean;
  capacity: DotAliasCapacity;
}

export function getDotAliasInfo(email: string, maxAliases = MAX_DOT_ALIAS_VARIANTS): DotAliasInfo | null {
  const normalizedEmail = email.trim().toLowerCase();
  const [rawLocalPart, rawDomain] = normalizedEmail.split('@');
  if (!rawLocalPart || !rawDomain || normalizedEmail.split('@').length !== 2) {
    return null;
  }

  const plusIndex = rawLocalPart.indexOf('+');
  const plusTag = plusIndex >= 0 ? rawLocalPart.slice(plusIndex) : '';
  const baseLocalPart = (plusIndex >= 0 ? rawLocalPart.slice(0, plusIndex) : rawLocalPart).replace(/\./g, '');
  if (baseLocalPart.length < 2) {
    return null;
  }

  const separatorSlots = Math.max(0, baseLocalPart.length - 1);
  const totalVariants = 1n << BigInt(separatorSlots);
  const totalAdditionalAliases = totalVariants - 1n;
  const storableAliasCount = Number(
    totalAdditionalAliases > BigInt(MAX_STANDALONE_DOT_ALIAS_VARIANTS)
      ? BigInt(MAX_STANDALONE_DOT_ALIAS_VARIANTS)
      : totalAdditionalAliases
  );
  const omittedAdditionalAliases = totalAdditionalAliases - BigInt(storableAliasCount);
  const capacity: DotAliasCapacity = {
    domain: rawDomain,
    baseLocalPart,
    baseLocalPartLength: baseLocalPart.length,
    dotSlotCount: separatorSlots,
    totalVariantsLabel: formatDotAliasCountLabel(totalVariants, separatorSlots),
    totalAdditionalAliasesLabel: formatDotAliasAdditionalCountLabel(totalAdditionalAliases, separatorSlots),
    standaloneAliasLimit: MAX_STANDALONE_DOT_ALIAS_VARIANTS,
    storableAliasCount,
    storableAliasCountLabel: String(storableAliasCount),
    omittedAdditionalAliasesLabel: omittedAdditionalAliases > 0n ? formatDotAliasCountLabel(omittedAdditionalAliases) : '0',
    isGmailDotTrickDomain: isGmailDotTrickDomain(rawDomain)
  };
  const total = totalVariants > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(totalVariants);
  const normalizedMaxAliases = Math.max(0, Math.floor(maxAliases));
  const aliases: string[] = [];
  const maxMask = totalVariants < BigInt(normalizedMaxAliases) ? Number(totalVariants) : normalizedMaxAliases;
  for (let mask = 0; mask < maxMask; mask += 1) {
    const maskBigInt = BigInt(mask);
    let localPart = baseLocalPart[0];
    for (let index = 1; index < baseLocalPart.length; index += 1) {
      if ((maskBigInt & (1n << BigInt(index - 1))) !== 0n) {
        localPart += '.';
      }
      localPart += baseLocalPart[index];
    }

    const alias = `${localPart}${plusTag}@${rawDomain}`;
    if (isValidDotAliasEmail(alias)) {
      aliases.push(alias);
    }
  }

  return {
    email: normalizedEmail,
    domain: rawDomain,
    aliases,
    total,
    totalLabel: capacity.totalVariantsLabel,
    truncated: totalVariants > BigInt(aliases.length),
    baseLocalPart: capacity.baseLocalPart,
    baseLocalPartLength: capacity.baseLocalPartLength,
    dotSlotCount: capacity.dotSlotCount,
    totalVariantsLabel: capacity.totalVariantsLabel,
    totalAdditionalAliasesLabel: capacity.totalAdditionalAliasesLabel,
    standaloneAliasLimit: capacity.standaloneAliasLimit,
    storableAliasCount: capacity.storableAliasCount,
    storableAliasCountLabel: capacity.storableAliasCountLabel,
    omittedAdditionalAliasesLabel: capacity.omittedAdditionalAliasesLabel,
    isGmailDotTrickDomain: capacity.isGmailDotTrickDomain,
    capacity
  };
}

export function getStandaloneDotAliasInfo(email: string): DotAliasInfo | null {
  return getDotAliasInfo(email, MAX_STANDALONE_DOT_ALIAS_VARIANTS + 1);
}

export function getReceivableDotAliases(email: string, maxAliases = MAX_DOT_ALIAS_VARIANTS): string[] {
  const info = getDotAliasInfo(email, maxAliases);
  if (!info) {
    return [];
  }

  return info.aliases.filter((alias) => alias !== info.email);
}

export function isGmailDotTrickDomain(domain: string): boolean {
  return GMAIL_DOT_TRICK_DOMAINS.includes(domain.trim().toLowerCase() as (typeof GMAIL_DOT_TRICK_DOMAINS)[number]);
}

function formatDotAliasCountLabel(value: bigint, exponent?: number): string {
  if (typeof exponent === 'number' && exponent >= 53) {
    return `2^${exponent}`;
  }

  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? String(value) : value.toString();
}

function formatDotAliasAdditionalCountLabel(value: bigint, dotSlotCount: number): string {
  if (dotSlotCount >= 53) {
    return `2^${dotSlotCount} - 1`;
  }

  return formatDotAliasCountLabel(value);
}

function isValidDotAliasEmail(email: string): boolean {
  const [localPart, domain] = email.split('@');
  return Boolean(
    localPart &&
      domain &&
      localPart.length <= 64 &&
      /^[a-z0-9][a-z0-9._+-]*[a-z0-9](?:\+[a-z0-9._-]+)?$/.test(localPart) &&
      !localPart.includes('..') &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
  );
}
