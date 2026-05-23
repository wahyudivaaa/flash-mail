const TURNSTILE_TEST_KEY_PATTERN = /^[123]x0+/i;

export interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export function getTurnstileSiteKey(env: TurnstileEnv | undefined): string {
  const siteKey = normalizeTurnstileKey(env?.TURNSTILE_SITE_KEY);
  return isUsableTurnstileKey(siteKey) ? siteKey : '';
}

export function isTurnstileVerificationEnabled(env: TurnstileEnv | undefined): boolean {
  return isUsableTurnstileKey(env?.TURNSTILE_SITE_KEY) && isUsableTurnstileKey(env?.TURNSTILE_SECRET_KEY);
}

export function getTurnstileSecretKey(env: TurnstileEnv | undefined): string {
  const secretKey = normalizeTurnstileKey(env?.TURNSTILE_SECRET_KEY);
  return isUsableTurnstileKey(secretKey) ? secretKey : '';
}

function isUsableTurnstileKey(value: string | undefined): value is string {
  const key = normalizeTurnstileKey(value);
  if (!key || key.includes('<') || key.includes('>')) {
    return false;
  }
  return !TURNSTILE_TEST_KEY_PATTERN.test(key);
}

function normalizeTurnstileKey(value: string | undefined): string {
  return String(value ?? '').trim();
}
