<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import MailboxTopbar from '$lib/components/organisms/MailboxTopbar.svelte';
  import InboxTable from '$lib/components/organisms/InboxTable.svelte';
  import type { PageData } from './$types';
  import type { EmailDto } from '$lib/types/dto';
  import { t } from '$lib/i18n';

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;

  let searchQuery = '';
  let emails: EmailDto[] = data.emails;
  let archivedCount = data.archivedCount ?? 0;
  let autoRefreshing = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredEmails = normalizedQuery
    ? emails.filter((email) =>
        [email.sender, email.subject, email.snippet].some((field) => field.toLowerCase().includes(normalizedQuery))
      )
    : emails;
  $: unreadCount = emails.filter((email) => !email.isRead && !email.isArchived).length;
  $: starredCount = emails.filter((email) => email.isStarred && !email.isArchived).length;
  $: inboxCount = Math.max(0, emails.filter((email) => !email.isArchived).length);
  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');

  async function refreshInbox() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/me/inbox', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as
        | {
            emails?: EmailDto[];
            archivedCount?: number;
          }
        | null;
      if (!payload?.emails) {
        return;
      }

      emails = payload.emails;
      archivedCount = Number(payload.archivedCount ?? archivedCount);
    } finally {
      autoRefreshing = false;
    }
  }

  onMount(() => {
    autoRefreshTimer = setInterval(refreshInbox, AUTO_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshInbox();
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

<section class="inbox-only-main">
  <MailboxTopbar
    userLabel={data.currentUser.displayName}
    bind:searchQuery
    searchPlaceholder={$t('inbox.search')}
  />

  <div class="content">
    <div class="inbox-head">
      <div class="title-wrap">
        <h1>{$t('inbox.title')}</h1>
        <span class="badge">{unreadCount} {$t('common.new')}</span>
      </div>
      <span class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
    </div>

    <InboxTable userId={data.userId} emails={filteredEmails} emailHrefPrefix="/me/emails" mailboxOnly={true} />
  </div>

  <footer class="stats-footer">
    <div class="stats-grid">
      <div class="stat">
        <span>{$t('inbox.totalInbox')}</span>
        <strong>{inboxCount}</strong>
      </div>
      <div class="separator" aria-hidden="true"></div>
      <div class="stat">
        <span>{$t('inbox.totalStarred')}</span>
        <strong>{starredCount}</strong>
      </div>
      <div class="separator" aria-hidden="true"></div>
      <div class="stat">
        <span>{$t('inbox.totalArchived')}</span>
        <strong>{archivedCount}</strong>
      </div>
    </div>
  </footer>
</section>

<style>
  .content {
    max-width: 80rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
    display: grid;
    gap: var(--space-5);
  }

  .inbox-only-main {
    min-height: 100vh;
    width: 100%;
    display: flex;
    flex-direction: column;
  }

  .inbox-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }

  .title-wrap {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }

  h1 {
    font-size: 1.8rem;
    line-height: 1.2;
  }

  .badge {
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--color-primary-500), transparent 88%);
    color: var(--color-primary-500);
    padding: 0.3rem 0.62rem;
    font-size: 0.74rem;
    font-weight: 700;
  }

  .sync-status {
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

  .stats-footer {
    margin-top: auto;
    border-top: 1px solid color-mix(in srgb, var(--color-outline), transparent 76%);
    padding: var(--space-5) var(--space-3);
  }

  .stats-grid {
    max-width: 80rem;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-5);
  }

  .stat {
    text-align: center;
  }

  .stat span {
    display: block;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--color-text-muted);
    margin-bottom: 0.35rem;
    font-weight: 700;
  }

  .stat strong {
    font-family: var(--font-family-headline);
    font-size: 1.45rem;
  }

  .separator {
    width: 1px;
    height: 2.2rem;
    background: color-mix(in srgb, var(--color-outline), transparent 70%);
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-5) var(--space-3);
      gap: var(--space-4);
    }

    h1 {
      font-size: 1.45rem;
    }

    .stats-footer {
      padding: var(--space-4) var(--space-3);
    }

    .stats-grid {
      gap: var(--space-3);
      width: 100%;
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .separator {
      display: none;
    }

    .stat strong {
      font-size: 1.2rem;
    }
  }
</style>
