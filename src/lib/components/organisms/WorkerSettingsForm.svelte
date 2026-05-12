<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    MailDomainDto,
    OutlookDnsPlanDto,
    OutlookDnsRecordDto,
    OutlookMailboxResultDto,
    WorkerSettingsDto
  } from '$lib/types/dto';
  import type { WorkerSettingsPageDto } from '$lib/server/services/worker-settings.service';
  import CardSurface from '$lib/components/atoms/CardSurface.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import FieldLabelInput from '$lib/components/molecules/FieldLabelInput.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Checkbox from '$lib/components/atoms/Checkbox.svelte';
  import { t } from '$lib/i18n';
  import { confirmDialog, errorToast, successToast, warningToast } from '$lib/sweet-alert';

  export let data: WorkerSettingsPageDto;

  interface ApiKeyRecordView {
    id: string;
    name: string;
    createdBy: string;
    createdAt: string;
  }

  interface ApiKeyStatusPayload {
    hasActiveKey: boolean;
    activeKey: ApiKeyRecordView | null;
  }

  const PUBLIC_API_PATH = '/api/public/v1';
  const API_SERVICE_OPTIONS = [
    { id: 'flash-mail-flare', label: 'Flash Mail Flare' },
    { id: 'shiromail-compatible', label: 'ShiroMail Compatible' }
  ];

  let settings: WorkerSettingsDto = { ...data.settings };
  let botTokenInput = '';
  let webhookSecretInput = '';
  let saveMessage = '';
  let saveError = '';
  let saving = false;
  let testingConnection = false;
  let connectingWebhook = false;
  let domainsLoading = true;
  let domainSubmitting = false;
  let domainActionTarget = '';
  let domainInput = '';
  let domainSetDefault = false;
  let mailDomains: MailDomainDto[] = [];
  let domainMessage = '';
  let domainError = '';
  let apiKeyLoading = true;
  let apiKeyActionLoading = false;
  let apiKeyStatus: ApiKeyStatusPayload = {
    hasActiveKey: false,
    activeKey: null
  };
  let apiKeyMessage = '';
  let apiKeyError = '';
  let apiKeyPlaintext = '';
  let apiServiceId = API_SERVICE_OPTIONS[0].id;
  let apiSelectedDomain = '';
  let apiServiceRefreshing = false;
  let publicApiBaseUrl = PUBLIC_API_PATH;
  let selectedApiServiceLabel = API_SERVICE_OPTIONS[0].label;
  let apiServiceKeyPreview = '';
  let outlookDomain = '';
  let outlookInitialDomain = '';
  let outlookVerificationTxt = '';
  let outlookIncludeDmarc = true;
  let outlookPlanning = false;
  let outlookPlan: OutlookDnsPlanDto | null = null;
  let outlookError = '';
  let outlookMessage = '';
  let outlookMailboxLocalPart = '';
  let outlookMailboxDisplayName = '';
  let outlookMailboxPassword = '';
  let outlookMailboxSubmitting = false;
  let outlookMailboxResult: OutlookMailboxResultDto | null = null;

  $: if (!outlookDomain && mailDomains.length > 0) {
    outlookDomain = mailDomains.find((domain) => domain.isDefault)?.domain ?? mailDomains[0].domain;
  }
  $: if (mailDomains.length > 0 && (!apiSelectedDomain || !mailDomains.some((domain) => domain.domain === apiSelectedDomain))) {
    apiSelectedDomain = mailDomains.find((domain) => domain.isDefault)?.domain ?? mailDomains[0].domain;
  }
  $: selectedApiServiceLabel = API_SERVICE_OPTIONS.find((service) => service.id === apiServiceId)?.label ?? API_SERVICE_OPTIONS[0].label;
  $: apiServiceKeyPreview = apiKeyPlaintext || (apiKeyStatus.hasActiveKey ? $t('worker.apiServiceKeyHidden') : $t('worker.apiServiceKeyMissing'));
  $: outlookMailboxEmail =
    outlookMailboxLocalPart.trim() && outlookDomain
      ? `${outlookMailboxLocalPart.trim().toLowerCase().replace(/^@+/, '')}@${outlookDomain}`
      : '';

  function formatStatus(value: string): string {
    const normalized = value.trim().toLowerCase();
    const labels: Record<string, string> = {
      active: 'aktif',
      pending: 'menunggu nameserver',
      moved: 'dipindahkan',
      deleted: 'dihapus',
      unknown: 'tidak diketahui',
      unconfigured: 'belum dikonfigurasi',
      configured: 'terkonfigurasi',
      misconfigured: 'perlu diperbaiki',
      'misconfigured/locked': 'perlu dibuka',
      unlocked: 'terbuka',
      locked: 'terkunci',
      error: 'gagal'
    };

    return labels[normalized] ?? (normalized || '-');
  }

  function formatBotStatus(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'configured' || normalized === 'terkonfigurasi') {
      return 'Terkonfigurasi';
    }
    if (normalized === 'missing token' || normalized === 'token belum ada') {
      return 'Token belum ada';
    }
    return value || '-';
  }

  async function copyTextValue(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      void successToast($t('common.copySucceededTitle'), $t('common.copiedValue', { label }));
    } catch {
      void errorToast($t('common.copyFailedTitle'), $t('common.copyFailed'));
    }
  }

  function buildApiServiceConfig(): Record<string, unknown> {
    return {
      service: apiServiceId,
      serviceLabel: selectedApiServiceLabel,
      urlApi: publicApiBaseUrl,
      domain: apiSelectedDomain,
      apiKey: apiKeyPlaintext || '<paste-cmf_v1-api-key>',
      authHeader: 'x-api-key',
      refreshDomainEndpoint: `${publicApiBaseUrl}/domains`,
      endpoints: {
        createUser: `${publicApiBaseUrl}/create_user`,
        listUser: `${publicApiBaseUrl}/list_user`,
        userMailbox: `${publicApiBaseUrl}/user_mailbox`,
        readEmail: `${publicApiBaseUrl}/read_email`,
        domains: `${publicApiBaseUrl}/domains`
      }
    };
  }

  async function copyApiServiceConfig(): Promise<void> {
    await copyTextValue(JSON.stringify(buildApiServiceConfig(), null, 2), $t('worker.apiServiceConfig'));
  }

  async function copyApiServiceCurl(): Promise<void> {
    const apiKey = apiKeyPlaintext || '<paste-cmf_v1-api-key>';
    const command = `curl "${publicApiBaseUrl}/domains" -H "x-api-key: ${apiKey}"`;
    await copyTextValue(command, $t('worker.apiServiceCurl'));
  }

  async function refreshApiServiceConfig(): Promise<void> {
    if (apiServiceRefreshing) {
      return;
    }

    apiServiceRefreshing = true;
    try {
      await Promise.all([loadApiKeyStatus(), loadMailDomains()]);
      if (apiKeyError || domainError) {
        return;
      }
      void successToast($t('worker.apiServiceRefreshDoneTitle'), $t('worker.apiServiceRefreshDone'));
    } finally {
      apiServiceRefreshing = false;
    }
  }

  onMount(() => {
    publicApiBaseUrl = `${window.location.origin}${PUBLIC_API_PATH}`;
    void loadApiKeyStatus();
    void loadMailDomains();
  });

  async function saveSettings(): Promise<void> {
    saving = true;
    saveMessage = '';
    saveError = '';

    try {
      const response = await fetch('/api/worker-settings', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          ...(botTokenInput.trim() ? { botToken: botTokenInput.trim() } : {}),
          ...(webhookSecretInput.trim() ? { webhookSecret: webhookSecretInput.trim() } : {}),
          allowedIds: settings.allowedIds.trim(),
          forwardInbound: settings.forwardInbound,
          targetMode: settings.targetMode.trim(),
          defaultChatId: settings.defaultChatId.trim(),
          testChatId: settings.testChatId.trim()
        })
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: WorkerSettingsPageDto;
          }
        | null;
      if (!response.ok || !payload?.ok || !payload.payload) {
        throw new Error(payload?.error ?? 'Gagal menyimpan pengaturan');
      }

      settings = { ...payload.payload.settings };
      data = payload.payload;
      botTokenInput = '';
      webhookSecretInput = '';
      saveMessage = $t('worker.configSaved');
      void successToast($t('common.done'), saveMessage);
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Gagal menyimpan pengaturan';
      void errorToast($t('user.noticeActionFailed'), saveError);
    } finally {
      saving = false;
    }
  }

  async function testConnection(): Promise<void> {
    if (testingConnection) {
      return;
    }

    testingConnection = true;
    saveMessage = '';
    saveError = '';

    try {
      const response = await fetch('/api/worker-settings/test-telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        }
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              message?: string;
              targetChatId?: string;
              webhook?: WorkerSettingsPageDto['webhook'] | null;
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload) {
        throw new Error(payload?.error ?? 'Gagal mengirim tes koneksi');
      }

      if (payload.payload.webhook) {
        data = {
          ...data,
          webhook: {
            ...data.webhook,
            ...payload.payload.webhook
          }
        };
      }

      const syntheticEmailId = `test-notify-${Date.now()}`;
      const notifyResponse = await fetch('/api/telegram/notify-email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          emailId: syntheticEmailId,
          sender: 'worker-settings-test@mailflare.local',
          recipient: 'admin@mailflare.local',
          subject: '[TES] notify-email dari pengaturan worker',
          skipPersist: true,
          snippet:
            'Notifikasi email masuk sintetis dari tombol tes Pengaturan Worker. Aksi inline seharusnya muncul di Telegram.'
        })
      });

      const notifyPayload = (await notifyResponse.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            sentTo?: number;
          }
        | null;
      if (!notifyResponse.ok || !notifyPayload?.ok) {
        throw new Error(notifyPayload?.error ?? 'Gagal mengirim tes notify-email');
      }

      saveMessage = `${payload.payload.message ?? $t('worker.telegramTestSent')}${payload.payload.targetChatId ? ` (${payload.payload.targetChatId})` : ''}. Endpoint notify-email terkirim ke ${notifyPayload.sentTo ?? 0} chat, ID email=${syntheticEmailId}`;
      void successToast($t('worker.telegramTestSent'), saveMessage);
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Gagal mengirim tes koneksi';
      void errorToast($t('user.noticeActionFailed'), saveError);
    } finally {
      testingConnection = false;
    }
  }

  async function connectWebhook(): Promise<void> {
    if (connectingWebhook) {
      return;
    }

    connectingWebhook = true;
    saveMessage = '';
    saveError = '';

    try {
      const response = await fetch('/api/worker-settings/connect-webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        }
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              message?: string;
              webhook?: WorkerSettingsPageDto['webhook'] | null;
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload) {
        throw new Error(payload?.error ?? 'Gagal menghubungkan webhook');
      }

      if (payload.payload.webhook) {
        data = {
          ...data,
          webhook: {
            ...data.webhook,
            ...payload.payload.webhook
          }
        };
      }

      saveMessage = payload.payload.message ?? $t('worker.webhookConnected');
      void successToast($t('worker.webhookConnected'), saveMessage);
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Gagal menghubungkan webhook';
      void errorToast($t('user.noticeActionFailed'), saveError);
    } finally {
      connectingWebhook = false;
    }
  }

  async function loadApiKeyStatus(): Promise<void> {
    apiKeyLoading = true;
    apiKeyError = '';

    try {
      const response = await fetch('/api/worker-settings/api-key', {
        method: 'GET',
        headers: {
          'content-type': 'application/json'
        }
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: ApiKeyStatusPayload;
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload) {
        throw new Error(payload?.error ?? $t('worker.apiStatusError'));
      }

      apiKeyStatus = payload.payload;
    } catch (error) {
      apiKeyError = error instanceof Error ? error.message : $t('worker.apiStatusError');
      void errorToast($t('worker.apiStatusError'), apiKeyError);
    } finally {
      apiKeyLoading = false;
    }
  }

  async function generateApiKey(regenerate: boolean): Promise<void> {
    if (apiKeyActionLoading) {
      return;
    }

    apiKeyActionLoading = true;
    apiKeyMessage = '';
    apiKeyError = '';
    apiKeyPlaintext = '';

    try {
      const response = await fetch(regenerate ? '/api/worker-settings/api-key/regenerate' : '/api/worker-settings/api-key/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        }
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              apiKey?: string;
              activeKey?: ApiKeyRecordView;
              hasActiveKey?: boolean;
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.apiKey || !payload.payload.activeKey) {
        const errorMessage = payload?.error ?? (response.status === 409 ? $t('worker.apiExisting') : $t('worker.apiCreateError'));
        throw new Error(errorMessage);
      }

      apiKeyPlaintext = payload.payload.apiKey;
      apiKeyStatus = {
        hasActiveKey: true,
        activeKey: payload.payload.activeKey
      };
      apiKeyMessage = regenerate ? $t('worker.apiRegenerated') : $t('worker.apiCreated');
      void successToast(regenerate ? $t('worker.apiRegenerate') : $t('worker.apiCreate'), apiKeyMessage);
    } catch (error) {
      apiKeyError = error instanceof Error ? error.message : $t('worker.apiCreateError');
      void errorToast($t('worker.apiCreateError'), apiKeyError);
      await loadApiKeyStatus();
    } finally {
      apiKeyActionLoading = false;
    }
  }

  async function loadMailDomains(): Promise<void> {
    domainsLoading = true;
    domainError = '';

    try {
      const response = await fetch('/api/mail-domains', {
        method: 'GET',
        headers: {
          'content-type': 'application/json'
        }
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              domains?: MailDomainDto[];
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.domains) {
        throw new Error(payload?.error ?? 'Gagal memuat domain kotak masuk');
      }

      mailDomains = payload.payload.domains;
      if (!domainInput) {
        domainSetDefault = mailDomains.length === 0;
      }
    } catch (error) {
      domainError = error instanceof Error ? error.message : 'Gagal memuat domain kotak masuk';
      void errorToast($t('user.noticeActionFailed'), domainError);
    } finally {
      domainsLoading = false;
    }
  }

  async function addMailDomain(): Promise<void> {
    if (domainSubmitting) {
      return;
    }

    domainSubmitting = true;
    domainMessage = '';
    domainError = '';

    try {
      const response = await fetch('/api/mail-domains', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          domain: domainInput.trim(),
          setDefault: domainSetDefault,
          setupCloudflare: true
        })
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              domains?: MailDomainDto[];
              setup?: {
                message?: string;
                nameservers?: string[];
                zoneStatus?: string;
              };
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.domains) {
        throw new Error(payload?.error ?? 'Gagal menambahkan domain kotak masuk');
      }

      mailDomains = payload.payload.domains;
      const nameservers = payload.payload.setup?.nameservers?.join(', ') ?? '';
      domainMessage = payload.payload.setup?.message
        ? `${payload.payload.setup.message}${nameservers ? ` Nameserver: ${nameservers}` : ''}`
        : $t('worker.domainSaved');
      void successToast($t('worker.domainSaved'), domainMessage);
      domainInput = '';
      domainSetDefault = false;
    } catch (error) {
      domainError = error instanceof Error ? error.message : 'Gagal menambahkan domain kotak masuk';
      void errorToast($t('user.noticeActionFailed'), domainError);
    } finally {
      domainSubmitting = false;
    }
  }

  async function runDomainAction(domain: string, action: 'set-default' | 'sync-cloudflare'): Promise<void> {
    if (domainSubmitting || domainActionTarget) {
      return;
    }

    domainActionTarget = `${action}:${domain}`;
    domainMessage = '';
    domainError = '';

    try {
      const response = await fetch(`/api/mail-domains/${encodeURIComponent(domain)}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ action })
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              domains?: MailDomainDto[];
              setup?: {
                message?: string;
                nameservers?: string[];
              };
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.domains) {
        throw new Error(payload?.error ?? 'Gagal memperbarui domain kotak masuk');
      }

      mailDomains = payload.payload.domains;
      domainMessage =
        action === 'set-default'
          ? $t('worker.domainDefaultChanged', { domain })
          : payload.payload.setup?.message || $t('worker.domainSyncDone', { domain });
      void successToast(action === 'set-default' ? $t('worker.defaultLabel') : $t('worker.domainSyncDone', { domain }), domainMessage);
    } catch (error) {
      domainError = error instanceof Error ? error.message : 'Gagal memperbarui domain kotak masuk';
      void errorToast($t('user.noticeActionFailed'), domainError);
    } finally {
      domainActionTarget = '';
    }
  }

  async function removeDomain(domain: string): Promise<void> {
    if (domainSubmitting || domainActionTarget) {
      return;
    }

    const confirmed = await confirmDialog({
      title: $t('common.delete'),
      text: $t('worker.domainDeleteConfirm', { domain }),
      icon: 'warning',
      detailLabel: $t('common.domain'),
      detailValue: domain,
      confirmButtonText: $t('common.delete'),
      cancelButtonText: $t('common.cancel'),
      danger: true
    });
    if (!confirmed) {
      return;
    }

    domainActionTarget = `delete:${domain}`;
    domainMessage = '';
    domainError = '';

    try {
      const response = await fetch(`/api/mail-domains/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json'
        }
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              domains?: MailDomainDto[];
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.domains) {
        throw new Error(payload?.error ?? 'Gagal menghapus domain kotak masuk');
      }

      mailDomains = payload.payload.domains;
      domainMessage = $t('worker.domainDeleted', { domain });
      void warningToast($t('worker.domainDeleted', { domain }), domainMessage);
    } catch (error) {
      domainError = error instanceof Error ? error.message : 'Gagal menghapus domain kotak masuk';
      void errorToast($t('user.noticeActionFailed'), domainError);
    } finally {
      domainActionTarget = '';
    }
  }

  async function buildOutlookPlan(): Promise<void> {
    if (outlookPlanning) {
      return;
    }

    outlookPlanning = true;
    outlookError = '';
    outlookMessage = '';

    try {
      const response = await fetch('/api/outlook/dns-plan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          domain: outlookDomain,
          initialDomain: outlookInitialDomain,
          verificationTxt: outlookVerificationTxt,
          includeDmarc: outlookIncludeDmarc
        })
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              plan?: OutlookDnsPlanDto;
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.plan) {
        throw new Error(payload?.error ?? $t('worker.outlookPlanFailed'));
      }

      outlookPlan = payload.payload.plan;
      if (!outlookInitialDomain && outlookPlan.initialDomain) {
        outlookInitialDomain = outlookPlan.initialDomain;
      }
      outlookMessage = $t('worker.outlookPlanReady', { domain: outlookPlan.domain });
      void successToast($t('worker.outlookHeading'), outlookMessage);
    } catch (error) {
      outlookPlan = null;
      outlookError = error instanceof Error ? error.message : $t('worker.outlookPlanFailed');
      void errorToast($t('user.noticeActionFailed'), outlookError);
    } finally {
      outlookPlanning = false;
    }
  }

  async function copyOutlookRecord(record: OutlookDnsRecordDto): Promise<void> {
    const priority = record.priority !== undefined ? ` priority=${record.priority}` : '';
    const value = `${record.type} ${record.name} -> ${record.value}${priority}`;
    await copyTextValue(value, record.type);
  }

  async function createOutlookMailbox(): Promise<void> {
    if (outlookMailboxSubmitting || !outlookMailboxEmail) {
      return;
    }

    const confirmed = await confirmDialog({
      title: $t('worker.outlookCreateMailbox'),
      text: $t('worker.outlookCreateConfirm'),
      icon: 'warning',
      detailLabel: $t('common.email'),
      detailValue: outlookMailboxEmail,
      note: $t('worker.outlookCreateWarning'),
      confirmButtonText: $t('worker.outlookCreateMailbox'),
      cancelButtonText: $t('common.cancel')
    });
    if (!confirmed) {
      return;
    }

    outlookMailboxSubmitting = true;
    outlookError = '';
    outlookMessage = '';
    outlookMailboxResult = null;

    try {
      const response = await fetch('/api/outlook/mailboxes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: outlookMailboxEmail,
          displayName: outlookMailboxDisplayName,
          password: outlookMailboxPassword
        })
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            payload?: {
              mailbox?: OutlookMailboxResultDto;
            };
          }
        | null;

      if (!response.ok || !payload?.ok || !payload.payload?.mailbox) {
        throw new Error(payload?.error ?? $t('worker.outlookCreateFailed'));
      }

      outlookMailboxResult = payload.payload.mailbox;
      outlookMessage = payload.payload.mailbox.message;
      outlookMailboxLocalPart = '';
      outlookMailboxDisplayName = '';
      outlookMailboxPassword = '';
      void successToast($t('worker.outlookCreateSuccess'), outlookMessage);
    } catch (error) {
      outlookError = error instanceof Error ? error.message : $t('worker.outlookCreateFailed');
      void errorToast($t('user.noticeActionFailed'), outlookError);
    } finally {
      outlookMailboxSubmitting = false;
    }
  }
</script>

<div class="wrap">
  <CardSurface>
    <h2>{$t('worker.heading')}</h2>
    <p class="text-muted">{$t('worker.telegramCopy')}</p>
    <form class="fields" on:submit|preventDefault={saveSettings}>
      <FieldLabelInput label={$t('worker.botStatus')} value={formatBotStatus(settings.botStatus)} readonly />
      <FieldLabelInput
        label={$t('worker.botToken')}
        bind:value={botTokenInput}
        placeholder={settings.botTokenConfigured ? $t('worker.settingAlreadySet') : $t('worker.botTokenPaste')}
        type="password"
      />
      <FieldLabelInput
        label={$t('worker.secret')}
        bind:value={webhookSecretInput}
        placeholder={settings.webhookSecretConfigured ? $t('worker.settingAlreadySet') : $t('worker.secretPaste')}
        type="password"
      />
      <FieldLabelInput label={$t('worker.telegramAllowedIds')} bind:value={settings.allowedIds} />
      <FieldLabelInput label={$t('worker.targetMode')} bind:value={settings.targetMode} />
      <label class="toggle">
        <Checkbox bind:checked={settings.forwardInbound} />
        <span>{$t('worker.forwardInbound')}</span>
      </label>
      <FieldLabelInput label={$t('worker.chatDefault')} bind:value={settings.defaultChatId} placeholder={$t('worker.chatFallback')} />
      <FieldLabelInput label={$t('worker.chatTest')} bind:value={settings.testChatId} placeholder={$t('worker.chatTestTarget')} />
      <div class="actions">
        <Button type="submit" disabled={saving}>{saving ? $t('common.saving') : $t('worker.saveTelegram')}</Button>
        <Button type="button" variant="secondary" on:click={testConnection} disabled={testingConnection}>
          {testingConnection ? $t('worker.testing') : $t('worker.testConnection')}
        </Button>
      </div>
      {#if saveMessage}
        <p class="feedback success">{saveMessage}</p>
      {/if}
      {#if saveError}
        <p class="feedback error">{saveError}</p>
      {/if}
    </form>
  </CardSurface>

  <CardSurface>
    <h2>{$t('worker.statusWebhook')}</h2>
    <div class="webhook-grid">
      <div>
        <div class="label">{$t('worker.pendingUpdates')}</div>
        <div class="value">{data.webhook.pendingUpdates}</div>
      </div>
      <div>
        <div class="label">{$t('worker.ipAddress')}</div>
        <div class="value">{data.webhook.ipAddress}</div>
      </div>
      <div>
        <div class="label">{$t('worker.maxConnections')}</div>
        <div class="value">{data.webhook.maxConnections}</div>
      </div>
      <div>
        <div class="label">{$t('worker.updateAllowed')}</div>
        <div class="value">{data.webhook.allowedUpdates.join(', ')}</div>
      </div>
    </div>
    <div class="url">
        <div class="label">{$t('worker.webhookUrl')}</div>
      <code>{data.webhook.url}</code>
    </div>
    {#if data.webhook.lastErrorMessage}
      <p class="feedback error">{$t('worker.telegramLastError')}: {data.webhook.lastErrorMessage}</p>
      {#if data.webhook.lastErrorAt}
        <p class="feedback error">Waktu: {data.webhook.lastErrorAt}</p>
      {/if}
    {/if}
    <div class="footer">
      {#if data.webhook.connected}
        <Badge tone="success">Terhubung ({data.webhook.source})</Badge>
      {:else}
        <Button type="button" on:click={connectWebhook} disabled={connectingWebhook || saving || testingConnection}>
          {connectingWebhook ? 'Menghubungkan...' : $t('worker.connectWebhook')}
        </Button>
      {/if}
    </div>
  </CardSurface>

  <CardSurface>
    <h2>{$t('worker.domainHeading')}</h2>
    <p class="text-muted">{$t('worker.domainText')}</p>
    <p class="helper-copy text-muted">{$t('worker.domainHelp')}</p>

    <form class="fields" on:submit|preventDefault={addMailDomain}>
      <FieldLabelInput label={$t('worker.domainNew')} bind:value={domainInput} placeholder={$t('worker.domainPlaceholder')} />
      <label class="toggle">
        <Checkbox bind:checked={domainSetDefault} />
        <span>{$t('worker.defaultDomain')}</span>
      </label>
      <div class="actions">
        <Button type="submit" disabled={domainSubmitting || !domainInput.trim()}>
          {domainSubmitting ? 'Menambahkan...' : $t('worker.domainAdd')}
        </Button>
        <Button type="button" variant="secondary" on:click={loadMailDomains} disabled={domainsLoading || domainSubmitting}>
          {domainsLoading ? $t('common.loading') : 'Segarkan Domain'}
        </Button>
      </div>
      {#if domainMessage}
        <p class="feedback success">{domainMessage}</p>
      {/if}
      {#if domainError}
        <p class="feedback error">{domainError}</p>
      {/if}
    </form>

    <div class="domain-list">
      {#if domainsLoading && mailDomains.length === 0}
        <p class="feedback">{$t('worker.domainLoading')}</p>
      {:else if mailDomains.length === 0}
        <p class="feedback">{$t('worker.domainEmpty')}</p>
      {:else}
        {#each mailDomains as domain (domain.domain)}
          <div class="domain-row">
            <div class="domain-meta">
              <div class="domain-head">
                <strong>{domain.domain}</strong>
                {#if domain.isDefault}
                  <Badge tone="success">{$t('worker.defaultLabel')}</Badge>
                {/if}
              </div>
              <div class="domain-details">
                <span>Zone: {domain.zoneId || '-'}</span>
                <span>Status: {formatStatus(domain.status)}</span>
                <span>Email Routing: {formatStatus(domain.emailRoutingStatus)}</span>
              </div>
              {#if domain.nameservers.length > 0}
                <div class="domain-nameservers">
                  <span class="label">{$t('worker.nameserver')}</span>
                  <code>{domain.nameservers.join(', ')}</code>
                </div>
              {/if}
              {#if domain.lastSetupMessage}
                <p class="feedback">{domain.lastSetupMessage}</p>
              {/if}
            </div>
            <div class="domain-actions">
              {#if !domain.isDefault}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={domainActionTarget !== '' || domainSubmitting}
                  on:click={() => runDomainAction(domain.domain, 'set-default')}
                >
                  {domainActionTarget === `set-default:${domain.domain}` ? 'Menyimpan...' : 'Jadikan Bawaan'}
                </Button>
              {/if}
              <Button
                type="button"
                variant="secondary"
                disabled={domainActionTarget !== '' || domainSubmitting}
                on:click={() => runDomainAction(domain.domain, 'sync-cloudflare')}
              >
                {domainActionTarget === `sync-cloudflare:${domain.domain}` ? 'Menyinkronkan...' : 'Sinkronkan Cloudflare'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={domainActionTarget !== '' || domainSubmitting || mailDomains.length <= 1}
                on:click={() => removeDomain(domain.domain)}
              >
                {domainActionTarget === `delete:${domain.domain}` ? 'Menghapus...' : 'Hapus'}
              </Button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </CardSurface>

  <CardSurface>
    <h2>{$t('worker.outlookHeading')}</h2>
    <p class="text-muted">{$t('worker.outlookText')}</p>
    <div class="outlook-alert">
      <strong>{$t('worker.outlookConflictTitle')}</strong>
      <span>{$t('worker.outlookConflictCopy')}</span>
    </div>

    <form class="fields" on:submit|preventDefault={buildOutlookPlan}>
      <div class="field">
        <label for="outlook-domain">{$t('worker.outlookDomain')}</label>
        <select id="outlook-domain" bind:value={outlookDomain} disabled={mailDomains.length === 0}>
          {#if mailDomains.length === 0}
            <option value="">{$t('worker.domainEmpty')}</option>
          {:else}
            {#each mailDomains as domain (domain.domain)}
              <option value={domain.domain}>{domain.domain}{domain.isDefault ? ` - ${$t('worker.defaultLabel')}` : ''}</option>
            {/each}
          {/if}
        </select>
      </div>
      <FieldLabelInput
        label={$t('worker.outlookInitialDomain')}
        bind:value={outlookInitialDomain}
        placeholder={$t('worker.outlookInitialDomainPlaceholder')}
      />
      <FieldLabelInput
        label={$t('worker.outlookVerificationTxt')}
        bind:value={outlookVerificationTxt}
        placeholder="MS=ms12345678"
      />
      <label class="toggle">
        <Checkbox bind:checked={outlookIncludeDmarc} />
        <span>{$t('worker.outlookIncludeDmarc')}</span>
      </label>
      <div class="actions">
        <Button type="submit" disabled={outlookPlanning || !outlookDomain}>
          {outlookPlanning ? $t('common.loading') : $t('worker.outlookBuildPlan')}
        </Button>
        <Button type="button" variant="secondary" on:click={() => (outlookPlan = null)} disabled={outlookPlanning || !outlookPlan}>
          {$t('common.close')}
        </Button>
      </div>
      {#if outlookMessage}
        <p class="feedback success">{outlookMessage}</p>
      {/if}
      {#if outlookError}
        <p class="feedback error">{outlookError}</p>
      {/if}
    </form>

    {#if outlookPlan}
      <div class="outlook-plan">
        <div class="outlook-plan-head">
          <div>
            <div class="label">{$t('worker.outlookMxTarget')}</div>
            <code>{outlookPlan.mxTarget}</code>
          </div>
          <Badge tone={outlookPlan.graphConfigured ? 'success' : 'warning'}>
            {outlookPlan.graphConfigured ? $t('worker.outlookGraphReady') : $t('worker.outlookGraphMissing')}
          </Badge>
        </div>

        <div class="outlook-warning-list">
          {#each outlookPlan.warnings as warning}
            <p>{warning}</p>
          {/each}
        </div>

        <div class="record-list">
          {#each outlookPlan.records as record}
            <div class="record-row" class:record-danger={record.conflictsWithCloudflareRouting}>
              <div class="record-type">
                <Badge tone={record.conflictsWithCloudflareRouting ? 'danger' : record.required ? 'primary' : 'neutral'}>
                  {record.type}
                </Badge>
                {#if record.priority !== undefined}
                  <span>prio {record.priority}</span>
                {/if}
              </div>
              <div class="record-main">
                <div class="record-value">
                  <span>{record.name}</span>
                  <code>{record.value}</code>
                </div>
                <p>{record.purpose}</p>
                <small>{record.note}</small>
              </div>
              <Button type="button" variant="ghost" on:click={() => copyOutlookRecord(record)}>
                {$t('common.copy')}
              </Button>
            </div>
          {/each}
        </div>

        <div class="next-steps">
          <div class="label">{$t('worker.outlookNextSteps')}</div>
          {#each outlookPlan.nextSteps as step}
            <p>{step}</p>
          {/each}
        </div>
      </div>
    {/if}

    <div class="outlook-mailbox">
      <div>
        <h3>{$t('worker.outlookMailboxHeading')}</h3>
        <p class="text-muted">{$t('worker.outlookMailboxText')}</p>
      </div>
      <form class="fields" on:submit|preventDefault={createOutlookMailbox}>
        <FieldLabelInput
          label={$t('user.username')}
          bind:value={outlookMailboxLocalPart}
          placeholder={$t('user.usernamePlaceholder')}
        />
        <FieldLabelInput
          label={$t('user.displayName')}
          bind:value={outlookMailboxDisplayName}
          placeholder="John Doe"
        />
        <FieldLabelInput
          label={$t('worker.outlookInitialPassword')}
          bind:value={outlookMailboxPassword}
          placeholder={$t('worker.outlookPasswordPlaceholder')}
          type="password"
        />
        {#if outlookMailboxEmail}
          <div class="outlook-preview">
            <span>{$t('user.previewEmail')}</span>
            <code>{outlookMailboxEmail}</code>
          </div>
        {/if}
        <Button type="submit" disabled={outlookMailboxSubmitting || !outlookMailboxEmail}>
          {outlookMailboxSubmitting ? $t('common.loading') : $t('worker.outlookCreateMailbox')}
        </Button>
      </form>

      {#if outlookMailboxResult}
        <div class="api-key-box">
          <div class="label">{$t('worker.outlookCreatedCredential')}</div>
          <code>{outlookMailboxResult.email}</code>
          <code>{outlookMailboxResult.initialPassword}</code>
          <p class="feedback error">{$t('user.safePasswordNotice')}</p>
        </div>
      {/if}
    </div>
  </CardSurface>

  <CardSurface>
    <h2>{$t('worker.apiHeading')}</h2>
    <p class="text-muted">{$t('worker.apiDescription')} <code class="inline-code">cmf_v1_</code>.</p>
    <div class="api-service-panel">
      <div class="api-service-head">
        <div>
          <h3>{$t('worker.apiServiceHeading')}</h3>
          <p class="text-muted">{$t('worker.apiServiceDescription')}</p>
        </div>
        <Badge tone={apiKeyStatus.hasActiveKey ? 'success' : 'warning'}>
          {apiKeyStatus.hasActiveKey ? $t('worker.apiActive') : $t('worker.apiMissing')}
        </Badge>
      </div>

      <div class="api-service-row">
        <div class="field">
          <label for="api-service">{$t('worker.apiService')}</label>
          <select id="api-service" bind:value={apiServiceId}>
            {#each API_SERVICE_OPTIONS as service}
              <option value={service.id}>{service.label}</option>
            {/each}
          </select>
        </div>
        <span class="api-service-hint">{$t('worker.apiServiceChangedHint')}</span>
      </div>

      <div class="api-service-grid">
        <div class="api-service-copy-field">
          <FieldLabelInput label={$t('worker.apiServiceUrl')} value={publicApiBaseUrl} readonly />
          <Button type="button" variant="ghost" on:click={() => copyTextValue(publicApiBaseUrl, $t('worker.apiServiceUrl'))}>
            {$t('common.copy')}
          </Button>
        </div>

        <div class="api-service-copy-field">
          <div class="field">
            <label for="api-service-domain">{$t('common.domain')}</label>
            <select id="api-service-domain" bind:value={apiSelectedDomain} disabled={mailDomains.length === 0}>
              {#if mailDomains.length === 0}
                <option value="">{$t('worker.apiServiceDomainEmpty')}</option>
              {:else}
                {#each mailDomains as domain (domain.domain)}
                  <option value={domain.domain}>{domain.domain}{domain.isDefault ? ` - ${$t('worker.defaultLabel')}` : ''}</option>
                {/each}
              {/if}
            </select>
          </div>
          <Button type="button" variant="secondary" on:click={refreshApiServiceConfig} disabled={apiServiceRefreshing || domainsLoading || apiKeyLoading}>
            {apiServiceRefreshing ? $t('common.refreshing') : $t('worker.apiServiceDomainRefresh')}
          </Button>
        </div>

        <div class="api-service-copy-field api-service-copy-field-wide">
          <FieldLabelInput label={$t('worker.apiServiceApiKey')} value={apiServiceKeyPreview} readonly />
          <Button
            type="button"
            variant="ghost"
            on:click={() => apiKeyPlaintext && copyTextValue(apiKeyPlaintext, $t('worker.apiServiceApiKey'))}
            disabled={!apiKeyPlaintext}
          >
            {$t('common.copy')}
          </Button>
        </div>
      </div>

      <div class="api-service-endpoints">
        <div class="label">{$t('worker.apiServiceEndpointHelp')}</div>
        <code>{publicApiBaseUrl}/domains</code>
        <code>{publicApiBaseUrl}/create_user</code>
        <code>{publicApiBaseUrl}/user_mailbox</code>
      </div>

      <div class="actions">
        <Button type="button" on:click={copyApiServiceConfig} disabled={!apiSelectedDomain}>
          {$t('worker.apiServiceCopyConfig')}
        </Button>
        <Button type="button" variant="secondary" on:click={copyApiServiceCurl}>
          {$t('worker.apiServiceCopyCurl')}
        </Button>
      </div>
    </div>
    {#if apiKeyLoading}
      <p class="feedback">{$t('worker.apiLoading')}</p>
    {:else}
      <div class="api-key-status">
        {#if apiKeyStatus.hasActiveKey}
          <Badge tone="success">{$t('worker.apiActive')}</Badge>
          {#if apiKeyStatus.activeKey}
            <p class="value"><strong>{$t('worker.createdBy')}:</strong> {apiKeyStatus.activeKey.createdBy || '-'}</p>
            <p class="value"><strong>{$t('worker.createdAt')}:</strong> {apiKeyStatus.activeKey.createdAt || '-'}</p>
          {/if}
        {:else}
          <Badge tone="warning">{$t('worker.apiMissing')}</Badge>
        {/if}
      </div>
      <div class="actions">
        {#if apiKeyStatus.hasActiveKey}
          <Button type="button" on:click={() => generateApiKey(true)} disabled={apiKeyActionLoading}>
            {apiKeyActionLoading ? 'Membuat ulang...' : $t('worker.apiRegenerate')}
          </Button>
        {:else}
          <Button type="button" on:click={() => generateApiKey(false)} disabled={apiKeyActionLoading}>
            {apiKeyActionLoading ? 'Membuat...' : $t('worker.apiCreate')}
          </Button>
        {/if}
        <Button type="button" variant="secondary" on:click={loadApiKeyStatus} disabled={apiKeyLoading || apiKeyActionLoading}>
          {$t('common.refresh')} {$t('common.status')}
        </Button>
      </div>
      {#if apiKeyPlaintext}
        <div class="api-key-box">
          <div class="label">{$t('worker.apiIssuedOnce')}</div>
          <code>{apiKeyPlaintext}</code>
          <p class="feedback error">{$t('worker.apiSaveNow')}</p>
        </div>
      {/if}
      {#if apiKeyMessage}
        <p class="feedback success">{apiKeyMessage}</p>
      {/if}
      {#if apiKeyError}
        <p class="feedback error">{apiKeyError}</p>
      {/if}
    {/if}
  </CardSurface>
</div>

<style>
  .wrap {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: var(--space-5);
  }

  h2 {
    font-size: 1.2rem;
    margin-bottom: 0.2rem;
  }

  .fields {
    margin-top: var(--space-4);
    display: grid;
    gap: var(--space-3);
  }

  .field {
    display: grid;
    gap: 0.4rem;
  }

  .field label {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: var(--font-size-label-xs);
    font-weight: 700;
  }

  select {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 55%);
    border-radius: var(--radius-md);
    padding: 0.8rem 0.9rem;
    color: var(--color-text);
    background: var(--color-surface-low);
  }

  .helper-copy {
    margin-top: 0.45rem;
    font-size: 0.82rem;
  }

  .actions {
    margin-top: var(--space-2);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 0.86rem;
    font-weight: 600;
  }

  .feedback {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 600;
  }

  .domain-list {
    margin-top: var(--space-4);
    display: grid;
    gap: var(--space-3);
  }

  .domain-row {
    display: grid;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 65%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .domain-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .domain-details {
    margin-top: 0.45rem;
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    font-size: 0.82rem;
    color: var(--color-text-muted);
  }

  .domain-nameservers {
    margin-top: 0.7rem;
  }

  .domain-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .outlook-alert {
    margin-top: var(--space-4);
    display: grid;
    gap: 0.25rem;
    border: 1px solid color-mix(in srgb, var(--color-warning), transparent 54%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    color: var(--color-warning);
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--color-warning), transparent 86%), transparent 42%),
      color-mix(in srgb, var(--color-warning), var(--color-surface-card) 92%);
  }

  .outlook-alert strong {
    font-family: var(--font-family-headline);
    font-size: 0.92rem;
  }

  .outlook-alert span {
    color: color-mix(in srgb, var(--color-text), var(--color-warning) 30%);
    font-size: 0.82rem;
    font-weight: 650;
    line-height: 1.45;
  }

  .outlook-plan {
    margin-top: var(--space-4);
    display: grid;
    gap: var(--space-3);
  }

  .outlook-mailbox {
    margin-top: var(--space-5);
    border-top: 1px solid color-mix(in srgb, var(--color-outline), transparent 72%);
    padding-top: var(--space-4);
  }

  .outlook-mailbox h3 {
    font-size: 1rem;
    margin-bottom: 0.2rem;
  }

  .outlook-preview {
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 72%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: color-mix(in srgb, var(--color-primary-500), var(--color-surface-card) 94%);
  }

  .outlook-preview span {
    display: block;
    color: var(--color-text-muted);
    font-size: var(--font-size-label-xs);
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .outlook-plan-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 65%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 45%);
  }

  .outlook-warning-list,
  .next-steps {
    display: grid;
    gap: 0.45rem;
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: color-mix(in srgb, var(--color-surface-low), transparent 8%);
  }

  .outlook-warning-list p,
  .next-steps p {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 0.82rem;
    font-weight: 650;
    line-height: 1.45;
  }

  .record-list {
    display: grid;
    gap: var(--space-2);
  }

  .record-row {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 65%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: var(--color-surface-card);
  }

  .record-row.record-danger {
    border-color: color-mix(in srgb, var(--color-danger), transparent 54%);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-danger), transparent 94%), transparent),
      var(--color-surface-card);
  }

  .record-type {
    display: grid;
    gap: 0.35rem;
    color: var(--color-text-muted);
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .record-main {
    min-width: 0;
    display: grid;
    gap: 0.35rem;
  }

  .record-value {
    display: grid;
    gap: 0.3rem;
  }

  .record-value span {
    color: var(--color-text-muted);
    font-size: var(--font-size-label-xs);
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .record-main p,
  .record-main small {
    margin: 0;
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .record-main p {
    font-weight: 700;
    font-size: 0.82rem;
  }

  .record-main small {
    font-size: 0.75rem;
  }

  .feedback.success {
    color: #0f7b3d;
  }

  .feedback.error {
    color: #bb1f2f;
  }

  .webhook-grid {
    margin-top: var(--space-4);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .label {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--font-size-label-xs);
    font-weight: 700;
  }

  .value {
    margin-top: 0.25rem;
    font-weight: 600;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .url {
    margin-top: var(--space-4);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 65%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  code {
    display: block;
    margin-top: 0.4rem;
    font-size: 0.78rem;
    color: var(--color-primary-500);
    overflow-wrap: anywhere;
  }

  .inline-code {
    display: inline;
    margin-top: 0;
    font-size: 0.85em;
  }

  .api-service-panel {
    margin-top: var(--space-4);
    display: grid;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 70%);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--color-primary-500), transparent 84%), transparent 40%),
      color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 35%);
  }

  .api-service-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .api-service-head h3 {
    margin-bottom: 0.2rem;
    font-size: 1rem;
  }

  .api-service-row {
    display: grid;
    grid-template-columns: minmax(0, 14rem) 1fr;
    gap: var(--space-3);
    align-items: end;
  }

  .api-service-hint {
    padding-bottom: 0.82rem;
    color: var(--color-text-muted);
    font-size: 0.8rem;
    font-weight: 650;
  }

  .api-service-grid {
    display: grid;
    gap: var(--space-3);
  }

  .api-service-copy-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-2);
    align-items: end;
  }

  .api-service-copy-field-wide {
    grid-column: 1 / -1;
  }

  .api-service-endpoints {
    display: grid;
    gap: 0.35rem;
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 35%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .api-key-status {
    margin-top: var(--space-4);
    display: grid;
    gap: var(--space-2);
  }

  .api-key-box {
    margin-top: var(--space-3);
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 20%);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .footer {
    margin-top: var(--space-4);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  @media (max-width: 960px) {
    .wrap {
      grid-template-columns: 1fr;
      gap: var(--space-4);
    }

    .actions {
      grid-template-columns: 1fr;
    }

    .api-service-head,
    .api-service-row,
    .api-service-copy-field {
      grid-template-columns: 1fr;
    }

    .api-service-head {
      display: grid;
    }

    .api-service-hint {
      padding-bottom: 0;
    }

    .domain-actions {
      flex-direction: column;
    }

    .outlook-plan-head,
    .record-row {
      grid-template-columns: 1fr;
    }

    .outlook-plan-head {
      display: grid;
    }

    .webhook-grid {
      grid-template-columns: 1fr;
      gap: var(--space-2);
    }
  }
</style>
