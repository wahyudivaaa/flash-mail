<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import AppSidebar from '$lib/components/organisms/AppSidebar.svelte';
  import AppTopbar from '$lib/components/organisms/AppTopbar.svelte';
  import UserListPanel from '$lib/components/organisms/UserListPanel.svelte';
  import type { PageData } from './$types';
  import type { MailDomainDto, UserDto } from '$lib/types/dto';
  import { t } from '$lib/i18n';

  export let data: PageData;

  const AUTO_REFRESH_INTERVAL_MS = 5000;
  const SEARCH_DEBOUNCE_MS = 300;

  let searchQuery = data.initialQuery ?? '';
  let users: UserDto[] = data.users;
  let domains: MailDomainDto[] = data.domains;
  let autoRefreshing = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let searchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let userRequestId = 0;
  let mounted = false;

  $: domains = data.domains;
  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredUsers = normalizedQuery
    ? users.filter((user) =>
        [user.displayName, user.email, user.role, user.status].some((field) =>
          field.toLowerCase().includes(normalizedQuery)
        )
      )
    : users;
  $: if (mounted) {
    scheduleSearchRefresh(normalizedQuery);
  }

  async function handleUserCreated() {
    await invalidateAll();
    await refreshUsers(normalizedQuery);
  }

  async function handleUserChanged() {
    await invalidateAll();
    await refreshUsers(normalizedQuery);
  }

  function scheduleSearchRefresh(query: string) {
    if (searchRefreshTimer) {
      clearTimeout(searchRefreshTimer);
    }

    searchRefreshTimer = setTimeout(() => {
      void refreshUsers(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function refreshUsers(query = normalizedQuery) {
    if (autoRefreshing || document.hidden) {
      return;
    }

    const requestId = ++userRequestId;
    autoRefreshing = true;
    try {
      const url = new URL('/api/users', window.location.origin);
      if (query) {
        url.searchParams.set('q', query);
      }

      const response = await fetch(url, {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { users?: UserDto[] } | null;
      if (requestId === userRequestId && payload?.users) {
        users = payload.users;
      }
    } finally {
      if (requestId === userRequestId) {
        autoRefreshing = false;
      }
    }
  }

  onMount(() => {
    mounted = true;
    autoRefreshTimer = setInterval(refreshUsers, AUTO_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void refreshUsers();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
      }
      if (searchRefreshTimer) {
        clearTimeout(searchRefreshTimer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  onDestroy(() => {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }
    if (searchRefreshTimer) {
      clearTimeout(searchRefreshTimer);
    }
  });
</script>

<div class="layout-shell">
  <AppSidebar active="users" />
  <section class="main">
    <AppTopbar
      title={$t('nav.users')}
      breadcrumb="flash mail flare / pengguna"
      bind:searchQuery
      searchPlaceholder={$t('search.users')}
    />
    <div class="content">
      <UserListPanel users={filteredUsers} {domains} {autoRefreshing} on:usercreated={handleUserCreated} on:userchanged={handleUserChanged} />
    </div>
  </section>
</div>

<style>
  .content {
    padding: var(--space-5);
  }

  @media (max-width: 960px) {
    .content {
      padding: var(--space-4) var(--space-3);
    }
  }
</style>
