<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import type { PageData } from './$types';
  import type { AdminEmailSearchResultDto } from '$lib/types/dto';
  import { locale, t } from '$lib/i18n';

  export let data: PageData;

  const SEARCH_DEBOUNCE_MS = 300;

  let searchQuery = data.initialQuery;
  let results: AdminEmailSearchResultDto[] = [];
  let loading = false;
  let errorMessage = '';
  let hasSearched = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchRequestId = 0;
  let mounted = false;

  $: normalizedQuery = searchQuery.trim();
  $: resultLabel = loading
    ? $t('emailSearch.searching')
    : hasSearched
      ? $t('emailSearch.resultCount', { count: results.length })
      : $t('emailSearch.ready');
  $: if (mounted) {
    queueSearch(normalizedQuery);
  }

  function queueSearch(query: string) {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }

    errorMessage = '';
    if (!query) {
      results = [];
      hasSearched = false;
      loading = false;
      return;
    }

    if (query.length < 2) {
      results = [];
      hasSearched = false;
      loading = false;
      errorMessage = $t('emailSearch.minQuery');
      return;
    }

    loading = true;
    searchTimer = setTimeout(() => {
      void runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(query: string) {
    const requestId = ++searchRequestId;
    const url = new URL('/api/admin/email-search', window.location.origin);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '100');

    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json'
        }
      });
      const payload = (await response.json().catch(() => null)) as {
        results?: AdminEmailSearchResultDto[];
        error?: string;
      } | null;

      if (requestId !== searchRequestId || query !== normalizedQuery) {
        return;
      }

      if (!response.ok) {
        throw new Error(payload?.error ?? $t('emailSearch.failed'));
      }

      results = sortResultsByDate(payload?.results ?? []);
      hasSearched = true;
    } catch (error) {
      if (requestId !== searchRequestId) {
        return;
      }

      results = [];
      hasSearched = true;
      errorMessage = error instanceof Error ? error.message : $t('emailSearch.failed');
    } finally {
      if (requestId === searchRequestId) {
        loading = false;
      }
    }
  }

  function sortResultsByDate(items: AdminEmailSearchResultDto[]) {
    return [...items].sort((a, b) => getDateTime(b.receivedAt) - getDateTime(a.receivedAt) || b.id.localeCompare(a.id));
  }

  function getDateTime(value: string) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }

    const fallback = Date.parse(value.replace(' ', 'T'));
    return Number.isNaN(fallback) ? 0 : fallback;
  }

  function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value || '-';
    }
    return date.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID');
  }

  onMount(() => {
    mounted = true;
    if (normalizedQuery) {
      queueSearch(normalizedQuery);
    }

    return () => {
      if (searchTimer) {
        clearTimeout(searchTimer);
      }
    };
  });

  onDestroy(() => {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
  });
</script>

<div class="layout-shell">
  <AppSidebar active="email-search" />
  <section class="main">
    <AppTopbar
      title={$t('emailSearch.title')}
      breadcrumb="flash mail flare / email search"
      bind:searchQuery
      searchPlaceholder={$t('emailSearch.search')}
    >
      <span slot="actions" class="sync-status" class:syncing={loading}>{resultLabel}</span>
    </AppTopbar>

    <div class="content">
      <section class="hero surface-card">
        <div>
          <span class="eyebrow">{$t('emailSearch.eyebrow')}</span>
          <h2>{$t('emailSearch.heroTitle')}</h2>
          <p class="text-muted">{$t('emailSearch.heroCopy')}</p>
        </div>
        <Badge tone={hasSearched && results.length > 0 ? 'success' : 'primary'}>{resultLabel}</Badge>
      </section>

      {#if errorMessage}
        <div class="notice error">
          <Icon name="error" size={18} />
          <span>{errorMessage}</span>
        </div>
      {/if}

      <section class="results">
        {#if !normalizedQuery}
          <div class="empty surface-card">
            <Icon name="manage_search" size={36} />
            <strong>{$t('emailSearch.idleTitle')}</strong>
            <span class="text-muted">{$t('emailSearch.idleCopy')}</span>
          </div>
        {:else if loading && results.length === 0}
          <div class="empty surface-card">
            <Icon name="hourglass_top" size={36} />
            <strong>{$t('emailSearch.loadingTitle')}</strong>
            <span class="text-muted">{$t('emailSearch.loadingCopy')}</span>
          </div>
        {:else if hasSearched && results.length === 0 && !errorMessage}
          <div class="empty surface-card">
            <Icon name="mark_email_unread" size={36} />
            <strong>{$t('emailSearch.emptyTitle')}</strong>
            <span class="text-muted">{$t('emailSearch.emptyCopy')}</span>
          </div>
        {:else}
          {#each results as email (email.id)}
            <article class="result-row surface-card">
              <div class="result-main">
                <div class="result-head">
                  <strong>{email.subject}</strong>
                  {#if !email.isRead}
                    <Badge tone="primary">{$t('email.unread')}</Badge>
                  {/if}
                  {#if email.isStarred}
                    <Badge tone="warning">{$t('inbox.starred')}</Badge>
                  {/if}
                  {#if email.isArchived}
                    <Badge tone="neutral">{$t('common.archived')}</Badge>
                  {/if}
                </div>

                <div class="owner-line">
                  <span>{$t('emailSearch.owner')}: <strong>{email.userDisplayName}</strong></span>
                  <code>{email.userEmail}</code>
                  {#if email.userRole === 'owner'}
                    <Badge tone="warning">{$t('common.role.owner')}</Badge>
                  {/if}
                  {#if email.userStatus === 'disabled'}
                    <Badge tone="danger">{$t('common.off')}</Badge>
                  {/if}
                </div>

                <div class="meta-line">
                  <span>{$t('email.from')}: {email.sender || '-'}</span>
                  <span>{$t('email.to')}: {email.recipient || '-'}</span>
                  <span>{$t('email.received')}: {formatDate(email.receivedAt)}</span>
                </div>

                <p class="snippet">{email.searchSnippet || email.snippet || $t('email.noContent')}</p>
              </div>

              <div class="result-actions">
                <Button href={`/users/${email.userId}/emails/${email.id}`} variant="secondary">
                  <Icon name="drafts" size={16} />
                  {$t('emailSearch.openEmail')}
                </Button>
                <Button href={`/users/${email.userId}/inbox`} variant="ghost">
                  <Icon name="inbox" size={16} />
                  {$t('inbox.title')}
                </Button>
              </div>
            </article>
          {/each}
        {/if}
      </section>
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

  .hero {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-5);
    overflow: hidden;
    position: relative;
  }

  .hero::after {
    content: '';
    position: absolute;
    inset: auto -5rem -7rem auto;
    width: 16rem;
    height: 16rem;
    border-radius: 999px;
    background: radial-gradient(circle, color-mix(in srgb, var(--color-primary-500), transparent 76%), transparent 62%);
    pointer-events: none;
  }

  .eyebrow {
    display: block;
    margin-bottom: var(--space-2);
    color: var(--color-primary-500);
    font-size: var(--font-size-label-xs);
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .hero h2 {
    font-size: clamp(1.35rem, 2.2vw, 2rem);
    letter-spacing: -0.03em;
    margin-bottom: var(--space-2);
  }

  .hero p {
    max-width: 48rem;
    margin: 0;
    line-height: 1.65;
  }

  .sync-status,
  .notice {
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 72%);
    border-radius: var(--radius-pill);
    color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-surface-card), transparent 25%);
    padding: 0.34rem 0.7rem;
    font-size: 0.72rem;
    font-weight: 700;
  }

  .sync-status.syncing {
    color: var(--color-primary-500);
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 65%);
  }

  .notice {
    border-radius: var(--radius-md);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .notice.error {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger), transparent 64%);
    background: color-mix(in srgb, var(--color-danger), var(--color-surface-card) 92%);
  }

  .results {
    display: grid;
    gap: var(--space-3);
  }

  .result-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-4);
    padding: var(--space-4);
    align-items: start;
  }

  .result-main {
    min-width: 0;
    display: grid;
    gap: var(--space-3);
  }

  .result-head,
  .owner-line,
  .meta-line,
  .result-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .result-head strong {
    font-size: 1rem;
    overflow-wrap: anywhere;
  }

  .owner-line,
  .meta-line,
  .snippet {
    color: var(--color-text-muted);
  }

  .owner-line code {
    border-radius: var(--radius-pill);
    padding: 0.25rem 0.55rem;
    color: var(--color-text);
    background: var(--color-surface-low);
    overflow-wrap: anywhere;
  }

  .meta-line {
    font-size: 0.78rem;
  }

  .snippet {
    margin: 0;
    max-width: 72rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .result-actions {
    justify-content: flex-end;
  }

  .empty {
    min-height: 14rem;
    padding: var(--space-6);
    display: grid;
    place-items: center;
    gap: var(--space-2);
    text-align: center;
    color: var(--color-text-muted);
  }

  .empty strong {
    color: var(--color-text);
    font-size: 1.05rem;
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-4) var(--space-3);
    }

    .hero,
    .result-row {
      grid-template-columns: 1fr;
    }

    .hero {
      align-items: flex-start;
      flex-direction: column;
    }

    .result-actions {
      justify-content: flex-start;
    }
  }
</style>
