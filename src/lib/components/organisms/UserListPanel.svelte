<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { MailDomainDto, UserDto } from '$lib/types/dto';
  import CardSurface from '$lib/components/atoms/CardSurface.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Avatar from '$lib/components/atoms/Avatar.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import InputText from '$lib/components/atoms/InputText.svelte';
  import { t } from '$lib/i18n';
  import { confirmDialog, errorToast, successToast, toast, warningToast } from '$lib/sweet-alert';

  type DomainOption = MailDomainDto & {
    isExternal?: boolean;
    label: string;
  };

  const OUTLOOK_DOMAIN = 'outlook.com';
  const GMAIL_DOMAIN = 'gmail.com';
  const EXTERNAL_DOMAIN_OPTIONS = [
    {
      domain: OUTLOOK_DOMAIN,
      labelKey: 'user.outlookDomainOption',
      aliasPrefix: 'outlook',
      badgeKey: 'user.outlookBadge'
    },
    {
      domain: GMAIL_DOMAIN,
      labelKey: 'user.gmailDomainOption',
      aliasPrefix: 'gmail',
      badgeKey: 'user.gmailBadge'
    }
  ];

  export let users: UserDto[] = [];
  export let domains: MailDomainDto[] = [];
  export let autoRefreshing = false;

  const dispatch = createEventDispatcher<{ usercreated: void; userchanged: void }>();

  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');

  let modalOpen = false;
  let username = '';
  let selectedDomain = '';
  let isSubmitting = false;
  let isGeneratingUsername = false;
  let actionUserId = '';
  let errorMessage = '';
  let copyMessage = '';
  let routingMessage = '';
  let credentialContext: 'create' | 'reset' = 'create';
  let generatedCredentials: {
    username: string;
    email: string;
    password: string;
    outlookForwardingAddress?: string;
  } | null = null;

  $: domainOptions = buildDomainOptions(domains, $t);
  $: selectedDomainOption = domainOptions.find((domain) => domain.domain === selectedDomain);
  $: selectedDomainIsExternal = selectedDomainOption?.isExternal === true;
  $: forwardingPreviewDomain =
    domains.find((domain) => domain.isDefault && !isExternalDomain(domain.domain))?.domain ??
    domains.find((domain) => !isExternalDomain(domain.domain))?.domain ??
    '';
  $: selectedExternalOption = EXTERNAL_DOMAIN_OPTIONS.find((option) => option.domain === selectedDomain);
  $: externalForwardingPreview =
    selectedDomainIsExternal && forwardingPreviewDomain
      ? `${buildExternalForwardingLocalPart(username.trim().toLowerCase() || 'namauser', selectedExternalOption?.aliasPrefix ?? 'mail')}@${forwardingPreviewDomain}`
      : '';

  function formatCount(value: number | undefined) {
    return Number(value ?? 0).toLocaleString('id-ID');
  }

  function formatUserStatus(status: UserDto['status']) {
    return status === 'active' ? $t('common.active') : $t('common.off');
  }

  function formatUserRole(role: string) {
    if (role === 'owner') return $t('common.role.owner');
    if (role === 'member') return $t('common.role.member');
    return role;
  }

  function isGptPlusDeactivated(user: UserDto) {
    return user.gptPlusStatus === 'deactivated';
  }

  function formatGptPlusStatus(user: UserDto) {
    return isGptPlusDeactivated(user) ? $t('user.gptDeactivated') : $t('user.gptActive');
  }

  function getExternalUserOption(user: UserDto) {
    return EXTERNAL_DOMAIN_OPTIONS.find((option) => option.domain === (user.email.split('@')[1] ?? '').toLowerCase());
  }

  function isExternalDomain(domain: string) {
    return EXTERNAL_DOMAIN_OPTIONS.some((option) => option.domain === domain);
  }

  function buildExternalForwardingLocalPart(value: string, prefix: string) {
    const sanitized = value.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
    return `${prefix}-${sanitized || 'user'}`.slice(0, 64);
  }

  function buildDomainOptions(sourceDomains: MailDomainDto[], translate: (key: string, params?: Record<string, string | number>) => string): DomainOption[] {
    const managedDomains = sourceDomains.map((domain) => ({
      ...domain,
      label: `${domain.domain}${domain.isDefault ? ` (${translate('worker.defaultLabel').toLowerCase()})` : ''}`
    }));
    const externalOptions = EXTERNAL_DOMAIN_OPTIONS.filter((option) => !managedDomains.some((domain) => domain.domain === option.domain)).map(
      (option) => ({
        domain: option.domain,
        zoneId: '',
        status: 'external',
        nameservers: [],
        isDefault: false,
        emailRoutingEnabled: false,
        emailRoutingStatus: 'external',
        lastSetupMessage: translate('user.outlookExternalHelp'),
        lastSyncedAt: '',
        isExternal: true,
        label: translate(option.labelKey)
      })
    );

    return [...managedDomains, ...externalOptions];
  }

  function openModal() {
    modalOpen = true;
    resetForm();
  }

  function closeModal() {
    if (isSubmitting) {
      return;
    }
    modalOpen = false;
    resetForm();
  }

  function resetForm() {
    username = '';
    selectedDomain = domains.find((domain) => domain.isDefault)?.domain ?? domains[0]?.domain ?? OUTLOOK_DOMAIN;
    errorMessage = '';
    copyMessage = '';
    routingMessage = '';
    generatedCredentials = null;
    credentialContext = 'create';
  }

  function showActionToast(message: string, tone: 'success' | 'warning' | 'danger' | 'info' = 'info', title = '') {
    const toastTitle = title || $t('common.status');
    if (tone === 'success') {
      void successToast(toastTitle, message);
      return;
    }
    if (tone === 'warning') {
      void warningToast(toastTitle, message);
      return;
    }
    if (tone === 'danger') {
      void errorToast(toastTitle, message);
      return;
    }
    void toast({ icon: 'info', title: toastTitle, text: message });
  }

  $: if (domainOptions.length > 0 && !domainOptions.some((domain) => domain.domain === selectedDomain)) {
    selectedDomain = domains.find((domain) => domain.isDefault)?.domain ?? domains[0]?.domain ?? OUTLOOK_DOMAIN;
  }

  async function generateRandomUsername() {
    if (isGeneratingUsername || isSubmitting) {
      return;
    }

    isGeneratingUsername = true;
    errorMessage = '';
    const domain = selectedDomain || domains.find((item) => item.isDefault)?.domain || domains[0]?.domain || OUTLOOK_DOMAIN;
    const params = new URLSearchParams();
    if (domain) {
      params.set('domain', domain);
    }

    try {
      const response = await fetch(`/api/users/random-username${params.size > 0 ? `?${params.toString()}` : ''}`);
      const payload = (await response.json().catch(() => null)) as { username?: string; error?: string } | null;
      if (!response.ok || !payload?.username) {
        errorMessage = payload?.error ?? 'Gagal membuat nama pengguna acak.';
        return;
      }

      username = payload.username;
    } catch {
      errorMessage = 'Tidak bisa menghubungi server untuk nama pengguna acak.';
    } finally {
      isGeneratingUsername = false;
    }
  }

  async function handleCreateUser() {
    if (isSubmitting) {
      return;
    }

    errorMessage = '';
    isSubmitting = true;

    const normalized = username.trim().toLowerCase();
    if (!normalized) {
      errorMessage = 'Nama pengguna wajib diisi.';
      isSubmitting = false;
      return;
    }
    if (normalized.length < 3 || normalized.length > 64) {
      errorMessage = 'Nama pengguna harus 3-64 karakter.';
      isSubmitting = false;
      return;
    }
    if (!/^[a-z0-9._-]+$/.test(normalized)) {
      errorMessage = 'Nama pengguna hanya boleh a-z, 0-9, titik, underscore, dan tanda hubung.';
      isSubmitting = false;
      return;
    }

    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: normalized,
          ...(selectedDomain ? { domain: selectedDomain } : {})
        })
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            credentials?: {
              username: string;
              email: string;
              password: string;
              outlookForwardingAddress?: string;
            };
            routing?: {
              ok: boolean;
              skipped: boolean;
              ruleId: string;
              message: string;
            };
          }
        | null;
      if (!response.ok) {
        errorMessage = payload?.error ?? 'Gagal membuat pengguna.';
        return;
      }

      if (!payload?.credentials) {
        errorMessage = $t('user.credentialsMissing');
        return;
      }

      generatedCredentials = payload.credentials;
      if (payload.routing?.ok) {
        routingMessage = payload.routing.ruleId
          ? $t('user.routeCreated', { ruleId: payload.routing.ruleId })
          : payload.routing.message || $t('user.routeReady');
      } else {
        routingMessage = payload.routing?.message
          ? $t('user.routeFailed', { message: payload.routing.message })
          : $t('user.routeNotConfirmed');
      }
      credentialContext = 'create';
      username = '';
      modalOpen = false;
      dispatch('usercreated');
      dispatch('userchanged');
    } catch {
      errorMessage = 'Tidak bisa menghubungi server. Coba lagi.';
    } finally {
      isSubmitting = false;
    }
  }

  async function copyValue(label: string, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      copyMessage = `${label} disalin.`;
    } catch {
      copyMessage = 'Gagal menyalin. Silakan salin manual.';
    }
  }

  async function handleQuickCopyEmail(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      showActionToast('Email disalin.', 'success', $t('common.copySucceededTitle'));
    } catch {
      showActionToast('Gagal menyalin email.', 'danger', $t('common.copyFailedTitle'));
    }
  }

  async function handleQuickCopyInitialPassword(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      showActionToast('Kata sandi awal disalin.', 'success', $t('common.copySucceededTitle'));
    } catch {
      showActionToast('Gagal menyalin kata sandi awal.', 'danger', $t('common.copyFailedTitle'));
    }
  }

  async function handleQuickCopyOutlookForwarding(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      showActionToast($t('user.externalForwardingCopied'), 'success', $t('common.copySucceededTitle'));
    } catch {
      showActionToast('Gagal menyalin alamat forwarding eksternal.', 'danger', $t('common.copyFailedTitle'));
    }
  }

  async function handleQuickResetPassword(user: UserDto) {
    if (isSubmitting || actionUserId) {
      return;
    }
    const confirmed = await confirmDialog({
      title: $t('user.resetPassword'),
      text: $t('user.confirmReset', { email: user.email }),
      icon: 'question',
      detailLabel: $t('common.email'),
      detailValue: user.email,
      note: $t('user.safePasswordNotice'),
      confirmButtonText: $t('user.resetPassword'),
      cancelButtonText: $t('common.cancel')
    });
    if (!confirmed) {
      return;
    }

    errorMessage = '';
    actionUserId = user.id;

    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ resetPassword: true })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; password?: string } | null;

      if (!response.ok || !payload?.password) {
        showActionToast(payload?.error ?? 'Gagal reset kata sandi.', 'danger', $t('user.noticeActionFailed'));
        return;
      }

      generatedCredentials = {
        username: user.displayName,
        email: user.email,
        password: payload.password
      };
      copyMessage = '';
      credentialContext = 'reset';
      modalOpen = true;
      void successToast($t('user.resetPassword'), $t('user.resetSuccessCopy'));
      dispatch('userchanged');
    } catch {
      showActionToast('Tidak bisa menghubungi server. Coba lagi.', 'danger', $t('user.noticeActionFailed'));
    } finally {
      actionUserId = '';
    }
  }

  async function handleQuickSoftDelete(user: UserDto) {
    if (isSubmitting || actionUserId) {
      return;
    }
    if (user.role === 'owner') {
      showActionToast($t('user.ownerProtected'), 'warning', $t('user.noticeBlockedTitle'));
      return;
    }
    const confirmed = await confirmDialog({
      title: $t('user.disable'),
      text: $t('user.confirmDisable', { email: user.email }),
      icon: 'warning',
      detailLabel: $t('common.email'),
      detailValue: user.email,
      confirmButtonText: $t('user.disable'),
      cancelButtonText: $t('common.cancel'),
      danger: true
    });
    if (!confirmed) {
      return;
    }

    errorMessage = '';
    actionUserId = user.id;

    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: 'DELETE',
        headers: {
          'x-mailflare-confirm': 'soft-delete-user'
        }
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; routing?: { ok: boolean; skipped: boolean; deletedRuleIds: string[]; message: string } }
        | null;
      if (!response.ok) {
        showActionToast(payload?.error ?? 'Gagal menonaktifkan pengguna.', 'danger', $t('user.noticeActionFailed'));
        return;
      }

      const routingMessage = payload?.routing?.ok
        ? payload.routing.deletedRuleIds.length > 0
          ? $t('user.routeDeleted')
          : $t('user.routeNone')
        : $t('user.routeCleanupCheck');
      showActionToast(
        $t('user.disabledMessage', { email: user.email, message: routingMessage }),
        payload?.routing?.ok ? 'success' : 'warning',
        payload?.routing?.ok ? $t('user.noticeDisabledTitle') : $t('user.noticeRouteWarningTitle')
      );
      dispatch('userchanged');
    } catch {
      showActionToast('Tidak bisa menghubungi server. Coba lagi.', 'danger', $t('user.noticeActionFailed'));
    } finally {
      actionUserId = '';
    }
  }
</script>

<CardSurface>
  <div class="panel-header">
    <div>
      <h2>{$t('user.management')}</h2>
      <p class="text-muted">{$t('user.listCopy')}</p>
    </div>
    <div class="panel-actions">
      <span class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
      <Button on:click={openModal}>
        <Icon name="person_add" size={18} />
        {$t('user.add')}
      </Button>
    </div>
  </div>
  {#if generatedCredentials && credentialContext === 'create'}
    <div class="created-credential-card" role="status" aria-live="polite">
      <div class="created-credential-head">
        <div class="created-credential-icon">
          <Icon name="mark_email_read" size={20} />
        </div>
        <div>
          <h3>{$t('user.created')}</h3>
          <p class="text-muted">{$t('user.createdCopy')}</p>
        </div>
      </div>
      <div class="created-credential-grid">
        <div class="created-credential-item">
          <span>{$t('common.email')}</span>
          <code>{generatedCredentials.email}</code>
          <button type="button" on:click={() => generatedCredentials && copyValue('Email', generatedCredentials.email)}>
            <Icon name="content_copy" size={16} />
            {$t('common.copy')}
          </button>
        </div>
        <div class="created-credential-item password-item">
          <span>{$t('common.password')}</span>
          <code>{generatedCredentials.password}</code>
          <button type="button" on:click={() => generatedCredentials && copyValue('Kata sandi', generatedCredentials.password)}>
            <Icon name="content_copy" size={16} />
            {$t('common.copy')}
          </button>
        </div>
        {#if generatedCredentials.outlookForwardingAddress}
          <div class="created-credential-item forwarding-item">
            <span>{$t('user.outlookForwardingAddress')}</span>
            <code>{generatedCredentials.outlookForwardingAddress}</code>
            <button
              type="button"
              on:click={() =>
                generatedCredentials?.outlookForwardingAddress &&
                copyValue($t('user.outlookForwardingAddress'), generatedCredentials.outlookForwardingAddress)}
            >
              <Icon name="content_copy" size={16} />
              {$t('common.copy')}
            </button>
          </div>
        {/if}
      </div>
      {#if routingMessage || copyMessage}
        <p class="text-muted created-credential-feedback">{copyMessage || routingMessage}</p>
      {/if}
      <button class="created-credential-close" type="button" aria-label={$t('user.closeCredential')} on:click={() => (generatedCredentials = null)}>
        <Icon name="close" size={18} />
      </button>
    </div>
  {/if}

  {#if users.length === 0}
    <div class="empty">
      <Icon name="person_off" size={38} />
      <h3>{$t('user.emptyTitle')}</h3>
      <p class="text-muted">{$t('user.emptyCopy')}</p>
    </div>
  {:else}
    <div class="list">
      {#each users as user (user.id)}
        <div class="row">
          <div class="identity-stack">
            <a href={`/users/${user.id}/inbox`} class="identity-link">
              <Avatar initials={user.displayName.slice(0, 2).toUpperCase()} />
              <div>
                <div class="name">{user.displayName}</div>
                <div class="text-muted">{user.email}</div>
                <div class="text-muted identity-metrics">
                  <span>{$t('common.email')}: {formatCount(user.totalEmails)}</span>
                  <span>{$t('dashboard.metric.unread')}: {formatCount(user.unreadEmails)}</span>
                </div>
                {#if user.gptPlusClaimed}
                  <div class="gpt-claim-card" class:deactivated={isGptPlusDeactivated(user)}>
                    <span class="claim-label">{formatGptPlusStatus(user)}</span>
                    <code>{user.email}</code>
                    {#if isGptPlusDeactivated(user)}
                      <small>{$t('user.gptDeactivatedCopy')}</small>
                    {/if}
                  </div>
                {/if}
              </div>
            </a>
            {#if user.initialPassword}
              <div class="initial-password-card">
                <span class="initial-password-label">{$t('user.initialPassword')}</span>
                <code>{user.initialPassword}</code>
                <button type="button" on:click={() => user.initialPassword && handleQuickCopyInitialPassword(user.initialPassword)}>
                  <Icon name="content_copy" size={15} />
                  {$t('user.copyInitialPassword')}
                </button>
              </div>
            {/if}
            {#if user.outlookForwardingAddress}
              <div class="initial-password-card forwarding-card">
                <span class="initial-password-label">{$t('user.outlookForwardingAddress')}</span>
                <code>{user.outlookForwardingAddress}</code>
                <button type="button" on:click={() => user.outlookForwardingAddress && handleQuickCopyOutlookForwarding(user.outlookForwardingAddress)}>
                  <Icon name="content_copy" size={15} />
                  {$t('common.copy')}
                </button>
              </div>
            {/if}
          </div>
          <div class="meta">
            <Badge tone={user.status === 'active' ? 'success' : 'neutral'}>{formatUserStatus(user.status)}</Badge>
            {#if getExternalUserOption(user)}
              <Badge tone="primary">{$t(getExternalUserOption(user)?.badgeKey ?? 'user.externalDomainBadge')}</Badge>
            {/if}
            {#if user.gptPlusClaimed}
              <Badge tone={isGptPlusDeactivated(user) ? 'danger' : 'success'}>{formatGptPlusStatus(user)}</Badge>
            {/if}
            <span class="role">{formatUserRole(user.role)}</span>
            <div class="quick-actions">
              <button class="icon-action" type="button" aria-label={$t('user.copyEmail')} title={$t('user.copyEmail')} on:click={() => handleQuickCopyEmail(user.email)}>
                <Icon name="content_copy" size={16} />
              </button>
              <button
                class="icon-action"
                type="button"
                aria-label={$t('user.resetPassword')}
                title={$t('user.resetPassword')}
                disabled={actionUserId === user.id || user.status !== 'active'}
                on:click={() => handleQuickResetPassword(user)}
              >
                <Icon name="lock_reset" size={16} />
              </button>
              <button
                class="icon-action danger"
                type="button"
                aria-label={$t('user.disable')}
                title={$t('user.disable')}
                disabled={actionUserId === user.id || user.role === 'owner' || user.status !== 'active'}
                on:click={() => handleQuickSoftDelete(user)}
              >
                <Icon name="person_remove" size={16} />
              </button>
            </div>
            <Button href={`/users/${user.id}/edit`} variant="ghost">{$t('user.edit')}</Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</CardSurface>

{#if modalOpen}
      <button class="modal-backdrop" type="button" aria-label={$t('user.closeAddModal')} on:click={closeModal}></button>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-user-title">
    <div class={`modal-card ${generatedCredentials ? 'modal-success' : ''}`}>
      {#if generatedCredentials}
        <div class="top-accent"></div>
      {:else}
        <div class="modal-head">
          <h3 id="add-user-title">{$t('user.addNew')}</h3>
          <p class="text-muted">{$t('user.addModalCopy')}</p>
        </div>
      {/if}

      {#if generatedCredentials}
        <div class="modal-body credentials-pane">
          <div class="success-head">
            <div class="success-icon-wrap">
              <Icon name="check_circle" size={36} />
            </div>
            <h3 class="success-title">{$t('common.done')}</h3>
            {#if credentialContext === 'create'}
              <p class="text-muted success-subtitle">{$t('user.createSuccessCopy')}</p>
            {:else}
              <p class="text-muted success-subtitle">{$t('user.resetSuccessCopy')}</p>
            {/if}
          </div>

          <div class="credential-list">
            <div class="credential-item">
              <span class="credential-label">{$t('common.email')}</span>
              <div class="credential-row">
                <code>{generatedCredentials.email}</code>
                <button
                  class="copy-btn"
                  type="button"
                  on:click={() => generatedCredentials && copyValue('Email', generatedCredentials.email)}
                >
                  <Icon name="content_copy" size={18} />
                </button>
              </div>
            </div>
            {#if credentialContext === 'reset'}
              <div class="credential-item">
                <span class="credential-label">{$t('common.password')}</span>
                <div class="credential-row">
                  <code>{generatedCredentials.password}</code>
                  <button
                    class="copy-btn"
                    type="button"
                    on:click={() => generatedCredentials?.password && copyValue('Kata sandi', generatedCredentials.password)}
                  >
                    <Icon name="content_copy" size={18} />
                  </button>
                </div>
              </div>
            {/if}
            {#if generatedCredentials.outlookForwardingAddress}
              <div class="credential-item">
                <span class="credential-label">{$t('user.outlookForwardingAddress')}</span>
                <div class="credential-row">
                  <code>{generatedCredentials.outlookForwardingAddress}</code>
                  <button
                    class="copy-btn"
                    type="button"
                    on:click={() =>
                      generatedCredentials?.outlookForwardingAddress &&
                      copyValue($t('user.outlookForwardingAddress'), generatedCredentials.outlookForwardingAddress)}
                  >
                    <Icon name="content_copy" size={18} />
                  </button>
                </div>
              </div>
            {/if}
          </div>

          <div class="warning-box">
            <div class="warning-icon">
              <Icon name={credentialContext === 'create' ? 'info' : 'warning'} size={18} />
            </div>
            {#if credentialContext === 'create'}
              <p>
                <strong>{$t('user.savedPasswordNotice')}</strong>
              </p>
            {:else}
              <p>
                <strong>{$t('user.safePasswordNotice')}</strong>
              </p>
            {/if}
          </div>

          {#if routingMessage}
            <div
              class="route-box"
              class:route-warning={routingMessage.includes('gagal') || routingMessage.includes('belum bisa')}
            >
              <div class="warning-icon">
                <Icon name={routingMessage.includes('gagal') || routingMessage.includes('belum bisa') ? 'warning' : 'mark_email_read'} size={18} />
              </div>
              <p>{routingMessage}</p>
            </div>
          {/if}

          {#if copyMessage}
            <p class="text-muted copy-feedback">{copyMessage}</p>
          {/if}

          <div class="modal-footer success-footer">
            <button class="btn-submit signature-bg done-btn" type="button" on:click={closeModal}>{$t('common.done')}</button>
          </div>
        </div>
      {:else}
        <form class="modal-body modal-form" on:submit|preventDefault={handleCreateUser}>
          <div class="field">
            <div class="field-label-row">
              <label for="add-user-username">{$t('user.username')}</label>
              <button class="random-btn" type="button" disabled={isSubmitting || isGeneratingUsername} on:click={generateRandomUsername}>
                <Icon name="casino" size={15} />
                {isGeneratingUsername ? $t('user.addRandomGenerating') : $t('user.addRandom')}
              </button>
            </div>
            <div class="input-shell">
              <InputText id="add-user-username" bind:value={username} placeholder={$t('user.usernamePlaceholder')} required />
              <span class="input-icon">
                <Icon name="alternate_email" size={16} />
              </span>
            </div>
            {#if domainOptions.length > 0}
              <div class="select-shell">
                <div class="select-head">
                  <label for="add-user-domain">{$t('user.domain')}</label>
                  <span class="select-badge">{selectedDomainIsExternal ? $t('user.externalDomainBadge') : $t('user.domainPerUser')}</span>
                </div>
                <select id="add-user-domain" bind:value={selectedDomain}>
                  {#each domainOptions as domain (domain.domain)}
                    <option value={domain.domain}>
                      {domain.label}
                    </option>
                  {/each}
                </select>
                <p class="select-help text-muted">
                  {selectedDomainIsExternal ? $t('user.outlookExternalHelp') : $t('user.domainHelp')}
                </p>
              </div>
            {/if}
            {#if selectedDomain}
            <p class="hint text-muted">{$t('user.previewEmail')} <code>{username.trim().toLowerCase() || 'namauser'}@{selectedDomain}</code></p>
            {/if}
            {#if externalForwardingPreview}
              <p class="hint text-muted">{$t('user.outlookForwardingPreview')} <code>{externalForwardingPreview}</code></p>
              <p class="hint text-muted">{$t('user.outlookForwardingSetupHelp')}</p>
            {/if}
            <p class="hint text-muted">{$t('user.autoCredentialHelp')}</p>
            <p class="hint text-muted">{$t('user.randomHelp')}</p>
          </div>

          {#if errorMessage}
            <p class="error">{errorMessage}</p>
          {/if}

          <div class="modal-footer">
            <button class="btn-cancel" type="button" disabled={isSubmitting} on:click={closeModal}>{$t('common.cancel')}</button>
            <button class="btn-submit signature-bg" type="submit" disabled={isSubmitting}>
              {isSubmitting ? $t('user.addRandomGenerating') : $t('user.add')}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}

<style>
  .panel-header {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    align-items: center;
    margin-bottom: var(--space-5);
  }

  .panel-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
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

  h2 {
    font-size: 1.5rem;
    margin-bottom: 0.25rem;
  }

  .created-credential-card {
    position: relative;
    display: grid;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
    padding: var(--space-4);
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 58%);
    border-radius: var(--radius-md);
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--color-primary-500), transparent 82%), transparent 40%),
      color-mix(in srgb, var(--color-surface-card), var(--color-primary-500) 4%);
    box-shadow: 0 14px 36px rgba(0, 81, 255, 0.14);
  }

  .created-credential-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding-right: 2.25rem;
  }

  .created-credential-head h3 {
    margin: 0 0 0.18rem;
    font-size: 1rem;
  }

  .created-credential-head p {
    margin: 0;
    font-size: 0.84rem;
  }

  .created-credential-icon {
    width: 2.35rem;
    height: 2.35rem;
    border-radius: 0.8rem;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    color: var(--color-primary-500);
    background: color-mix(in srgb, var(--color-primary-500), transparent 84%);
  }

  .created-credential-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .created-credential-item {
    display: grid;
    gap: 0.45rem;
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 65%);
    border-radius: 0.85rem;
    background: color-mix(in srgb, var(--color-surface-low), white 22%);
  }

  .created-credential-item span {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.09em;
    font-size: var(--font-size-label-xs);
    font-weight: 800;
  }

  .created-credential-item button {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 65%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary-500), transparent 88%);
    color: var(--color-primary-500);
    padding: 0.38rem 0.7rem;
    font-family: var(--font-family-headline);
    font-size: 0.72rem;
    font-weight: 800;
    cursor: pointer;
  }

  .created-credential-item.forwarding-item {
    grid-column: 1 / -1;
  }

  .created-credential-feedback {
    margin: 0;
    font-size: 0.8rem;
  }

  .created-credential-close {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 70%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-surface-card), transparent 10%);
    color: var(--color-text-muted);
    cursor: pointer;
  }

  .list {
    display: grid;
    gap: 0.55rem;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 70%);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.85rem;
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 50%);
  }

  .row:hover {
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 65%);
    background: var(--color-surface-card);
  }

  .identity-link {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }

  .identity-stack {
    display: grid;
    gap: 0.55rem;
    min-width: 0;
    flex: 1;
  }

  .name {
    font-weight: 700;
  }

  .identity-metrics {
    margin-top: 0.22rem;
    display: inline-flex;
    gap: 0.8rem;
    font-size: 0.78rem;
  }

  .gpt-claim-card {
    margin-top: 0.55rem;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
    max-width: 48rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--color-success), transparent 72%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-success), transparent 92%);
  }

  .gpt-claim-card.deactivated {
    border-color: color-mix(in srgb, var(--color-danger), transparent 68%);
    background: color-mix(in srgb, var(--color-danger), transparent 92%);
  }

  .claim-label {
    color: var(--color-success);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 800;
  }

  .gpt-claim-card.deactivated .claim-label {
    color: var(--color-danger);
  }

  .gpt-claim-card code {
    font-size: 0.78rem;
  }

  .gpt-claim-card small {
    color: var(--color-text-muted);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .initial-password-card {
    width: fit-content;
    max-width: min(42rem, 100%);
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
    margin-left: 3.2rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 68%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-primary-500), transparent 92%);
  }

  .initial-password-label {
    color: var(--color-primary-500);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 800;
  }

  .initial-password-card code {
    font-size: 0.78rem;
  }

  .initial-password-card button {
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 65%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary-500), transparent 86%);
    color: var(--color-primary-500);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.28rem 0.55rem;
    font-family: var(--font-family-headline);
    font-size: 0.7rem;
    font-weight: 800;
    cursor: pointer;
  }

  .initial-password-card.forwarding-card {
    border-color: color-mix(in srgb, var(--color-success), transparent 68%);
    background: color-mix(in srgb, var(--color-success), transparent 92%);
  }

  .initial-password-card.forwarding-card .initial-password-label,
  .initial-password-card.forwarding-card button,
  .initial-password-card.forwarding-card code {
    color: var(--color-success);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }

  .quick-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .icon-action {
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 55%);
    background: color-mix(in srgb, var(--color-surface-low), white 25%);
    color: var(--color-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .icon-action:hover {
    color: var(--color-primary-500);
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 55%);
  }

  .icon-action.danger:hover {
    color: #bf273f;
    border-color: color-mix(in srgb, #bf273f, transparent 55%);
  }

  .icon-action:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .role {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    color: var(--color-text-muted);
    font-weight: 700;
  }

  .empty {
    min-height: 15rem;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 0.6rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    border: 0;
    background: color-mix(in srgb, var(--color-text), transparent 60%);
    backdrop-filter: blur(2px);
    z-index: 20;
  }

  .modal {
    position: fixed;
    inset: 0;
    z-index: 21;
    display: grid;
    place-items: center;
    padding: var(--space-5);
  }

  .modal-card {
    width: min(28rem, 100%);
    border-radius: 1rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 75%);
    background: var(--color-surface-card);
    box-shadow: var(--shadow-modal);
    overflow: hidden;
  }

  .modal-success {
    width: min(32rem, 100%);
  }

  .top-accent {
    height: 0.38rem;
    width: 100%;
    background: var(--gradient-signature);
  }

  .modal-head {
    padding: var(--space-8) var(--space-8) var(--space-4);
  }

  h3 {
    font-size: 1.55rem;
    margin-bottom: 0.3rem;
    letter-spacing: -0.02em;
  }

  .modal-body {
    padding: var(--space-6) var(--space-8);
  }

  .modal-form {
    display: grid;
    gap: var(--space-4);
  }

  .credentials-pane {
    display: grid;
    gap: var(--space-4);
    padding-top: var(--space-8);
  }

  .success-head {
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 0.45rem;
    margin-bottom: var(--space-2);
  }

  .success-icon-wrap {
    width: 4rem;
    height: 4rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--color-primary-500), white 85%);
    color: var(--color-primary-500);
    display: grid;
    place-items: center;
  }

  .success-title {
    font-size: 2rem;
    line-height: 1.1;
    margin: 0;
  }

  .success-subtitle {
    max-width: 22rem;
    margin: 0;
    font-size: 0.96rem;
  }

  .field {
    display: grid;
    gap: var(--space-2);
  }

  label {
    display: block;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.15em;
    font-size: var(--font-size-label-xs);
    font-weight: 700;
  }

  .field-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .random-btn {
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 65%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary-500), transparent 88%);
    color: var(--color-primary-500);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.65rem;
    font-family: var(--font-family-headline);
    font-size: 0.72rem;
    font-weight: 800;
    cursor: pointer;
  }

  .random-btn:hover {
    background: color-mix(in srgb, var(--color-primary-500), transparent 80%);
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 35%);
  }

  .random-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .input-shell {
    position: relative;
  }

  .select-shell {
    display: grid;
    gap: 0.4rem;
    margin-top: 0.8rem;
  }

  .select-shell select {
    border: 0;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--color-surface-low), white 35%);
    color: var(--color-text);
    padding: 0.9rem 1rem;
    font: inherit;
  }

  .input-icon {
    position: absolute;
    right: var(--space-4);
    top: 50%;
    transform: translateY(-50%);
    color: color-mix(in srgb, var(--color-text-muted), transparent 40%);
    pointer-events: none;
  }

  .input-shell :global(.input) {
    border: 0;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--color-surface-low), white 35%);
    padding-top: 0.9rem;
    padding-bottom: 0.9rem;
    padding-right: 2.5rem;
  }

  .input-shell :global(.input):focus {
    background: var(--color-surface-card);
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-8) var(--space-8);
  }

  .btn-cancel {
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    font-family: var(--font-family-headline);
    font-weight: 800;
    font-size: 0.78rem;
    border-radius: 0.75rem;
    padding: 0.75rem 1.5rem;
    cursor: pointer;
  }

  .btn-cancel:hover {
    background: color-mix(in srgb, var(--color-surface-low), transparent 35%);
  }

  .btn-submit {
    border: 0;
    color: #fff;
    font-family: var(--font-family-headline);
    font-weight: 800;
    font-size: 0.78rem;
    border-radius: 0.75rem;
    padding: 0.75rem 2rem;
    cursor: pointer;
    box-shadow: 0 10px 24px rgba(0, 81, 255, 0.2);
  }

  .btn-submit:disabled,
  .btn-cancel:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .hint {
    margin-top: 0;
    font-size: 0.8rem;
  }

  .credential-list {
    display: grid;
    gap: var(--space-3);
  }

  .credential-item {
    display: grid;
    gap: 0.3rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 60%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-low), white 35%);
    padding: 0.7rem 0.85rem;
  }

  .credential-label {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 700;
  }

  .credential-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  code {
    font-size: 0.85rem;
    font-family: 'Consolas', 'Courier New', monospace;
    color: var(--color-primary-500);
    overflow-wrap: anywhere;
  }

  .copy-btn {
    border: 0;
    background: transparent;
    color: var(--color-primary-500);
    border-radius: 0.5rem;
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .copy-btn:hover {
    background: color-mix(in srgb, var(--color-primary-500), white 88%);
  }

  .warning-box {
    margin-top: var(--space-2);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: color-mix(in srgb, var(--color-warning), white 88%);
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .warning-box p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
    color: color-mix(in srgb, var(--color-warning), #402000 30%);
  }

  .route-box {
    margin-top: var(--space-2);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: color-mix(in srgb, var(--color-success), white 88%);
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .route-box p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
    color: color-mix(in srgb, var(--color-success), #00351c 35%);
  }

  .route-warning {
    background: color-mix(in srgb, var(--color-warning), white 88%);
  }

  .route-warning p {
    color: color-mix(in srgb, var(--color-warning), #402000 30%);
  }

  .warning-icon {
    color: var(--color-warning);
    margin-top: 0.1rem;
  }

  .copy-feedback {
    font-size: 0.8rem;
    margin: 0;
  }

  .success-footer {
    padding-top: var(--space-2);
  }

  .done-btn {
    width: 100%;
    font-size: 1rem;
    padding-top: 0.85rem;
    padding-bottom: 0.85rem;
  }

  .error {
    color: #c1263c;
    font-size: 0.85rem;
  }

  @media (max-width: 960px) {
    .panel-header {
      flex-direction: column;
      align-items: stretch;
      margin-bottom: var(--space-4);
    }

    .panel-actions {
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .row {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-3);
      padding: 0.75rem;
    }

    .identity-link {
      align-items: flex-start;
    }

    .initial-password-card {
      margin-left: 0;
    }

    .identity-metrics {
      flex-wrap: wrap;
      gap: 0.45rem 0.8rem;
    }

    .meta {
      width: 100%;
      flex-wrap: wrap;
      justify-content: space-between;
      row-gap: var(--space-2);
    }

    .quick-actions {
      order: 3;
    }

    .created-credential-grid {
      grid-template-columns: 1fr;
    }

    .modal {
      align-items: end;
      padding: 0;
    }

    .modal-card,
    .modal-success {
      width: 100%;
      border-radius: 1rem 1rem 0 0;
      max-height: 92vh;
      overflow: auto;
    }

    .modal-head,
    .modal-body,
    .modal-footer {
      padding-left: var(--space-4);
      padding-right: var(--space-4);
    }

    .modal-head {
      padding-top: var(--space-5);
    }

    .modal-body {
      padding-bottom: var(--space-4);
    }

    .modal-footer {
      padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
      flex-wrap: wrap;
      justify-content: stretch;
    }

    .modal-footer :global(.btn),
    .btn-submit,
    .btn-cancel {
      width: 100%;
    }

    .credential-row {
      align-items: flex-start;
    }
  }
</style>
