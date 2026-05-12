<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import MobileBottomNav from '$lib/components/organisms/MobileBottomNav.svelte';
  import { APP_BRAND_NAME } from '$lib/config/brand';
  import type { LayoutData } from './$types';

  export let data: LayoutData;

  $: pathname = $page.url.pathname;
  $: showAppNav = !pathname.startsWith('/auth') && !pathname.startsWith('/api');
  $: showOwnerMobileNav = showAppNav && data.sessionRole === 'owner';
</script>

<svelte:head>
  <title>{APP_BRAND_NAME}</title>
  <meta name="application-name" content={APP_BRAND_NAME} />
</svelte:head>

<div class={`app-frame ${showOwnerMobileNav ? 'with-mobile-nav' : ''}`}>
  <slot />
</div>

{#if showOwnerMobileNav}
  <MobileBottomNav />
{/if}

<style>
  .app-frame {
    min-height: 100dvh;
  }

  @media (max-width: 960px) {
    .app-frame.with-mobile-nav {
      padding-bottom: var(--mobile-nav-height);
    }
  }
</style>
