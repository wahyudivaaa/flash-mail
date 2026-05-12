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

  let searchQuery = '';
  let users: UserDto[] = data.users;
  let domains: MailDomainDto[] = data.domains;
  let autoRefreshing = false;
  let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

  $: domains = data.domains;
  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredUsers = normalizedQuery
    ? users.filter((user) =>
        [user.displayName, user.email, user.role, user.status].some((field) =>
          field.toLowerCase().includes(normalizedQuery)
        )
      )
    : users;

  async function handleUserCreated() {
    await invalidateAll();
    await refreshUsers();
  }

  async function handleUserChanged() {
    await invalidateAll();
    await refreshUsers();
  }

  async function refreshUsers() {
    if (autoRefreshing || document.hidden) {
      return;
    }

    autoRefreshing = true;
    try {
      const response = await fetch('/api/users', {
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { users?: UserDto[] } | null;
      if (payload?.users) {
        users = payload.users;
      }
    } finally {
      autoRefreshing = false;
    }
  }

  onMount(() => {
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
