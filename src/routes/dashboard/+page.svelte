<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import DashboardMetricsGrid from '$lib/components/organisms/DashboardMetricsGrid.svelte';
  import CardSurface from '$lib/components/atoms/CardSurface.svelte';
  import Badge from '$lib/components/atoms/Badge.svelte';
  import type { PageData } from './$types';
  import type { DashboardDto } from '$lib/types/dto';
  import { t } from '$lib/i18n';

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;

  let dashboard: DashboardDto = data.dashboard;
  let autoRefreshing = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

  $: autoRefreshLabel = autoRefreshing ? $t('common.syncing') : $t('dashboard.autoRefreshActive');

  async function refreshDashboard() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/dashboard', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as DashboardDto | null;
      if (payload?.metrics) {
        dashboard = payload;
      }
    } finally {
      autoRefreshing = false;
    }
  }

  onMount(() => {
    autoRefreshTimer = setInterval(refreshDashboard, AUTO_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshDashboard();
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
  <AppSidebar active="dashboard" />
  <section class="main">
    <AppTopbar title={$t('dashboard.title')} breadcrumb="flash mail flare / overview" showSearch={false} />
    <div class="content">
      <div class="sync-row">
        <span class="sync-status" class:syncing={autoRefreshing}>{autoRefreshLabel}</span>
      </div>
      <DashboardMetricsGrid metrics={dashboard.metrics} />
      <CardSurface>
        <div class="footer">
          <div>
            <h3>{$t('dashboard.healthTitle')}</h3>
            <p class="text-muted">{$t('dashboard.healthCopy')}</p>
          </div>
          <Badge tone="success">{$t('dashboard.normal')}</Badge>
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
    display: grid;
    gap: var(--space-5);
  }

  .sync-row {
    display: flex;
    justify-content: flex-end;
    margin-bottom: calc(var(--space-5) * -0.45);
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

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
  }

  h3 {
    margin-bottom: 0.3rem;
    font-size: 1.1rem;
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-4) var(--space-3);
      gap: var(--space-4);
    }

    .footer {
      flex-wrap: wrap;
      align-items: flex-start;
    }
  }
</style>
