<script lang="ts">
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import Button from '$lib/components/atoms/Button.svelte';
  import Icon from '$lib/components/atoms/Icon.svelte';
  import { getStandaloneDotAliasInfo, MAX_STANDALONE_DOT_ALIAS_VARIANTS } from '$lib/email-dot-aliases';
  import { locale, t } from '$lib/i18n';
  import { confirmDialog, errorToast, successToast, warningToast } from '$lib/sweet-alert';
  import type { DotAliasGenerationDto, DotAliasUsageDto } from '$lib/types/dto';
  import type { PageData } from './$types';

  type ActivationPayload = {
    attempted: boolean;
    ok: boolean;
    message: string;
    createdAliases?: string[];
    existingAliases?: string[];
    skippedAliases?: string[];
  };

  const DOT_ALIAS_TOOL_PROVIDER = 'dot_alias_tool';

  export let data: PageData;

  let generations: DotAliasGenerationDto[] = data.generations;
  let currentGeneration: DotAliasGenerationDto | null = data.generations[0] ?? null;
  let activation: ActivationPayload | null = null;
  let emailInput = '';
  let searchQuery = '';
  let aliasQuery = '';
  let generating = false;
  let deletingGenerationId = '';
  let updatingAliasEmail = '';

  $: normalizedHistoryQuery = searchQuery.trim().toLowerCase();
  $: normalizedAliasQuery = aliasQuery.trim().toLowerCase();
  $: emailPreview = getStandaloneDotAliasInfo(emailInput);
  $: emailPreviewAliasCount = emailPreview?.storableAliasCount ?? 0;
  $: currentGenerationInfo = currentGeneration ? getStandaloneDotAliasInfo(currentGeneration.sourceEmail) : null;
  $: currentAliasUsages = currentGeneration ? getAliasUsageList(currentGeneration) : [];
  $: usedAliasCount = currentAliasUsages.filter((alias) => alias.used).length;
  $: availableAliasCount = Math.max(0, currentAliasUsages.length - usedAliasCount);
  $: filteredGenerations = normalizedHistoryQuery
    ? generations.filter((generation) =>
        [generation.sourceEmail, generation.provider, generation.createdBy]
          .some((field) => field.toLowerCase().includes(normalizedHistoryQuery))
      )
    : generations;
  $: visibleAliasUsages = currentAliasUsages.filter((alias) => alias.email.toLowerCase().includes(normalizedAliasQuery));

  async function generateDotAliases() {
    if (generating) {
      return;
    }

    const email = emailInput.trim().toLowerCase();
    if (!email) {
      void warningToast($t('dot.invalidTitle'), $t('dot.emailRequired'));
      return;
    }

    generating = true;
    activation = null;
    try {
      const response = await fetch('/api/dot-aliases', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ email })
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            generation?: DotAliasGenerationDto;
            generations?: DotAliasGenerationDto[];
            activation?: ActivationPayload;
            capacity?: unknown;
          }
        | null;

      if (!response.ok || !payload?.generation) {
        void errorToast($t('dot.invalidTitle'), payload?.error ?? $t('dot.invalidCopy'));
        return;
      }

      currentGeneration = payload.generation;
      generations = payload.generations ?? [payload.generation, ...generations];
      activation = payload.activation ?? null;
      aliasQuery = '';
      void successToast(
        $t('dot.createdTitle'),
        $t('dot.createdCopy', { count: payload.generation.aliasCount, email: payload.generation.sourceEmail })
      );
    } catch {
      void errorToast($t('dot.failedTitle'), $t('dot.failedCopy'));
    } finally {
      generating = false;
    }
  }

  async function copyAliases(label: string, aliases: string[]) {
    if (aliases.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aliases.join('\n'));
      void successToast($t('common.copySucceededTitle'), $t('common.copiedValue', { label }));
    } catch {
      void errorToast($t('common.copyFailedTitle'), $t('common.copyFailed'));
    }
  }

  function getAliasUsageList(generation: DotAliasGenerationDto): DotAliasUsageDto[] {
    const usageByEmail = new Map((generation.aliasUsage ?? []).map((alias) => [alias.email, alias]));
    return generation.aliases.map((email) => {
      const normalizedEmail = email.trim().toLowerCase();
      return (
        usageByEmail.get(normalizedEmail) ?? {
          email: normalizedEmail,
          used: false,
          usedByUserId: '',
          usedByEmail: '',
          source: '',
          provider: ''
        }
      );
    });
  }

  function aliasUsageLabel(alias: DotAliasUsageDto) {
    if (updatingAliasEmail === alias.email) {
      return $t('dot.aliasSaving');
    }
    if (!alias.used) {
      return $t('dot.aliasAvailable');
    }
    return alias.usedByEmail ? $t('dot.aliasUsedBy', { email: alias.usedByEmail }) : $t('dot.aliasUsed');
  }

  function canToggleAlias(alias: DotAliasUsageDto) {
    if (!alias.used) {
      return true;
    }
    return alias.source === 'gmail' || (alias.source === 'alias' && alias.provider === DOT_ALIAS_TOOL_PROVIDER);
  }

  async function toggleAliasUsage(alias: DotAliasUsageDto, used: boolean) {
    if (!currentGeneration || updatingAliasEmail) {
      return;
    }

    const generationId = currentGeneration.id;
    updatingAliasEmail = alias.email;
    try {
      const response = await fetch('/api/dot-aliases', {
        method: 'PATCH',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ id: generationId, alias: alias.email, used })
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            generation?: DotAliasGenerationDto | null;
            generations?: DotAliasGenerationDto[];
            activation?: ActivationPayload;
          }
        | null;

      if (!response.ok || !payload) {
        void errorToast(
          used ? $t('dot.aliasMarkFailedTitle') : $t('dot.aliasUnmarkFailedTitle'),
          payload?.error ?? (used ? $t('dot.aliasMarkFailed') : $t('dot.aliasUnmarkFailed'))
        );
        return;
      }

      generations = payload.generations ?? generations;
      const nextGeneration = payload.generation ?? generations.find((item) => item.id === generationId) ?? null;
      if (currentGeneration?.id === generationId) {
        currentGeneration = nextGeneration;
      }
      activation = payload.activation ?? null;

      if (payload.activation && !payload.activation.ok) {
        void warningToast($t('dot.aliasMarkWarningTitle'), payload.activation.message);
      } else {
        void successToast(
          used ? $t('dot.aliasMarkSuccessTitle') : $t('dot.aliasUnmarkSuccessTitle'),
          used ? $t('dot.aliasMarkSuccess', { email: alias.email }) : $t('dot.aliasUnmarkSuccess', { email: alias.email })
        );
      }
    } catch {
      void errorToast(
        used ? $t('dot.aliasMarkFailedTitle') : $t('dot.aliasUnmarkFailedTitle'),
        used ? $t('dot.aliasMarkFailed') : $t('dot.aliasUnmarkFailed')
      );
    } finally {
      updatingAliasEmail = '';
    }
  }

  async function deleteGeneration(generation: DotAliasGenerationDto) {
    if (deletingGenerationId) {
      return;
    }

    const confirmed = await confirmDialog({
      title: $t('dot.deleteTitle'),
      text: $t('dot.deleteConfirm', { email: generation.sourceEmail }),
      icon: 'warning',
      detailLabel: $t('common.email'),
      detailValue: generation.sourceEmail,
      note: $t('dot.deleteNote', { count: generation.aliasCount }),
      confirmButtonText: $t('common.delete'),
      cancelButtonText: $t('common.cancel'),
      danger: true
    });

    if (!confirmed) {
      return;
    }

    deletingGenerationId = generation.id;
    try {
      const response = await fetch('/api/dot-aliases', {
        method: 'DELETE',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ id: generation.id })
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            generations?: DotAliasGenerationDto[];
          }
        | null;

      if (!response.ok) {
        void errorToast($t('dot.deleteFailedTitle'), payload?.error ?? $t('dot.deleteFailed'));
        return;
      }

      generations = payload?.generations ?? generations.filter((item) => item.id !== generation.id);
      if (currentGeneration?.id === generation.id) {
        currentGeneration = generations[0] ?? null;
        aliasQuery = '';
        activation = null;
      }
      void successToast($t('dot.deleteSuccessTitle'), $t('dot.deleteSuccess', { email: generation.sourceEmail }));
    } catch {
      void errorToast($t('dot.deleteFailedTitle'), $t('dot.deleteFailed'));
    } finally {
      deletingGenerationId = '';
    }
  }

  function formatDate(value: string) {
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }

    return date.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID');
  }

  function formatLargeCountLabel(value: string | number | undefined) {
    const raw = String(value ?? '').trim();
    if (!raw) {
      return '0';
    }

    if (/^\d+$/.test(raw)) {
      try {
        return BigInt(raw).toLocaleString($locale === 'en' ? 'en-US' : 'id-ID');
      } catch {
        return raw;
      }
    }

    return raw;
  }
</script>

<div class="layout-shell">
  <AppSidebar active="dot-aliases" />
  <section class="main">
    <AppTopbar
      title={$t('dot.title')}
      breadcrumb="flash mail flare / dot aliases"
      bind:searchQuery
      searchPlaceholder={$t('dot.search')}
    />

    <div class="content">
      <section class="hero-card">
        <div class="hero-copy">
          <span class="eyebrow">{$t('dot.eyebrow')}</span>
          <h2>{$t('dot.heroTitle')}</h2>
          <p>{$t('dot.heroCopy')}</p>
        </div>

        <form class="generator-form" on:submit|preventDefault={generateDotAliases}>
          <label for="dot-email">{$t('dot.emailLabel')}</label>
          <div class="input-row">
            <input
              id="dot-email"
              type="email"
              bind:value={emailInput}
              autocomplete="email"
              placeholder={$t('dot.emailPlaceholder')}
            />
            <Button type="submit" disabled={generating || !emailInput.trim()}>
              <Icon name="auto_awesome" size={17} />
              {generating ? $t('dot.generating') : $t('dot.generate')}
            </Button>
          </div>
          <p class="form-note">
            {#if emailPreview}
              {$t('dot.preview', {
                count: formatLargeCountLabel(emailPreviewAliasCount),
                total: formatLargeCountLabel(emailPreview.totalAdditionalAliasesLabel),
                limit: MAX_STANDALONE_DOT_ALIAS_VARIANTS
              })}
            {:else}
              {$t('dot.inputHelp')}
            {/if}
          </p>
          {#if emailPreview}
            <div class="capacity-panel">
              <div class="capacity-head">
                <Icon name={emailPreview.isGmailDotTrickDomain ? 'verified' : 'dns'} size={18} />
                <strong>{emailPreview.isGmailDotTrickDomain ? $t('dot.gmailDetected') : $t('dot.domainDetected')}</strong>
              </div>
              <div class="capacity-grid">
                <div>
                  <span>{$t('dot.usernameLength')}</span>
                  <strong>{emailPreview.baseLocalPartLength}</strong>
                </div>
                <div>
                  <span>{$t('dot.dotSlots')}</span>
                  <strong>{emailPreview.dotSlotCount}</strong>
                </div>
                <div>
                  <span>{$t('dot.totalVariations')}</span>
                  <strong>{formatLargeCountLabel(emailPreview.totalVariantsLabel)}</strong>
                </div>
                <div>
                  <span>{$t('dot.totalAliases')}</span>
                  <strong>{formatLargeCountLabel(emailPreview.totalAdditionalAliasesLabel)}</strong>
                </div>
                <div>
                  <span>{$t('dot.willSave')}</span>
                  <strong>{formatLargeCountLabel(emailPreview.storableAliasCountLabel)}</strong>
                </div>
                <div>
                  <span>{$t('dot.notSaved')}</span>
                  <strong>{formatLargeCountLabel(emailPreview.omittedAdditionalAliasesLabel)}</strong>
                </div>
              </div>
              <p class="capacity-note">
                {emailPreview.isGmailDotTrickDomain ? $t('dot.gmailSmartNote') : $t('dot.domainSmartNote')}
              </p>
            </div>
          {/if}
        </form>
      </section>

      {#if activation}
        <section class={`activation-note ${activation.ok ? 'ok' : 'warn'}`}>
          <Icon name={activation.ok ? 'check_circle' : 'error'} size={20} />
          <div>
            <strong>{activation.attempted ? $t('dot.routingChecked') : $t('dot.savedOnly')}</strong>
            <p>{activation.message}</p>
          </div>
        </section>
      {/if}

      <section class="workspace-grid">
        <article class="result-card">
          {#if currentGeneration}
            <div class="section-head">
              <div>
                <span class="eyebrow">{$t('dot.latestResult')}</span>
                <h3>{currentGeneration.sourceEmail}</h3>
              </div>
              <Badge tone={currentGeneration.provider === 'gmail' ? 'success' : 'primary'}>{currentGeneration.provider}</Badge>
            </div>

            <div class="stats-grid">
              <div>
                <span>{$t('dot.savedAliases')}</span>
                <strong>{currentGeneration.aliasCount.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID')}</strong>
              </div>
              <div>
                <span>{$t('dot.usedAliases')}</span>
                <strong>{usedAliasCount.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID')}</strong>
              </div>
              <div>
                <span>{$t('dot.availableAliases')}</span>
                <strong>{availableAliasCount.toLocaleString($locale === 'en' ? 'en-US' : 'id-ID')}</strong>
              </div>
              <div>
                <span>{$t('dot.totalPossible')}</span>
                <strong>{formatLargeCountLabel(currentGeneration.totalLabel)}</strong>
              </div>
              <div>
                <span>{$t('dot.totalAliases')}</span>
                <strong>{formatLargeCountLabel(currentGenerationInfo?.totalAdditionalAliasesLabel)}</strong>
              </div>
              <div>
                <span>{$t('dot.createdAt')}</span>
                <strong>{formatDate(currentGeneration.createdAt)}</strong>
              </div>
            </div>

            <div class="alias-toolbar">
              <label class="alias-search" for="dot-alias-search">
                <Icon name="search" size={16} />
                <input id="dot-alias-search" bind:value={aliasQuery} placeholder={$t('dot.aliasSearch')} />
              </label>
              <Button
                type="button"
                variant="secondary"
                disabled={visibleAliasUsages.length === 0}
                on:click={() => copyAliases($t('dot.aliases'), visibleAliasUsages.map((alias) => alias.email))}
              >
                <Icon name="content_copy" size={16} />
                {$t('dot.copyVisible')}
              </Button>
            </div>

            <p class="status-note">{$t('dot.aliasStatusHelp')}</p>

            {#if currentGeneration.truncated}
              <p class="limit-note">{$t('dot.limited', { count: MAX_STANDALONE_DOT_ALIAS_VARIANTS })}</p>
            {/if}

            <div class="alias-list">
              {#if visibleAliasUsages.length === 0}
                <div class="empty-state">{$t('dot.aliasEmpty')}</div>
              {:else}
                {#each visibleAliasUsages as alias (alias.email)}
                  <div class="alias-row" class:used={alias.used}>
                    <label class="alias-status" title={aliasUsageLabel(alias)}>
                      <input
                        type="checkbox"
                        checked={alias.used || updatingAliasEmail === alias.email}
                        disabled={Boolean(updatingAliasEmail) || !canToggleAlias(alias)}
                        aria-label={alias.used ? $t('dot.aliasUnmarkUsedAria', { email: alias.email }) : $t('dot.aliasMarkUsedAria', { email: alias.email })}
                        on:change={(event) => toggleAliasUsage(alias, event.currentTarget.checked)}
                      />
                      <span>
                        {#if updatingAliasEmail === alias.email}
                          {$t('dot.aliasSaving')}
                        {:else}
                          {alias.used ? $t('dot.aliasUsed') : $t('dot.aliasAvailable')}
                        {/if}
                      </span>
                    </label>
                    <div class="alias-main">
                      <code>{alias.email}</code>
                      {#if alias.used && alias.usedByEmail}
                        <small>
                          {#if alias.source === 'user'}
                            {$t('dot.aliasUsedDirect')}
                          {:else if alias.source === 'gmail'}
                            {$t('dot.aliasUsedGmail')}
                          {:else}
                            {$t('dot.aliasUsedAlias')}
                          {/if}
                          - {alias.usedByEmail}
                        </small>
                      {/if}
                    </div>
                    <button type="button" on:click={() => copyAliases($t('common.email'), [alias.email])}>
                      <Icon name="content_copy" size={15} />
                      {$t('common.copy')}
                    </button>
                  </div>
                {/each}
              {/if}
            </div>
          {:else}
            <div class="empty-panel">
              <Icon name="alternate_email" size={36} />
              <strong>{$t('dot.emptyResultTitle')}</strong>
              <span>{$t('dot.emptyResultCopy')}</span>
            </div>
          {/if}
        </article>

        <aside class="history-card">
          <div class="section-head compact">
            <div>
              <span class="eyebrow">{$t('dot.historyEyebrow')}</span>
              <h3>{$t('dot.historyTitle')}</h3>
            </div>
            <Badge tone="neutral">{generations.length}</Badge>
          </div>

          <div class="history-list">
            {#if filteredGenerations.length === 0}
              <div class="empty-state history-empty">
                <strong>{$t('dot.emptyHistoryTitle')}</strong>
                <span>{$t('dot.emptyHistoryCopy')}</span>
              </div>
            {:else}
              {#each filteredGenerations as generation (generation.id)}
                <div class="history-row" class:active={currentGeneration?.id === generation.id}>
                  <button
                    type="button"
                    class="history-select"
                    on:click={() => {
                      currentGeneration = generation;
                      activation = null;
                      aliasQuery = '';
                    }}
                  >
                    <span>{generation.sourceEmail}</span>
                    <small>{generation.aliasCount} {$t('dot.aliases')} / {formatDate(generation.createdAt)}</small>
                  </button>
                  <button
                    type="button"
                    class="history-delete"
                    aria-label={$t('dot.deleteAria', { email: generation.sourceEmail })}
                    disabled={Boolean(deletingGenerationId)}
                    on:click={() => deleteGeneration(generation)}
                  >
                    <Icon name={deletingGenerationId === generation.id ? 'progress_activity' : 'delete'} size={16} />
                  </button>
                </div>
              {/each}
            {/if}
          </div>
        </aside>
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
    gap: var(--space-5);
  }

  .hero-card,
  .result-card,
  .history-card,
  .activation-note {
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 68%);
    background: color-mix(in srgb, var(--color-surface-card), transparent 5%);
    box-shadow: var(--shadow-ambient);
  }

  .hero-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(21rem, 0.72fr);
    gap: var(--space-5);
    align-items: center;
    border-radius: 1.3rem;
    padding: var(--space-6);
    background:
      radial-gradient(circle at 10% 10%, color-mix(in srgb, var(--color-primary-500), transparent 84%), transparent 32%),
      radial-gradient(circle at 92% 16%, color-mix(in srgb, var(--color-success), transparent 86%), transparent 28%),
      color-mix(in srgb, var(--color-surface-card), transparent 4%);
  }

  .hero-copy {
    display: grid;
    gap: var(--space-3);
  }

  .eyebrow {
    color: var(--color-primary-500);
    text-transform: uppercase;
    letter-spacing: 0.13em;
    font-size: var(--font-size-label-xs);
    font-weight: 900;
  }

  h2 {
    max-width: 42rem;
    font-size: clamp(1.35rem, 2.1vw, 2.2rem);
    line-height: 1.06;
    letter-spacing: -0.045em;
  }

  .hero-copy p,
  .form-note,
  .capacity-note,
  .status-note,
  .limit-note,
  .activation-note p,
  .empty-panel span,
  .empty-state span {
    margin: 0;
    color: var(--color-text-muted);
    line-height: 1.55;
  }

  .generator-form {
    display: grid;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 70%);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-card), transparent 14%);
    padding: var(--space-4);
  }

  .capacity-panel {
    display: grid;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 72%);
    border-radius: var(--radius-lg);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-primary-500), transparent 92%), transparent),
      color-mix(in srgb, var(--color-surface-card), transparent 16%);
    padding: var(--space-3);
  }

  .capacity-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-primary-500);
    font-family: var(--font-family-headline);
    font-weight: 900;
  }

  .capacity-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.55rem;
  }

  .capacity-grid div {
    display: grid;
    gap: 0.2rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-card), transparent 10%);
    padding: 0.62rem 0.7rem;
  }

  .capacity-grid span {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    font-size: 0.58rem;
    font-weight: 900;
  }

  .capacity-grid strong {
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  .generator-form label {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 900;
  }

  .input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-3);
  }

  input {
    min-width: 0;
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 56%);
    border-radius: var(--radius-md);
    outline: 0;
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 44%);
    color: var(--color-text);
    padding: 0.8rem 0.9rem;
  }

  input:focus {
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 35%);
    box-shadow: 0 0 0 0.18rem color-mix(in srgb, var(--color-primary-500), transparent 86%);
  }

  .activation-note {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }

  .activation-note.ok {
    color: var(--color-success);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-success), transparent 90%), transparent),
      var(--color-surface-card);
  }

  .activation-note.warn {
    color: var(--color-warning);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-warning), transparent 90%), transparent),
      var(--color-surface-card);
  }

  .activation-note strong,
  .activation-note p {
    color: var(--color-text);
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.38fr);
    gap: var(--space-5);
    align-items: start;
  }

  .result-card,
  .history-card {
    border-radius: var(--radius-lg);
    padding: var(--space-5);
  }

  .result-card {
    min-height: 31rem;
    display: grid;
    gap: var(--space-4);
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
  }

  .section-head h3 {
    margin-top: 0.18rem;
    font-size: 1.32rem;
    overflow-wrap: anywhere;
  }

  .section-head.compact h3 {
    font-size: 1.05rem;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    gap: var(--space-3);
  }

  .stats-grid div {
    display: grid;
    gap: 0.25rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 72%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 48%);
    padding: var(--space-3);
  }

  .stats-grid span {
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: var(--font-size-label-xs);
    font-weight: 900;
  }

  .stats-grid strong {
    overflow-wrap: anywhere;
  }

  .alias-toolbar {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }

  .alias-search {
    min-width: 0;
    flex: 1;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    color: var(--color-text-muted);
  }

  .alias-search input {
    flex: 1;
  }

  .status-note,
  .limit-note {
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-primary-500), transparent 92%);
    padding: 0.75rem 0.9rem;
  }

  .status-note {
    color: var(--color-text-muted);
    font-size: 0.82rem;
    line-height: 1.45;
  }

  .alias-list {
    max-height: 38rem;
    min-height: 15rem;
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 0.55rem;
    padding-right: 0.25rem;
  }

  .alias-row {
    display: grid;
    grid-template-columns: minmax(7.4rem, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 74%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 54%);
    padding: 0.64rem 0.75rem;
  }

  .alias-row.used {
    border-color: color-mix(in srgb, var(--color-success), transparent 60%);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-success), transparent 91%), transparent),
      color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 54%);
  }

  .alias-status {
    display: inline-flex;
    align-items: center;
    gap: 0.48rem;
    color: var(--color-text-muted);
    font-family: var(--font-family-headline);
    font-size: 0.72rem;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }

  .alias-status input {
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--color-success);
  }

  .alias-row.used .alias-status {
    color: var(--color-success);
  }

  .alias-main {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  .alias-main small {
    color: var(--color-text-muted);
    font-size: 0.72rem;
    overflow-wrap: anywhere;
  }

  code {
    min-width: 0;
    flex: 1;
    color: var(--color-primary-500);
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.86rem;
    overflow-wrap: anywhere;
  }

  .alias-row button {
    display: inline-flex;
    align-items: center;
    gap: 0.32rem;
    border: 1px solid color-mix(in srgb, var(--color-primary-500), transparent 66%);
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--color-primary-500), transparent 91%);
    color: var(--color-primary-500);
    cursor: pointer;
    font-family: var(--font-family-headline);
    font-size: 0.72rem;
    font-weight: 900;
    padding: 0.38rem 0.6rem;
  }

  .history-card {
    position: sticky;
    top: 5.8rem;
    display: grid;
    gap: var(--space-4);
  }

  .history-list {
    display: grid;
    gap: 0.55rem;
    max-height: 39rem;
    overflow: auto;
    padding-right: 0.1rem;
  }

  .history-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: stretch;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 72%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-low), var(--color-surface-card) 46%);
    overflow: hidden;
  }

  .history-row.active {
    border-color: color-mix(in srgb, var(--color-primary-500), transparent 48%);
    background: color-mix(in srgb, var(--color-primary-500), transparent 91%);
  }

  .history-select {
    display: grid;
    gap: 0.2rem;
    width: 100%;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
    padding: 0.78rem 0.85rem;
    text-align: left;
  }

  .history-delete {
    display: inline-grid;
    place-items: center;
    width: 2.7rem;
    border: 0;
    border-left: 1px solid color-mix(in srgb, var(--color-outline), transparent 70%);
    background: color-mix(in srgb, var(--color-danger), transparent 92%);
    color: var(--color-danger);
    cursor: pointer;
  }

  .history-delete:disabled {
    cursor: not-allowed;
    opacity: 0.58;
  }

  .history-delete:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger), transparent 86%);
  }

  .history-list span {
    font-family: var(--font-family-headline);
    font-weight: 850;
    overflow-wrap: anywhere;
  }

  .history-list small {
    color: var(--color-text-muted);
    font-weight: 700;
  }

  .empty-panel,
  .empty-state {
    min-height: 11rem;
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--space-2);
    border: 1px dashed color-mix(in srgb, var(--color-outline), transparent 54%);
    border-radius: var(--radius-lg);
    color: var(--color-text-muted);
    text-align: center;
    padding: var(--space-4);
  }

  .empty-panel strong,
  .empty-state strong {
    color: var(--color-text);
  }

  .history-empty {
    min-height: 14rem;
  }

  @media (max-width: 1080px) {
    .hero-card,
    .workspace-grid {
      grid-template-columns: 1fr;
    }

    .history-card {
      position: static;
    }
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-4) var(--space-3);
      gap: var(--space-4);
    }

    .hero-card,
    .result-card,
    .history-card {
      padding: var(--space-4);
    }

    .input-row,
    .stats-grid,
    .capacity-grid,
    .alias-toolbar {
      grid-template-columns: 1fr;
      display: grid;
    }

    .alias-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .alias-row button {
      align-self: stretch;
      justify-content: center;
    }

    .history-row {
      grid-template-columns: minmax(0, 1fr) 2.7rem;
    }
  }
</style>
