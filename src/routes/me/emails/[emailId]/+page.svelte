<script lang="ts">
  import { goto } from '$app/navigation';
  import MailboxTopbar from '$lib/components/organisms/MailboxTopbar.svelte';
  import CardSurface from '$lib/components/atoms/CardSurface.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import EmailBodyViewer from '$lib/components/molecules/EmailBodyViewer.svelte';
  import type { PageData } from './$types';
  import { locale, t } from '$lib/i18n';
  import { confirmDialog, errorToast, successToast, warningToast } from '$lib/sweet-alert';

  export let data: PageData;

  type EmailQuickAction = 'star' | 'archive' | 'delete';

  let email = data.email;
  let activeEmailId = data.email.id;
  let isStarred = data.email.isStarred;
  let actionPending = false;
  let actionMessage = '';
  let actionError = '';

  $: email = data.email;

  $: if (data.email.id !== activeEmailId) {
    activeEmailId = data.email.id;
    isStarred = data.email.isStarred;
    actionPending = false;
    actionMessage = '';
    actionError = '';
  }

  $: receivedLabel = email.receivedAt ? new Date(email.receivedAt).toLocaleString($locale === 'en' ? 'en-US' : 'id-ID') : '-';

  async function runQuickAction(action: EmailQuickAction) {
    if (actionPending) {
      return;
    }

    if (action === 'delete') {
      const confirmed = await confirmDialog({
        title: $t('email.action.deleteLabel'),
        text: $t('email.action.deleteConfirm'),
        icon: 'warning',
        detailLabel: $t('email.subject'),
        detailValue: email.subject || email.id,
        note: receivedLabel,
        confirmButtonText: $t('common.delete'),
        cancelButtonText: $t('common.cancel'),
        danger: true
      });
      if (!confirmed) {
        return;
      }
    }

    actionMessage = '';
    actionError = '';
    actionPending = true;

    try {
      const response = await fetch(`/api/me/emails/${encodeURIComponent(email.id)}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action })
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        email?: { isStarred?: boolean };
      };

      if (!response.ok) {
        actionError = payload.error ?? $t('email.action.error');
        void errorToast($t('email.action.error'), actionError);
        return;
      }

      if (action === 'star') {
        isStarred = typeof payload.email?.isStarred === 'boolean' ? payload.email.isStarred : !isStarred;
        actionMessage = isStarred ? $t('email.action.starred') : $t('email.action.unstarred');
        void successToast(actionMessage);
        return;
      }

      if (action === 'archive') {
        void successToast($t('common.archived'), email.subject);
      } else {
        void warningToast($t('email.action.deleteLabel'), email.subject);
      }
      await goto('/me/inbox');
    } catch {
      actionError = 'Tidak bisa menghubungi server. Coba lagi.';
      void errorToast($t('email.action.error'), actionError);
    } finally {
      actionPending = false;
    }
  }
</script>

<section class="inbox-only-main">
  <MailboxTopbar
    userLabel={data.currentUser?.displayName ?? data.currentUser?.email ?? ''}
    showSearch={false}
    showRefresh={false}
  >
    <svelte:fragment slot="actions">
      <Button variant="secondary" href="/me/inbox">
        <Icon name="arrow_back" size={18} />
        {$t('common.backToInbox')}
      </Button>
    </svelte:fragment>
  </MailboxTopbar>
  <div class="content">
    <CardSurface>
      <div class="head">
        <div>
          <h2>{email.subject}</h2>
          <p class="text-muted">ID: {email.id}</p>
        </div>
        <div class="top-actions">
          <div class="badges">
            <Badge tone={email.isRead ? 'primary' : 'warning'}>{email.isRead ? $t('email.read') : $t('email.unread')}</Badge>
            {#if isStarred}
              <Badge tone="success">{$t('inbox.starred')}</Badge>
            {/if}
          </div>
          <div class="icon-actions">
            <button
              class="icon-action"
              type="button"
              aria-label={isStarred ? $t('email.action.starRemove') : $t('email.action.starAdd')}
              title={isStarred ? $t('email.action.starRemove') : $t('email.action.starAdd')}
              on:click={() => runQuickAction('star')}
              disabled={actionPending}
            >
              <Icon name={isStarred ? 'star' : 'star_border'} size={18} />
            </button>
            <button
              class="icon-action"
              type="button"
              aria-label={$t('email.action.archiveLabel')}
              title={$t('common.archive')}
              on:click={() => runQuickAction('archive')}
              disabled={actionPending}
            >
              <Icon name="archive" size={18} />
            </button>
            <button
              class="icon-action danger"
              type="button"
              aria-label={$t('email.action.deleteLabel')}
              title={$t('common.delete')}
              on:click={() => runQuickAction('delete')}
              disabled={actionPending}
            >
              <Icon name="delete" size={18} />
            </button>
          </div>
          {#if actionError}
            <p class="action-feedback error">{actionError}</p>
          {:else if actionMessage}
            <p class="action-feedback">{actionMessage}</p>
          {/if}
        </div>
      </div>

      <div class="meta-grid">
        <div>
          <div class="meta-label">{$t('email.from')}</div>
          <div class="meta-value">{email.sender}</div>
        </div>
        <div>
          <div class="meta-label">{$t('email.to')}</div>
          <div class="meta-value">{email.recipient}</div>
        </div>
        <div>
          <div class="meta-label">{$t('email.received')}</div>
          <div class="meta-value">{receivedLabel}</div>
        </div>
      </div>

      <div class="body">
        <h3>{$t('email.body')}</h3>
        <EmailBodyViewer bodyHtml={email.bodyHtml} bodyText={email.bodyText} snippet={email.snippet} />
      </div>
    </CardSurface>
  </div>
</section>

<style>
  .content {
    max-width: 80rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
  }

  .inbox-only-main {
    min-height: 100vh;
    width: 100%;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  h2 {
    margin-bottom: 0.2rem;
    line-height: 1.3;
  }

  .top-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3);
  }

  .badges {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .icon-actions {
    display: inline-flex;
    align-items: center;
    background: var(--color-surface-low);
    padding: 0.25rem;
    border-radius: 0.6rem;
    gap: 0.2rem;
  }

  .icon-action {
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 0.4rem;
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .icon-action:disabled {
    opacity: 0.45;
    cursor: wait;
  }

  .icon-action:hover {
    background: var(--color-surface-card);
    color: var(--color-primary-500);
    box-shadow: 0 1px 2px color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .icon-action.danger:hover {
    color: var(--color-danger);
  }

  .action-feedback {
    margin: 0;
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }

  .action-feedback.error {
    color: var(--color-danger);
  }

  .meta-grid {
    margin-top: var(--space-4);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .meta-label {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 700;
  }

  .meta-value {
    margin-top: 0.2rem;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  .body {
    margin-top: var(--space-4);
  }

  h3 {
    margin-bottom: var(--space-2);
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-5) var(--space-3);
    }

    .head {
      flex-direction: column;
      align-items: flex-start;
    }

    .top-actions {
      align-items: flex-start;
      margin-top: var(--space-2);
    }

    .badges {
      flex-wrap: wrap;
      justify-content: flex-start;
    }
  }

</style>
