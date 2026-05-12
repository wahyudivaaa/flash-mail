<script context="module" lang="ts">
  export type ActionNoticeTone = 'success' | 'warning' | 'danger' | 'info';
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fly } from 'svelte/transition';
  import Icon from '$lib/components/atoms/Icon.svelte';

  export let tone: ActionNoticeTone = 'info';
  export let title = '';
  export let message = '';
  export let detail = '';
  export let dismissLabel = 'Tutup notifikasi';
  export let dismissible = true;

  const dispatch = createEventDispatcher<{ dismiss: void }>();
  let liveRole: 'alert' | 'status';
  let liveMode: 'assertive' | 'polite';

  $: iconName =
    tone === 'success'
      ? 'check_circle'
      : tone === 'warning'
        ? 'warning'
        : tone === 'danger'
          ? 'error'
          : 'info';
  $: liveRole = tone === 'danger' ? 'alert' : 'status';
  $: liveMode = tone === 'danger' ? 'assertive' : 'polite';
</script>

{#if title || message}
  <section
    class={`action-notice action-notice-${tone}`}
    role={liveRole}
    aria-live={liveMode}
    transition:fly={{ y: -8, duration: 180 }}
  >
    <div class="notice-sheen" aria-hidden="true"></div>
    <div class="notice-icon">
      <Icon name={iconName} size={22} />
    </div>
    <div class="notice-copy">
      {#if title}
        <strong>{title}</strong>
      {/if}
      {#if message}
        <p>{message}</p>
      {/if}
      {#if detail}
        <small>{detail}</small>
      {/if}
    </div>
    {#if dismissible}
      <button class="notice-close" type="button" aria-label={dismissLabel} on:click={() => dispatch('dismiss')}>
        <Icon name="close" size={17} />
      </button>
    {/if}
  </section>
{/if}

<style>
  .action-notice {
    --notice-accent: var(--color-primary-500);
    --notice-ink: var(--color-text);
    --notice-bg: color-mix(in srgb, var(--color-surface-card), var(--color-primary-500) 5%);

    position: relative;
    isolation: isolate;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: flex-start;
    gap: var(--space-3);
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--notice-accent), transparent 68%);
    border-radius: calc(var(--radius-md) + 4px);
    padding: var(--space-3);
    color: var(--notice-ink);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--notice-accent), transparent 90%), transparent 42%),
      var(--notice-bg);
    box-shadow:
      0 18px 42px color-mix(in srgb, var(--notice-accent), transparent 86%),
      inset 0 1px 0 color-mix(in srgb, white, transparent 62%);
  }

  .action-notice-success {
    --notice-accent: var(--color-success);
    --notice-bg: color-mix(in srgb, var(--color-surface-card), var(--color-success) 7%);
  }

  .action-notice-warning {
    --notice-accent: var(--color-warning);
    --notice-bg: color-mix(in srgb, var(--color-surface-card), var(--color-warning) 9%);
  }

  .action-notice-danger {
    --notice-accent: var(--color-danger);
    --notice-bg: color-mix(in srgb, var(--color-surface-card), var(--color-danger) 7%);
  }

  .notice-sheen {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: -1;
    width: 0.32rem;
    background: linear-gradient(180deg, var(--notice-accent), color-mix(in srgb, var(--notice-accent), white 35%));
    box-shadow: 0 0 22px color-mix(in srgb, var(--notice-accent), transparent 42%);
  }

  .notice-icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 999px;
    color: var(--notice-accent);
    background: color-mix(in srgb, var(--notice-accent), transparent 88%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--notice-accent), transparent 66%);
  }

  .notice-copy {
    min-width: 0;
    display: grid;
    gap: 0.2rem;
    padding-top: 0.05rem;
  }

  .notice-copy strong {
    font-family: var(--font-family-headline);
    font-size: 0.92rem;
    line-height: 1.25;
  }

  .notice-copy p,
  .notice-copy small {
    margin: 0;
    color: var(--color-text-muted);
    line-height: 1.45;
  }

  .notice-copy p {
    font-size: 0.82rem;
    font-weight: 700;
  }

  .notice-copy small {
    font-size: 0.74rem;
  }

  .notice-close {
    display: grid;
    place-items: center;
    width: 1.95rem;
    height: 1.95rem;
    border: 0;
    border-radius: 999px;
    color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-surface-low), transparent 28%);
    cursor: pointer;
    transition: color 140ms ease, background-color 140ms ease, transform 140ms ease;
  }

  .notice-close:hover {
    color: var(--color-text);
    background: color-mix(in srgb, var(--notice-accent), transparent 86%);
  }

  .notice-close:active {
    transform: scale(0.94);
  }

  @media (max-width: 640px) {
    .action-notice {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .notice-close {
      position: absolute;
      top: 0.65rem;
      right: 0.65rem;
    }
  }
</style>
