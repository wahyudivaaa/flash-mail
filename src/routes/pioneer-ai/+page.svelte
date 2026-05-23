<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import type { PageData } from './$types';
  import type { PioneerAiClaimDto } from '$lib/types/dto';
  import { locale, t } from '$lib/i18n';
  import { errorToast, successToast } from '$lib/sweet-alert';

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;

  let claims: PioneerAiClaimDto[] = sortClaimsByDate(data.claims);
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
          claim.status
        ].some((field) => field.toLowerCase().includes(normalizedQuery))
      : true
  );
  $: magicLinkCount = claims.filter((claim) => claim.status === 'magic_link').length;
  $: confirmedCount = claims.filter((claim) => claim.status === 'confirmed').length;
  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');

  async function refreshClaims() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/pioneer-ai-claims', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { claims?: PioneerAiClaimDto[] } | null;
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

  function sortClaimsByDate(items: PioneerAiClaimDto[]) {
    return [...items].sort((a, b) => getDateTime(getClaimSortDate(b)) - getDateTime(getClaimSortDate(a)) || a.email.localeCompare(b.email));
  }

  function getClaimSortDate(claim: PioneerAiClaimDto) {
    return claim.magicLinkAt || claim.confirmedAt || claim.detectedAt;
  }

  function getDateTime(value: string) {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function getStatusTone(status: PioneerAiClaimDto['status']): 'primary' | 'success' | 'warning' | 'neutral' {
    if (status === 'magic_link') {
      return 'success';
    }
    if (status === 'confirmed') {
      return 'primary';
    }
    return 'warning';
  }

  function getStatusLabel(status: PioneerAiClaimDto['status']) {
    if (status === 'magic_link') {
      return $t('pioneer.status.magicLink');
    }
    if (status === 'confirmed') {
      return $t('pioneer.status.confirmed');
    }
    return $t('pioneer.status.detected');
  }

  function getEventLabel(claim: PioneerAiClaimDto) {
    if (claim.status === 'magic_link') {
      return $t('pioneer.magicLinkAt');
    }
    if (claim.status === 'confirmed') {
      return $t('pioneer.confirmedAt');
    }
    return $t('pioneer.detectedAt');
  }

  function getEventDate(claim: PioneerAiClaimDto) {
    return claim.status === 'magic_link' ? claim.magicLinkAt || claim.detectedAt : claim.confirmedAt || claim.detectedAt;
  }

  function getDetectedEmailHref(claim: PioneerAiClaimDto) {
    return `/users/${claim.userId}/emails/${claim.emailId}`;
  }

  function getMagicLinkEmailHref(claim: PioneerAiClaimDto) {
    return claim.magicLinkEmailId ? `/users/${claim.userId}/emails/${claim.magicLinkEmailId}` : '';
  }

  function getConfirmationEmailHref(claim: PioneerAiClaimDto) {
    return claim.confirmationEmailId ? `/users/${claim.userId}/emails/${claim.confirmationEmailId}` : '';
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
  <AppSidebar active="pioneer-ai" />
  <section class="main">
    <AppTopbar
      title={$t('pioneer.title')}
      breadcrumb="flash mail flare / pioneer ai"
      bind:searchQuery
      searchPlaceholder={$t('pioneer.search')}
    >
      <span slot="actions" class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
    </AppTopbar>

    <div class="content">
      <div class="summary">
        <div>
          <h2>{$t('pioneer.activeAccounts')}</h2>
          <p class="text-muted">{$t('pioneer.claimedCopy')}</p>
        </div>
        <div class="summary-badges">
          <Badge tone="success">{$t('pioneer.magicLinkBadge', { count: magicLinkCount })}</Badge>
          <Badge tone="primary">{$t('pioneer.confirmedBadge', { count: confirmedCount })}</Badge>
          <Badge tone="neutral">{$t('pioneer.detectedBadge', { count: claims.length })}</Badge>
        </div>
      </div>

      <div class="claims">
        {#if filteredClaims.length === 0}
          <div class="empty">
            <Icon name="auto_awesome" size={34} />
            <strong>{$t('pioneer.emptyTitle')}</strong>
            <span class="text-muted">{$t('pioneer.emptyCopy')}</span>
          </div>
        {:else}
          {#each filteredClaims as claim (claim.userId)}
            <article class="claim-row">
              <div class="claim-main">
                <div class="claim-head">
                  <strong>{claim.displayName}</strong>
                  <Badge tone={getStatusTone(claim.status)}>{getStatusLabel(claim.status)}</Badge>
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
                    <span>{$t('common.status')}</span>
                    <code>{getStatusLabel(claim.status)}</code>
                  </div>
                  <div>
                    <span>{getEventLabel(claim)}</span>
                    <code>{formatDate(getEventDate(claim))}</code>
                  </div>
                </div>
                <div class="signal-grid">
                  <span>{$t('email.received')}: {formatDate(getClaimSortDate(claim))}</span>
                  <span>{claim.detectedSender || 'fastino.ai'}</span>
                  <span>{claim.detectedSubject || $t('pioneer.signalEmail')}</span>
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
                  disabled={!claim.initialPassword}
                  on:click={() => copyValue($t('common.password'), claim.initialPassword)}
                >
                  <Icon name="key" size={16} />
                  {$t('common.password')}
                </Button>
                <Button href={getDetectedEmailHref(claim)} variant="ghost">
                  <Icon name="drafts" size={16} />
                  {$t('pioneer.openDetectedEmail')}
                </Button>
                {#if getMagicLinkEmailHref(claim) && getMagicLinkEmailHref(claim) !== getDetectedEmailHref(claim)}
                  <Button href={getMagicLinkEmailHref(claim)} variant="ghost">
                    <Icon name="bolt" size={16} />
                    {$t('pioneer.openMagicLinkEmail')}
                  </Button>
                {/if}
                {#if getConfirmationEmailHref(claim) && getConfirmationEmailHref(claim) !== getDetectedEmailHref(claim)}
                  <Button href={getConfirmationEmailHref(claim)} variant="ghost">
                    <Icon name="verified" size={16} />
                    {$t('pioneer.openConfirmationEmail')}
                  </Button>
                {/if}
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
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 64%);
    border-radius: var(--radius-lg);
    background:
      radial-gradient(circle at 5% 0%, color-mix(in srgb, var(--color-success), transparent 88%), transparent 17rem),
      radial-gradient(circle at 96% 10%, color-mix(in srgb, var(--color-primary-500), transparent 91%), transparent 15rem),
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
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 45%);
    border-radius: var(--radius-lg);
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--space-2);
    background:
      radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--color-success), transparent 90%), transparent 14rem),
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
