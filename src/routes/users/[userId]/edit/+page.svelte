<script lang="ts">
  import { goto } from '$app/navigation';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import CardSurface from '$lib/components/atoms/CardSurface.svelte';
  import InputText from '$lib/components/atoms/InputText.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import type { PageData } from './$types';
  import { t } from '$lib/i18n';
  import { confirmDialog, errorToast, successToast } from '$lib/sweet-alert';

  export let data: PageData;

  let email = data.user.email;
  let displayName = data.user.displayName;
  let password = '';
  let confirmPassword = '';
  let isSubmitting = false;
  let isDeleting = false;
  let errorMessage = '';

  async function handleSave() {
    if (isSubmitting || isDeleting) {
      return;
    }

    isSubmitting = true;
    errorMessage = '';

    if (password && password.length < 8) {
      errorMessage = 'Kata sandi minimal 8 karakter.';
      isSubmitting = false;
      return;
    }
    if (password && password !== confirmPassword) {
      errorMessage = 'Konfirmasi kata sandi tidak sama.';
      isSubmitting = false;
      return;
    }

    try {
      const response = await fetch(`/api/users/${data.user.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          displayName,
          ...(password ? { password } : {})
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        errorMessage = payload?.error ?? 'Gagal memperbarui pengguna.';
        void errorToast($t('user.noticeActionFailed'), errorMessage);
        return;
      }

      void successToast($t('common.done'), $t('user.editTitle'));
      await goto('/users');
    } catch {
      errorMessage = 'Tidak bisa menghubungi server. Coba lagi.';
      void errorToast($t('user.noticeActionFailed'), errorMessage);
    } finally {
      isSubmitting = false;
    }
  }

  async function handleDelete() {
    if (isDeleting || isSubmitting) {
      return;
    }

    const confirmed = await confirmDialog({
      title: $t('common.delete'),
      text: $t('user.confirmDelete', { email: data.user.email }),
      icon: 'warning',
      detailLabel: $t('common.email'),
      detailValue: data.user.email,
      confirmButtonText: $t('common.delete'),
      cancelButtonText: $t('common.cancel'),
      danger: true
    });
    if (!confirmed) {
      return;
    }

    isDeleting = true;
    errorMessage = '';

    try {
      const response = await fetch(`/api/users/${data.user.id}`, {
        method: 'DELETE',
        headers: {
          'x-mailflare-confirm': 'delete-user'
        }
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | {
              error?: string;
              dependencies?: { emails?: number; loginSessions?: number };
            }
          | null;

        if (payload?.dependencies) {
          errorMessage = `${payload.error ?? $t('user.deleteBlocked')} (email: ${payload.dependencies.emails ?? 0}, sesi: ${payload.dependencies.loginSessions ?? 0})`;
        } else {
          errorMessage = payload?.error ?? 'Gagal menghapus pengguna.';
        }
        void errorToast($t('user.noticeActionFailed'), errorMessage);
        return;
      }

      void successToast($t('common.delete'), $t('user.disabledMessage', { email: data.user.email, message: '' }));
      await goto('/users');
    } catch {
      errorMessage = 'Tidak bisa menghubungi server. Coba lagi.';
      void errorToast($t('user.noticeActionFailed'), errorMessage);
    } finally {
      isDeleting = false;
    }
  }
</script>

<div class="layout-shell">
  <AppSidebar active="users" />
  <section class="main">
        <AppTopbar title={$t('user.editTitle')} breadcrumb="flash mail flare / users / edit" showSearch={false} />
    <div class="content">
      <CardSurface>
        <div class="panel">
          <div>
            <h2>{$t('user.editTitle')}</h2>
            <p class="text-muted">{$t('user.editCopy')}</p>
          </div>

          <form class="form" on:submit|preventDefault={handleSave}>
            <div>
              <label for="display-name">{$t('user.displayName')}</label>
              <InputText id="display-name" bind:value={displayName} required />
            </div>

            <div>
              <label for="email">{$t('common.email')}</label>
              <InputText id="email" type="email" bind:value={email} required />
            </div>
            <div>
              <label for="password">{$t('user.newPassword')}</label>
              <InputText id="password" type="password" bind:value={password} placeholder={$t('user.newPasswordPlaceholder')} />
            </div>
            <div>
              <label for="confirm-password">{$t('user.newPasswordConfirm')}</label>
              <InputText id="confirm-password" type="password" bind:value={confirmPassword} placeholder={$t('user.newPasswordConfirm')} />
            </div>

            {#if errorMessage}
              <p class="error">{errorMessage}</p>
            {/if}

            <div class="actions">
              <Button href="/users" variant="ghost">{$t('common.cancel')}</Button>
              <Button type="button" variant="secondary" disabled={isDeleting || isSubmitting} on:click={handleDelete}>
                {isDeleting ? 'Menghapus...' : $t('common.delete')}
              </Button>
              <Button type="submit" disabled={isSubmitting || isDeleting}>
                {isSubmitting ? $t('common.saving') : $t('common.saveChanges')}
              </Button>
            </div>
          </form>
        </div>
      </CardSurface>
    </div>
  </section>
</div>

<style>
  .main {
    min-width: 0;
  }

  .content {
    padding: var(--space-5);
  }

  .panel {
    display: grid;
    gap: var(--space-5);
    max-width: 42rem;
  }

  h2 {
    font-size: 1.35rem;
    margin-bottom: 0.3rem;
  }

  .form {
    display: grid;
    gap: var(--space-4);
  }

  label {
    display: block;
    margin-bottom: 0.35rem;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--font-size-label-xs);
    font-weight: 700;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .error {
    color: #c1263c;
    font-size: 0.85rem;
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-4) var(--space-3);
    }

    .actions {
      flex-wrap: wrap;
      justify-content: stretch;
    }

    .actions :global(.btn) {
      flex: 1 1 100%;
    }
  }
</style>
