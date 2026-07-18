<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import type { PageData } from './$types';
  import type { GrokClaimDto } from '$lib/types/dto';
  import { locale, t } from '$lib/i18n';
  import { errorToast, successToast } from '$lib/sweet-alert';

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;

  let claims: GrokClaimDto[] = sortClaimsByDate(data.claims);
  let searchQuery = '';
  let autoRefreshing = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredClaims = claims.filter((claim) =>
    normalizedQuery
      ? [
          claim.email,
          claim.displayName,
          claim.initialPassword,
          claim.detectedSubject,
          claim.detectedSender,
          claim.recipient,
          claim.status,
          claim.confirmationCode,
          claim.serviceName
        ].some((field) => field.toLowerCase().includes(normalizedQuery))
      : true
  );
  $: confirmedCount = claims.filter((claim) => claim.status === 'confirmed').length;
  $: codeCount = claims.filter((claim) => Boolean(claim.confirmationCode)).length;
  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');

  async function refreshClaims() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/grok-claims', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { claims?: GrokClaimDto[] } | null;
      if (payload?.claims) {
        claims = sortClaimsByDate(payload.claims);
      }
    } finally {
      autoRefreshing = false;
    }
  }

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      void successToast($t('common.copySucceededTitle'), $t('common.copiedValue', { label }));
    } catch {
      void errorToast($t('common.copyFailedTitle'), $t('common.copyFailed'));
    }
  }

  function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }
    return date.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID');
  }

  function sortClaimsByDate(items: GrokClaimDto[]) {
    return [...items].sort(
      (a, b) => getDateTime(b.detectedAt) - getDateTime(a.detectedAt) || a.email.localeCompare(b.email)
    );
  }

  function getDateTime(value: string) {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function getStatusTone(status: GrokClaimDto['status']): 'success' | 'warning' {
    return status === 'confirmed' ? 'success' : 'warning';
  }

  function getStatusLabel(status: GrokClaimDto['status']) {
    return status === 'confirmed' ? $t('grok.status.confirmed') : $t('grok.status.detected');
  }

  onMount(() => {
    autoRefreshTimer = setInterval(refreshClaims, AUTO_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshClaims();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  onDestroy(() => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }
  });
</script>

<div class="layout-shell">
  <AppSidebar active="grok" />
  <section class="main">
    <AppTopbar
      title={$t('grok.title')}
      breadcrumb="flash mail flare / grok"
      bind:searchQuery
      searchPlaceholder={$t('grok.search')}
    >
      <span slot="actions" class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
    </AppTopbar>

    <div class="content">
      <div class="summary">
        <div>
          <h2>{$t('grok.activeAccounts')}</h2>
          <p class="text-muted">{$t('grok.claimedCopy')}</p>
        </div>
        <div class="summary-badges">
          <Badge tone="success">{$t('grok.confirmedBadge', { count: confirmedCount })}</Badge>
          <Badge tone="primary">{$t('grok.codeBadge', { count: codeCount })}</Badge>
          <Badge tone="neutral">{$t('grok.detectedBadge', { count: claims.length })}</Badge>
        </div>
      </div>

      <div class="claims">
        {#if filteredClaims.length === 0}
          <div class="empty">
            <Icon name="auto_awesome" size={34} />
            <strong>{$t('grok.emptyTitle')}</strong>
            <span class="text-muted">{$t('grok.emptyCopy')}</span>
          </div>
        {:else}
          {#each filteredClaims as claim (claim.userId)}
            <article class="claim-row">
              <div class="claim-main">
                <div class="claim-head">
                  <strong>{claim.displayName}</strong>
                  <Badge tone={getStatusTone(claim.status)}>{getStatusLabel(claim.status)}</Badge>
                  {#if claim.confirmationCode}
                    <Badge tone="danger">{claim.confirmationCode}</Badge>
                  {/if}
                  {#if claim.role === 'owner'}
                    <Badge tone="warning">{$t('common.role.owner')}</Badge>
                  {/if}
                </div>
                <div class="credential-grid">
                  <div>
                    <span>{$t('common.email')}</span>
                    <code>{claim.email}</code>
                  </div>
                  <div>
                    <span>{$t('gpt.firstPassword')}</span>
                    <code>{claim.initialPassword || $t('user.passwordNotSaved')}</code>
                  </div>
                  <div>
                    <span>{$t('grok.confirmationCode')}</span>
                    <code>{claim.confirmationCode || '-'}</code>
                  </div>
                  <div>
                    <span>{$t('grok.detectedAt')}</span>
                    <code>{formatDate(claim.detectedAt)}</code>
                  </div>
                </div>
                <div class="signal-grid">
                  <span>{$t('email.received')}: {formatDate(claim.detectedAt)}</span>
                  <span>{claim.serviceName || claim.detectedSender || 'xAI'}</span>
                  <span>{claim.detectedSubject || $t('grok.signalEmail')}</span>
                </div>
              </div>
              <div class="claim-actions">
                <Button type="button" variant="secondary" on:click={() => copyValue($t('common.email'), claim.email)}>
                  <Icon name="content_copy" size={16} />
                  {$t('common.email')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!claim.confirmationCode}
                  on:click={() => copyValue($t('grok.confirmationCode'), claim.confirmationCode)}
                >
                  <Icon name="key" size={16} />
                  {$t('grok.confirmationCode')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!claim.initialPassword}
                  on:click={() => copyValue($t('common.password'), claim.initialPassword)}
                >
                  <Icon name="key" size={16} />
                  {$t('common.password')}
                </Button>
                <Button href={`/users/${claim.userId}/emails/${claim.emailId}`} variant="ghost">
                  <Icon name="drafts" size={16} />
                  {$t('grok.openDetectedEmail')}
                </Button>
                <Button href={`/users/${claim.userId}/inbox`} variant="ghost">
                  <Icon name="inbox" size={16} />
                  {$t('inbox.title')}
                </Button>
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </div>
  </section>
</div>

<style>
  .main {
    min-width: 0;
  }

  .content {
    padding: var(--space-5);
    display: grid;
    gap: var(--space-4);
  }

  .summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
  }

  .summary-badges {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .summary h2 {
    font-size: 1.4rem;
    margin-bottom: 0.2rem;
  }

  .claims {
    display: grid;
    gap: var(--space-3);
  }

  .claim-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-4);
    padding: var(--space-4);
    border: 1px solid color-mix(in srgb, #7c3aed, transparent 70%);
    border-radius: var(--radius-lg);
    background:
      radial-gradient(circle at 5% 0%, color-mix(in srgb, #7c3aed, transparent 84%), transparent 18rem),
      radial-gradient(circle at 96% 10%, color-mix(in srgb, var(--color-surface-low), transparent 55%), transparent 14rem),
      color-mix(in srgb, var(--color-surface-card), transparent 2%);
    box-shadow: var(--shadow-ambient);
  }

  .claim-main {
    min-width: 0;
    display: grid;
    gap: var(--space-3);
  }

  .claim-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .claim-head strong {
    font-family: var(--font-family-headline);
    font-size: 1rem;
  }

  .credential-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .credential-grid div {
    min-width: 0;
    display: grid;
    gap: 0.35rem;
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 75%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-low), transparent 20%);
  }

  .credential-grid span,
  .signal-grid {
    color: var(--color-text-muted);
    font-size: 0.72rem;
    font-weight: 800;
  }

  code {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
    font-size: 0.78rem;
  }

  .signal-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .signal-grid span {
    display: inline-flex;
    align-items: center;
    min-height: 1.6rem;
    padding: 0.32rem 0.58rem;
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--color-surface-low), transparent 12%);
  }

  .claim-actions {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
    max-width: 28rem;
  }

  .empty {
    min-height: 16rem;
    border: 1px dashed color-mix(in srgb, #7c3aed, transparent 45%);
    border-radius: var(--radius-lg);
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--space-2);
    background:
      radial-gradient(circle at 50% 0%, color-mix(in srgb, #7c3aed, transparent 86%), transparent 14rem),
      color-mix(in srgb, var(--color-surface-card), transparent 24%);
  }

  .sync-status {
    display: inline-flex;
    align-items: center;
    min-height: 2.2rem;
    border-radius: var(--radius-pill);
    padding: 0 0.8rem;
    background: color-mix(in srgb, var(--color-success), transparent 90%);
    color: var(--color-success);
    font-weight: 800;
    font-size: 0.78rem;
  }

  .sync-status.syncing {
    color: var(--color-primary-500);
    background: color-mix(in srgb, var(--color-primary-500), transparent 90%);
  }

  @media (max-width: 1080px) {
    .claim-row {
      grid-template-columns: 1fr;
    }

    .claim-actions {
      justify-content: flex-start;
      max-width: none;
    }

    .credential-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .content {
      padding: var(--space-4) var(--space-3) calc(var(--mobile-nav-height) + var(--space-4));
    }

    .summary {
      display: grid;
    }

    .credential-grid {
      grid-template-columns: 1fr;
    }

    .claim-actions {
      display: grid;
      grid-template-columns: 1fr;
    }
  }
</style>
