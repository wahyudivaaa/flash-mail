export const MAX_DOT_ALIAS_VARIANTS = 48;

export interface DotAliasInfo {
  email: string;
  aliases: string[];
  total: number;
  totalLabel: string;
  truncated: boolean;
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
  const total = 2 ** separatorSlots;
  const aliases: string[] = [];
  const maxMask = Math.min(total, maxAliases);
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
    aliases,
    total,
    totalLabel: separatorSlots >= 53 ? `2^${separatorSlots}` : String(total),
    truncated: total > aliases.length
  };
}

export function getReceivableDotAliases(email: string, maxAliases = MAX_DOT_ALIAS_VARIANTS): string[] {
  const info = getDotAliasInfo(email, maxAliases);
  if (!info) {
    return [];
  }

  return info.aliases.filter((alias) => alias !== info.email);
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
