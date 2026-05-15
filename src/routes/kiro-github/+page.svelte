<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import type { PageData } from './$types';
  import type { KiroGithubClaimDto } from '$lib/types/dto';
  import { locale, t } from '$lib/i18n';
  import { errorToast, successToast } from '$lib/sweet-alert';

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;

  let claims: KiroGithubClaimDto[] = data.claims;
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
          claim.githubUsername,
          claim.applicationName,
          claim.recipient
        ].some((field) => field.toLowerCase().includes(normalizedQuery))
      : true
  );
  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');

  async function refreshClaims() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/kiro-github-claims', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { claims?: KiroGithubClaimDto[] } | null;
      if (payload?.claims) {
        claims = payload.claims;
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
  <AppSidebar active="kiro-github" />
  <section class="main">
    <AppTopbar
      title={$t('kiro.title')}
      breadcrumb="flash mail flare / kiro github"
      bind:searchQuery
      searchPlaceholder={$t('kiro.search')}
    >
      <span slot="actions" class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
    </AppTopbar>

    <div class="content">
      <div class="summary">
        <div>
          <h2>{$t('kiro.activeAccounts')}</h2>
          <p class="text-muted">{$t('kiro.claimedCopy')}</p>
        </div>
        <div class="summary-badges">
          <Badge tone="success">{$t('kiro.connectedBadge', { count: claims.length })}</Badge>
        </div>
      </div>

      <div class="claims">
        {#if filteredClaims.length === 0}
          <div class="empty">
            <Icon name="code_blocks" size={34} />
            <strong>{$t('kiro.emptyTitle')}</strong>
            <span class="text-muted">{$t('kiro.emptyCopy')}</span>
          </div>
        {:else}
          {#each filteredClaims as claim (claim.userId)}
            <article class="claim-row">
              <div class="claim-main">
                <div class="claim-head">
                  <strong>{claim.displayName}</strong>
                  <Badge tone="success">{$t('kiro.connected')}</Badge>
                  {#if claim.githubUsername}
                    <Badge tone="primary">@{claim.githubUsername}</Badge>
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
                    <span>{$t('kiro.githubUsername')}</span>
                    <code>{claim.githubUsername ? `@${claim.githubUsername}` : '-'}</code>
                  </div>
                  <div>
                    <span>{$t('kiro.authorizedAt')}</span>
                    <code>{formatDate(claim.authorizedAt)}</code>
                  </div>
                </div>
                <div class="meta-line">
                  <span>{$t('email.received')}: {formatDate(claim.authorizedAt)}</span>
                  <span>{claim.detectedSender || 'noreply@github.com'}</span>
                  <span>{claim.detectedSubject || $t('kiro.securityEmail')}</span>
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
                {#if claim.githubUsername}
                  <Button type="button" variant="secondary" on:click={() => copyValue($t('kiro.githubUsername'), claim.githubUsername)}>
                    <Icon name="alternate_email" size={16} />
                    {$t('kiro.githubUsernameShort')}
                  </Button>
                {/if}
                <Button href={`/users/${claim.userId}/emails/${claim.emailId}`} variant="ghost">
                  <Icon name="drafts" size={16} />
                  {$t('kiro.openDetectedEmail')}
                </Button>
                <Button href={`/users/${claim.userId}/inbox`} variant="ghost">
                  <Icon name="inbox" size={16} />
                  {$t('inbox.title')}
                </Button>
                {#if claim.connectionUrl}
                  <a class="link-pill" href={claim.connectionUrl} target="_blank" rel="noreferrer">
                    <Icon name="open_in_new" size={16} />
                    {$t('kiro.githubConnection')}
                  </a>
                {/if}
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
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 65%);
    border-radius: var(--radius-lg);
    background:
      radial-gradient(circle at 6% 0%, color-mix(in srgb, var(--color-primary-500), transparent 90%), transparent 18rem),
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
  .meta-line {
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

  .meta-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .meta-line span {
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
    max-width: 26rem;
  }

  .link-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-height: 2.72rem;
    padding: 0.75rem 1rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 50%);
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    font-weight: 700;
    background: transparent;
  }

  .empty {
    min-height: 16rem;
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 45%);
    border-radius: var(--radius-lg);
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--space-2);
    background: color-mix(in srgb, var(--color-surface-card), transparent 24%);
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

    .link-pill {
      width: 100%;
    }
  }
</style>
