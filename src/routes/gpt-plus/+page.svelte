<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import type { PageData } from './$types';
  import type { GptPlusClaimDto } from '$lib/types/dto';
  import { locale, t } from '$lib/i18n';
  import { confirmDialog, errorToast, successToast, warningToast } from '$lib/sweet-alert';
  import { getDotAliasInfo, MAX_DOT_ALIAS_VARIANTS } from '$lib/email-dot-aliases';

  type BadgeTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  type ClaimFilter = 'all' | 'active' | 'deactivated';
  type DotAliasModal = {
    claim: GptPlusClaimDto;
    aliases: string[];
    activeAliases: string[];
    totalLabel: string;
    truncated: boolean;
    provider: 'gmail' | 'mailflare';
    loading: boolean;
    activating: boolean;
    routingMessage: string;
    routingOk: boolean | null;
  };

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const statusFilters: ClaimFilter[] = ['all', 'active', 'deactivated'];

  let claims: GptPlusClaimDto[] = data.claims;
  let searchQuery = '';
  let statusFilter: ClaimFilter = 'all';
  let autoRefreshing = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let deletingUserId = '';
  let dotAliasModal: DotAliasModal | null = null;
  let dotAliasQuery = '';

  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredClaims = claims
    .filter((claim) => {
      if (statusFilter === 'active') return claim.status !== 'deactivated';
      if (statusFilter === 'deactivated') return claim.status === 'deactivated';
      return true;
    })
    .filter((claim) =>
      normalizedQuery
        ? [
            claim.email,
            claim.displayName,
            claim.initialPassword,
            claim.detectedSubject,
            claim.detectedSender,
            claim.deactivationSubject,
            claim.deactivationSender,
            claim.status
          ].some((field) => field.toLowerCase().includes(normalizedQuery))
        : true
    );
  $: activeClaimCount = claims.filter((claim) => claim.status !== 'deactivated').length;
  $: deactivatedClaimCount = claims.filter((claim) => claim.status === 'deactivated').length;
  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');
  $: dotAliasFiltered = dotAliasModal
    ? dotAliasModal.aliases.filter((alias) => alias.toLowerCase().includes(dotAliasQuery.trim().toLowerCase()))
    : [];
  $: dotAliasActiveSet = new Set(dotAliasModal?.activeAliases ?? []);

  async function refreshClaims() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/gpt-plus-claims', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { claims?: GptPlusClaimDto[] } | null;
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

  function isGmailAddress(email: string) {
    return email.trim().toLowerCase().endsWith('@gmail.com');
  }

  function canUseDotAliases(email: string) {
    return Boolean(getDotAliasInfo(email));
  }

  function getDotAliasProvider(email: string): 'gmail' | 'mailflare' {
    return isGmailAddress(email) ? 'gmail' : 'mailflare';
  }

  async function openDotAliases(claim: GptPlusClaimDto) {
    const aliasInfo = getDotAliasInfo(claim.email);
    if (!aliasInfo) {
      void warningToast($t('gpt.dotAliasUnavailableTitle'), $t('gpt.dotAliasUnavailableCopy'));
      return;
    }

    dotAliasModal = {
      claim,
      aliases: aliasInfo.aliases.filter((alias) => alias !== aliasInfo.email),
      activeAliases: claim.dotAliasCount > 0 ? [] : getDotAliasProvider(claim.email) === 'gmail' ? aliasInfo.aliases : [],
      totalLabel: formatCount(aliasInfo.totalLabel),
      truncated: aliasInfo.truncated,
      provider: getDotAliasProvider(claim.email),
      loading: true,
      activating: false,
      routingMessage: '',
      routingOk: null
    };
    dotAliasQuery = '';

    try {
      const response = await fetch(`/api/gpt-plus-claims/${claim.userId}/dot-aliases`, {
        headers: { accept: 'application/json' }
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            aliases?: string[];
            activeAliases?: string[];
            totalLabel?: string;
            truncated?: boolean;
          }
        | null;
      if (!response.ok || !payload || dotAliasModal?.claim.userId !== claim.userId) {
        if (dotAliasModal?.claim.userId === claim.userId) {
          dotAliasModal = { ...dotAliasModal, loading: false };
        }
        return;
      }

      const activeAliases =
        payload.activeAliases && payload.activeAliases.length > 0
          ? payload.activeAliases
          : getDotAliasProvider(claim.email) === 'gmail'
            ? payload.aliases ?? dotAliasModal.activeAliases
            : [];
      dotAliasModal = {
        ...dotAliasModal,
        aliases: payload.aliases ?? dotAliasModal.aliases,
        activeAliases,
        totalLabel: formatCount(payload.totalLabel ?? dotAliasModal.totalLabel),
        truncated: Boolean(payload.truncated ?? dotAliasModal.truncated),
        loading: false
      };
    } catch {
      if (dotAliasModal?.claim.userId === claim.userId) {
        dotAliasModal = { ...dotAliasModal, loading: false };
      }
    }
  }

  function closeDotAliases() {
    dotAliasModal = null;
    dotAliasQuery = '';
  }

  async function copyVisibleDotAliases() {
    if (!dotAliasModal) {
      return;
    }
    await copyValue($t('gpt.dotAliases'), dotAliasFiltered.join('\n'));
  }

  async function activateDotAliases() {
    if (!dotAliasModal || dotAliasModal.activating) {
      return;
    }

    const userId = dotAliasModal.claim.userId;
    dotAliasModal = { ...dotAliasModal, activating: true, routingMessage: '', routingOk: null };
    try {
      const response = await fetch(`/api/gpt-plus-claims/${userId}/dot-aliases`, {
        method: 'POST',
        headers: { accept: 'application/json' }
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            aliases?: string[];
            activeAliases?: string[];
            totalLabel?: string;
            truncated?: boolean;
            createdAliases?: string[];
            existingAliases?: string[];
            skippedAliases?: string[];
            routing?: { ok: boolean; message: string; createdRuleIds?: string[]; existingRuleIds?: string[] };
          }
        | null;

      if (!response.ok || !payload) {
        void errorToast($t('gpt.dotAliasFailedTitle'), payload?.error ?? $t('gpt.dotAliasFailed'));
        if (dotAliasModal?.claim.userId === userId) {
          dotAliasModal = { ...dotAliasModal, activating: false };
        }
        return;
      }

      const activeAliases = payload.activeAliases ?? [];
      claims = claims.map((claim) => (claim.userId === userId ? { ...claim, dotAliasCount: activeAliases.length } : claim));
      if (dotAliasModal?.claim.userId === userId) {
        dotAliasModal = {
          ...dotAliasModal,
          aliases: payload.aliases ?? dotAliasModal.aliases,
          activeAliases,
          totalLabel: formatCount(payload.totalLabel ?? dotAliasModal.totalLabel),
          truncated: Boolean(payload.truncated ?? dotAliasModal.truncated),
          activating: false,
          loading: false,
          routingMessage: payload.routing?.message ?? '',
          routingOk: payload.routing?.ok ?? null
        };
      }

      const createdCount = payload.createdAliases?.length ?? 0;
      const existingCount = payload.existingAliases?.length ?? 0;
      const skippedCount = payload.skippedAliases?.length ?? 0;
      if (payload.routing && !payload.routing.ok) {
        void warningToast($t('gpt.dotAliasWarningTitle'), $t('gpt.dotAliasRoutingWarning', { message: payload.routing.message }));
      } else {
        void successToast(
          $t('gpt.dotAliasSuccessTitle'),
          $t('gpt.dotAliasSuccess', {
            created: createdCount,
            existing: existingCount,
            skipped: skippedCount
          })
        );
      }
    } catch {
      void errorToast($t('gpt.dotAliasFailedTitle'), $t('gpt.dotAliasFailed'));
      if (dotAliasModal?.claim.userId === userId) {
        dotAliasModal = { ...dotAliasModal, activating: false };
      }
    }
  }

  async function deleteDeactivatedClaim(claim: GptPlusClaimDto) {
    if (claim.status !== 'deactivated' || deletingUserId) {
      return;
    }
    const confirmed = await confirmDialog({
      title: $t('gpt.deleteDeactivated'),
      text: $t('gpt.deleteConfirm', { email: claim.email }),
      icon: 'warning',
      detailLabel: $t('common.email'),
      detailValue: claim.email,
      note: $t('gpt.deactivatedNote'),
      confirmButtonText: $t('common.delete'),
      cancelButtonText: $t('common.cancel'),
      danger: true
    });
    if (!confirmed) {
      return;
    }

    deletingUserId = claim.userId;

    try {
      const response = await fetch(`/api/gpt-plus-claims/${claim.userId}`, {
        method: 'DELETE',
        headers: {
          'x-mailflare-confirm': 'delete-deactivated-gpt-user'
        }
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            alreadyDeleted?: boolean;
            routing?: { ok: boolean; skipped: boolean; deletedRuleIds: string[]; message: string };
          }
        | null;

      if (!response.ok) {
        void errorToast($t('gpt.noticeDeleteFailedTitle'), payload?.error ?? $t('gpt.deleteFailed'));
        return;
      }

      const deletedRoutes = payload?.routing?.deletedRuleIds?.length ?? 0;
      if (payload?.alreadyDeleted) {
        void successToast($t('gpt.noticeDeleteSuccessTitle'), $t('gpt.deleteAlreadyDone', { email: claim.email }));
      } else if (payload?.routing && !payload.routing.ok) {
        void warningToast(
          $t('gpt.noticeDeleteWarningTitle'),
          $t('gpt.deleteDoneRouteCheck', { email: claim.email, message: payload.routing.message })
        );
      } else {
        void successToast(
          $t('gpt.noticeDeleteSuccessTitle'),
          deletedRoutes > 0
            ? $t('gpt.deleteDone', { email: claim.email, count: deletedRoutes })
            : $t('gpt.deleteDoneNoRoute', { email: claim.email })
        );
      }
      claims = claims.filter((item) => item.userId !== claim.userId);
      await refreshClaims();
    } catch {
      void errorToast($t('gpt.noticeDeleteFailedTitle'), $t('gpt.deleteFailed'));
    } finally {
      deletingUserId = '';
    }
  }

  function filterLabel(filter: ClaimFilter) {
    if (filter === 'active') return $t('gpt.filter.active');
    if (filter === 'deactivated') return $t('gpt.filter.deactivated');
    return $t('gpt.filter.all');
  }

  function formatCount(value: string | number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return String(value);
    }
    return parsed.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID');
  }

  function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }
    return date.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID');
  }

  function getExpiryInfo(claim: GptPlusClaimDto): {
    badge: string;
    dateLabel: string;
    note: string;
    tone: BadgeTone;
    isExpired: boolean;
  } {
    const expiresAt = claim.expiresAt || getFallbackExpiry(claim.claimedAt);
    const expiresDate = new Date(expiresAt);
    if (!expiresAt || Number.isNaN(expiresDate.getTime())) {
      return {
        badge: $t('gpt.expiryUnknown'),
        dateLabel: '-',
        note: $t('gpt.expiryInvalid'),
        tone: 'neutral',
        isExpired: false
      };
    }

    const diffMs = expiresDate.getTime() - Date.now();
    const diffDays = Math.ceil(diffMs / DAY_MS);
    if (diffMs <= 0) {
      return {
        badge: $t('gpt.expired'),
        dateLabel: formatDate(expiresAt),
        note: $t('gpt.expiryPassed'),
        tone: 'danger',
        isExpired: true
      };
    }

    if (diffDays <= 3) {
      return {
        badge: $t('gpt.inDays', { count: diffDays }),
        dateLabel: formatDate(expiresAt),
        note: $t('gpt.expiryUrgent'),
        tone: 'danger',
        isExpired: false
      };
    }

    if (diffDays <= 7) {
      return {
        badge: $t('gpt.inDays', { count: diffDays }),
        dateLabel: formatDate(expiresAt),
        note: $t('gpt.expirySoon'),
        tone: 'warning',
        isExpired: false
      };
    }

    return {
      badge: $t('gpt.inDays', { count: diffDays }),
      dateLabel: formatDate(expiresAt),
      note: $t('gpt.expiryNote'),
      tone: 'primary',
      isExpired: false
    };
  }

  function getFallbackExpiry(claimedAt: string) {
    const claimedDate = new Date(claimedAt);
    if (Number.isNaN(claimedDate.getTime())) {
      return '';
    }

    const expiryDate = new Date(claimedDate);
    expiryDate.setMonth(expiryDate.getMonth() + 1);
    return expiryDate.toISOString();
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
  <AppSidebar active="gpt-plus" />
  <section class="main">
    <AppTopbar
      title={$t('gpt.title')}
      breadcrumb="flash mail flare / gpt plus"
      bind:searchQuery
      searchPlaceholder={$t('gpt.search')}
    >
      <span slot="actions" class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
    </AppTopbar>

    <div class="content">
      <div class="summary">
        <div>
          <h2>{$t('gpt.activeAccounts')}</h2>
          <p class="text-muted">{$t('gpt.claimedCopy')}</p>
        </div>
        <div class="summary-badges">
          <Badge tone="success">{$t('gpt.activeBadge', { count: activeClaimCount })}</Badge>
          {#if deactivatedClaimCount > 0}
            <Badge tone="danger">{$t('gpt.deactivatedBadge', { count: deactivatedClaimCount })}</Badge>
          {/if}
        </div>
      </div>

      <div class="filter-bar" aria-label={$t('gpt.filter.label')}>
        {#each statusFilters as filter}
          <button
            type="button"
            class:active={statusFilter === filter}
            aria-pressed={statusFilter === filter}
            on:click={() => (statusFilter = filter)}
          >
            {filterLabel(filter)}
            <span>
              {filter === 'active' ? activeClaimCount : filter === 'deactivated' ? deactivatedClaimCount : claims.length}
            </span>
          </button>
        {/each}
      </div>

      <div class="claims">
        {#if filteredClaims.length === 0}
          <div class="empty">
            <Icon name="workspace_premium" size={34} />
            <strong>{$t('gpt.emptyTitle')}</strong>
            <span class="text-muted">{$t('gpt.emptyCopy')}</span>
          </div>
        {:else}
          {#each filteredClaims as claim (claim.userId)}
            {@const expiry = getExpiryInfo(claim)}
            {@const isDeactivated = claim.status === 'deactivated'}
            {@const isProtectedOwner = isDeactivated && claim.role === 'owner'}
            <article class="claim-row">
              <div class="claim-main">
                <div class="claim-head">
                  <strong>{claim.displayName}</strong>
                  {#if isDeactivated}
                    <Badge tone="danger">{$t('gpt.deactivated')}</Badge>
                    {#if claim.role === 'owner'}
                      <Badge tone="warning">{$t('common.role.owner')}</Badge>
                    {/if}
                  {:else}
                    <Badge tone="success">{$t('user.gptActive')}</Badge>
                    <Badge tone={expiry.tone}>{expiry.badge}</Badge>
                  {/if}
                </div>
                <div class="credential-grid">
                  <div>
                    <span>{$t('common.email')}</span>
                    {#if canUseDotAliases(claim.email)}
                      <button
                        class="email-code-button"
                        type="button"
                        aria-label={$t('gpt.dotAliasOpenFor', { email: claim.email })}
                        title={$t('gpt.dotAliasOpenFor', { email: claim.email })}
                        on:click={() => openDotAliases(claim)}
                      >
                        <code>{claim.email}</code>
                        <Icon name="auto_awesome" size={15} />
                      </button>
                      <small class="gmail-hint">
                        {claim.dotAliasCount > 0
                          ? $t('gpt.dotAliasActiveHint', { count: claim.dotAliasCount })
                          : $t('gpt.dotAliasClickHint')}
                      </small>
                    {:else}
                      <code>{claim.email}</code>
                    {/if}
                  </div>
                  <div>
                    <span>{$t('gpt.firstPassword')}</span>
                    <code>{claim.initialPassword || $t('user.passwordNotSaved')}</code>
                  </div>
                  <div class="expiry-cell" class:expired={expiry.isExpired} class:deactivated={isDeactivated}>
                    {#if isDeactivated}
                      <span>{$t('gpt.deactivatedAt')}</span>
                      <code>{formatDate(claim.deactivatedAt || claim.claimedAt)}</code>
                      <small>{$t('gpt.deactivatedNote')}</small>
                    {:else}
                      <span>{$t('gpt.expiryDate')}</span>
                      <code>{expiry.dateLabel}</code>
                      <small>{expiry.note}</small>
                    {/if}
                  </div>
                </div>
                <div class="meta-line">
                  <span>{$t('email.received')}: {formatDate(claim.claimedAt)}</span>
                  <span>{claim.detectedSubject || $t('gpt.planEmail')}</span>
                  {#if isDeactivated && claim.deactivationSubject}
                    <span>{claim.deactivationSubject}</span>
                  {/if}
                </div>
              </div>
              <div class="claim-actions">
                <Button type="button" variant="secondary" on:click={() => copyValue($t('common.email'), claim.email)}>
                  <Icon name="content_copy" size={16} />
                  {$t('common.email')}
                </Button>
                {#if canUseDotAliases(claim.email)}
                  <Button type="button" variant="secondary" on:click={() => openDotAliases(claim)}>
                    <Icon name="auto_awesome" size={16} />
                    {$t('gpt.dotAliases')}
                  </Button>
                {/if}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!claim.initialPassword}
                  on:click={() => copyValue($t('common.password'), claim.initialPassword)}
                >
                  <Icon name="key" size={16} />
                  {$t('common.password')}
                </Button>
                <Button href={`/users/${claim.userId}/inbox`} variant="ghost">
                  <Icon name="inbox" size={16} />
                  {$t('inbox.title')}
                </Button>
                {#if isProtectedOwner}
                  <Button type="button" variant="secondary" disabled>
                    <Icon name="lock" size={16} />
                    {$t('gpt.ownerProtected')}
                  </Button>
                {:else if isDeactivated}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={Boolean(deletingUserId)}
                    on:click={() => deleteDeactivatedClaim(claim)}
                  >
                    <Icon name="delete_forever" size={16} />
                    {deletingUserId === claim.userId ? $t('gpt.deleteDeleting') : $t('gpt.deleteDeactivated')}
                  </Button>
                {/if}
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </div>
  </section>
</div>

{#if dotAliasModal}
  <button class="modal-backdrop" type="button" aria-label={$t('common.close')} on:click={closeDotAliases}></button>
  <div class="gmail-modal" role="dialog" aria-modal="true" aria-labelledby="gmail-alias-title">
    <div class="gmail-modal-card">
      <div class="gmail-modal-head">
        <div>
          <span class="modal-eyebrow">
            {dotAliasModal.provider === 'gmail' ? $t('gpt.gmailAliasEyebrow') : $t('gpt.dotAliasEyebrow')}
          </span>
          <h3 id="gmail-alias-title">{$t('gpt.dotAliasTitle')}</h3>
          <p class="text-muted">{$t('gpt.dotAliasCopy', { email: dotAliasModal.claim.email })}</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t('common.close')} on:click={closeDotAliases}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div class="gmail-alias-stats">
        <div>
          <span>{$t('gpt.dotAliasOriginal')}</span>
          <code>{dotAliasModal.claim.email}</code>
        </div>
        <div>
          <span>{$t('gpt.dotAliasPossible')}</span>
          <strong>{dotAliasModal.totalLabel}</strong>
        </div>
        <div>
          <span>{$t('gpt.dotAliasActive')}</span>
          <strong>{dotAliasModal.activeAliases.length.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID')}</strong>
        </div>
        <div>
          <span>{$t('gpt.dotAliasShowing')}</span>
          <strong>{dotAliasFiltered.length.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID')}</strong>
        </div>
      </div>

      <div class="gmail-alias-toolbar">
        <label class="gmail-search" for="gmail-alias-search">
          <Icon name="search" size={16} />
          <input id="gmail-alias-search" bind:value={dotAliasQuery} placeholder={$t('gpt.dotAliasSearch')} />
        </label>
        {#if dotAliasModal.provider === 'mailflare'}
          <button
            class="copy-all-button activate-alias-button"
            type="button"
            disabled={dotAliasModal.activating || dotAliasModal.aliases.length === 0}
            on:click={activateDotAliases}
          >
            <Icon name="route" size={16} />
            {dotAliasModal.activating ? $t('gpt.dotAliasActivating') : $t('gpt.dotAliasActivate')}
          </button>
        {/if}
        <button class="copy-all-button" type="button" disabled={dotAliasFiltered.length === 0} on:click={copyVisibleDotAliases}>
          <Icon name="content_copy" size={16} />
          {$t('gpt.dotAliasCopyVisible')}
        </button>
      </div>

      {#if dotAliasModal.loading}
        <p class="gmail-note">{$t('gpt.dotAliasLoading')}</p>
      {/if}
      {#if dotAliasModal.truncated}
        <p class="gmail-note">{$t('gpt.dotAliasLimited', { count: MAX_DOT_ALIAS_VARIANTS })}</p>
      {/if}
      {#if dotAliasModal.routingMessage}
        <p class="gmail-note" class:route-warning={dotAliasModal.routingOk === false}>{dotAliasModal.routingMessage}</p>
      {/if}
      <p class="gmail-note">
        {dotAliasModal.provider === 'gmail' ? $t('gpt.gmailAliasReceiveNote') : $t('gpt.dotAliasReceiveNote')}
      </p>

      <div class="gmail-alias-list">
        {#if dotAliasFiltered.length === 0}
          <div class="gmail-alias-empty">{$t('gpt.dotAliasEmpty')}</div>
        {:else}
          {#each dotAliasFiltered as alias (alias)}
            <div class="gmail-alias-row">
              <code>{alias}</code>
              {#if dotAliasActiveSet.has(alias)}
                <span class="alias-active-pill">{$t('common.active')}</span>
              {/if}
              <button type="button" on:click={() => copyValue($t('common.email'), alias)}>
                <Icon name="content_copy" size={15} />
                {$t('common.copy')}
              </button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

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

  .filter-bar {
    width: fit-content;
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.28rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 68%);
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 45%);
  }

  .filter-bar button {
    display: inline-flex;
    align-items: center;
    gap: 0.42rem;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-family: var(--font-family-headline);
    font-size: 0.76rem;
    font-weight: 800;
    padding: 0.48rem 0.78rem;
    transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
  }

  .filter-bar button.active {
    color: #fff;
    background: var(--color-primary-500);
    box-shadow: 0 8px 18px color-mix(in srgb, var(--color-primary-500), transparent 72%);
  }

  .filter-bar span {
    min-width: 1.3rem;
    border-radius: 999px;
    padding: 0.08rem 0.35rem;
    background: color-mix(in srgb, currentColor, transparent 86%);
    text-align: center;
    font-size: 0.68rem;
  }

  .sync-status {
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 72%);
    border-radius: var(--radius-pill);
    color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-surface-card), transparent 25%);
    padding: 0.34rem 0.7rem;
    font-size: 0.72rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .sync-status.syncing {
    color: var(--color-primary-500);
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 65%);
  }

  .claims {
    display: grid;
    gap: 0.7rem;
  }

  .claim-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 70%);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 45%);
  }

  .claim-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .credential-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .credential-grid div {
    display: grid;
    gap: 0.3rem;
  }

  .credential-grid span {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 800;
  }

  code {
    color: var(--color-primary-500);
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.86rem;
    overflow-wrap: anywhere;
  }

  .email-code-button {
    width: fit-content;
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 70%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary-500), transparent 92%);
    color: var(--color-primary-500);
    padding: 0.28rem 0.55rem;
    cursor: pointer;
  }

  .email-code-button:hover {
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 42%);
    background: color-mix(in srgb, var(--color-primary-500), transparent 86%);
  }

  .email-code-button code {
    font-size: 0.82rem;
  }

  .gmail-hint {
    color: var(--color-text-muted);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .expiry-cell small {
    color: var(--color-text-muted);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .expiry-cell.expired code,
  .expiry-cell.expired small {
    color: var(--color-danger);
  }

  .expiry-cell.deactivated code,
  .expiry-cell.deactivated small {
    color: var(--color-danger);
  }

  .meta-line {
    margin-top: var(--space-3);
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    color: var(--color-text-muted);
    font-size: 0.8rem;
  }

  .claim-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .empty {
    min-height: 18rem;
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--space-2);
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 50%);
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    text-align: center;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    border: 0;
    background: color-mix(in srgb, var(--color-text), transparent 58%);
    backdrop-filter: blur(3px);
    z-index: 20;
  }

  .gmail-modal {
    position: fixed;
    inset: 0;
    z-index: 21;
    display: grid;
    place-items: center;
    padding: var(--space-5);
  }

  .gmail-modal-card {
    width: min(58rem, 100%);
    max-height: min(82vh, 52rem);
    display: grid;
    grid-template-rows: auto auto auto auto minmax(0, 1fr);
    gap: var(--space-4);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 68%);
    border-radius: 1.25rem;
    background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--color-success), transparent 82%), transparent 36%),
      radial-gradient(circle at top right, color-mix(in srgb, var(--color-primary-500), transparent 84%), transparent 34%),
      var(--color-surface-card);
    box-shadow: var(--shadow-modal);
    overflow: hidden;
    padding: var(--space-5);
  }

  .gmail-modal-head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    align-items: flex-start;
  }

  .modal-eyebrow {
    color: var(--color-primary-500);
    text-transform: uppercase;
    letter-spacing: 0.15em;
    font-size: var(--font-size-label-xs);
    font-weight: 900;
  }

  .gmail-modal-head h3 {
    margin: 0.2rem 0 0.25rem;
    font-size: 1.65rem;
  }

  .gmail-modal-head p {
    margin: 0;
  }

  .modal-close {
    width: 2.25rem;
    height: 2.25rem;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 68%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-surface-card), transparent 12%);
    color: var(--color-text-muted);
    cursor: pointer;
  }

  .gmail-alias-stats {
    display: grid;
    grid-template-columns: 2fr repeat(3, 1fr);
    gap: var(--space-3);
  }

  .gmail-alias-stats div {
    display: grid;
    gap: 0.25rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 68%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-low), white 24%);
    padding: var(--space-3);
  }

  .gmail-alias-stats span {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 800;
  }

  .gmail-alias-stats strong {
    color: var(--color-text);
    font-size: 1.05rem;
  }

  .gmail-alias-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .gmail-search {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 62%);
    border-radius: 0.9rem;
    background: color-mix(in srgb, var(--color-surface-low), white 26%);
    color: var(--color-text-muted);
    padding: 0.72rem 0.85rem;
  }

  .gmail-search input {
    min-width: 0;
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--color-text);
    font: inherit;
  }

  .copy-all-button {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border: 0;
    border-radius: 0.9rem;
    background: var(--color-primary-500);
    color: #fff;
    cursor: pointer;
    font-family: var(--font-family-headline);
    font-size: 0.78rem;
    font-weight: 900;
    padding: 0.78rem 1rem;
    white-space: nowrap;
  }

  .copy-all-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .activate-alias-button {
    background: linear-gradient(135deg, var(--color-success), color-mix(in srgb, var(--color-primary-500), var(--color-success) 35%));
  }

  .gmail-note {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 0.82rem;
    line-height: 1.5;
  }

  .gmail-note.route-warning {
    color: var(--color-warning);
    font-weight: 800;
  }

  .gmail-alias-list {
    min-height: 0;
    display: grid;
    align-content: start;
    gap: 0.5rem;
    overflow: auto;
    padding-right: 0.25rem;
  }

  .gmail-alias-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 75%);
    border-radius: 0.85rem;
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 55%);
    padding: 0.58rem 0.72rem;
  }

  .gmail-alias-row code {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }

  .alias-active-pill {
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-success), transparent 82%);
    color: var(--color-success);
    font-size: 0.68rem;
    font-weight: 900;
    padding: 0.22rem 0.48rem;
    white-space: nowrap;
  }

  .gmail-alias-row button {
    display: inline-flex;
    align-items: center;
    gap: 0.32rem;
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 66%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary-500), transparent 90%);
    color: var(--color-primary-500);
    cursor: pointer;
    font-family: var(--font-family-headline);
    font-size: 0.72rem;
    font-weight: 900;
    padding: 0.35rem 0.58rem;
  }

  .gmail-alias-empty {
    display: grid;
    place-items: center;
    min-height: 8rem;
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 55%);
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    text-align: center;
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-4) var(--space-3);
    }

    .summary,
    .claim-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .summary {
      display: grid;
    }

    .filter-bar {
      width: 100%;
      overflow-x: auto;
    }

    .filter-bar button {
      flex: 1 0 auto;
      justify-content: center;
    }

    .credential-grid {
      grid-template-columns: 1fr;
    }

    .claim-actions {
      justify-content: stretch;
    }

    .gmail-modal {
      align-items: end;
      padding: 0;
    }

    .gmail-modal-card {
      width: 100%;
      max-height: 92vh;
      border-radius: 1.25rem 1.25rem 0 0;
      padding: var(--space-4);
    }

    .gmail-alias-stats,
    .gmail-alias-toolbar {
      grid-template-columns: 1fr;
      display: grid;
    }

    .copy-all-button {
      justify-content: center;
    }
  }
</style>
