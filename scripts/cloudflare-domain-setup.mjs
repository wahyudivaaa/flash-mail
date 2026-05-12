const args = process.argv.slice(2);

const domain = readArgValue('--domain');
const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

if (!domain) {
  console.error('Missing --domain <example.com>');
  process.exit(1);
}

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.');
  process.exit(1);
}

const normalizedDomain = domain.trim().toLowerCase();
const apiBase = 'https://api.cloudflare.com/client/v4';

try {
  const existing = await findZoneByName(token, accountId, normalizedDomain);
  const zone = existing || (await createZone(token, accountId, normalizedDomain));
  if ((zone.status || '').toLowerCase() === 'pending') {
    await requestActivationCheck(token, zone.id).catch(() => undefined);
  }

  let routing = await getEmailRoutingSettings(token, zone.id);
  if (['unconfigured', 'misconfigured', 'unlocked'].includes(routing.status)) {
    await enableEmailRoutingDns(token, zone.id);
    routing = await getEmailRoutingSettings(token, zone.id);
  } else if (routing.status === 'misconfigured/locked') {
    await unlockEmailRoutingDns(token, zone.id);
    routing = await getEmailRoutingSettings(token, zone.id);
  }

  console.log(JSON.stringify({
    ok: true,
    domain: normalizedDomain,
    zoneId: zone.id,
    zoneStatus: zone.status || 'unknown',
    nameservers: zone.name_servers || [],
    emailRoutingEnabled: routing.enabled,
    emailRoutingStatus: routing.status
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) {
    return '';
  }
  return String(args[index + 1] || '').trim();
}

async function findZoneByName(token, accountId, domain) {
  const response = await fetch(`${apiBase}/zones?name=${encodeURIComponent(domain)}&account.id=${encodeURIComponent(accountId)}&per_page=20`, {
    headers: buildHeaders(token)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Failed to list Cloudflare zones', payload));
  }
  return (payload.result || []).find((zone) => String(zone?.name || '').trim().toLowerCase() === domain) || null;
}

async function createZone(token, accountId, domain) {
  const response = await fetch(`${apiBase}/zones`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      account: { id: accountId },
      name: domain,
      type: 'full'
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || !payload?.result) {
    throw new Error(formatCloudflareError('Failed to create Cloudflare zone', payload));
  }
  return payload.result;
}

async function requestActivationCheck(token, zoneId) {
  const response = await fetch(`${apiBase}/zones/${zoneId}/activation_check`, {
    method: 'PUT',
    headers: buildHeaders(token)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Failed to request zone activation check', payload));
  }
}

async function getEmailRoutingSettings(token, zoneId) {
  const response = await fetch(`${apiBase}/zones/${zoneId}/email/routing`, {
    headers: buildHeaders(token)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || !payload?.result) {
    throw new Error(formatCloudflareError('Failed to load Email Routing settings', payload));
  }
  return {
    enabled: payload.result.enabled === true,
    status: String(payload.result.status || '').trim().toLowerCase() || 'unknown'
  };
}

async function enableEmailRoutingDns(token, zoneId) {
  const response = await fetch(`${apiBase}/zones/${zoneId}/email/routing/dns`, {
    method: 'POST',
    headers: buildHeaders(token)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Failed to enable Email Routing DNS', payload));
  }
}

async function unlockEmailRoutingDns(token, zoneId) {
  const response = await fetch(`${apiBase}/zones/${zoneId}/email/routing/dns`, {
    method: 'PATCH',
    headers: buildHeaders(token)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(formatCloudflareError('Failed to unlock Email Routing DNS', payload));
  }
}

function buildHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

function formatCloudflareError(prefix, payload) {
  const details = Array.isArray(payload?.errors)
    ? payload.errors.map((error) => error?.message || error?.code).filter(Boolean).join('; ')
    : '';
  return details ? `${prefix}: ${details}` : prefix;
}
