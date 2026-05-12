<script lang="ts">
  import { locale, setLocale, t, type Locale } from '$lib/i18n';

  export let compact = false;

  function choose(nextLocale: Locale): void {
    setLocale(nextLocale);
  }

  $: idLabel =
    $locale === 'id'
      ? $t('language.current', { language: 'Bahasa Indonesia' })
      : $t('language.switchTo', { language: 'Bahasa Indonesia' });
  $: enLabel =
    $locale === 'en' ? $t('language.current', { language: 'English' }) : $t('language.switchTo', { language: 'English' });
</script>

<div class={`language-switcher ${compact ? 'compact' : ''}`} aria-label={$t('language.label')}>
  <button
    type="button"
    class:active={$locale === 'id'}
    aria-pressed={$locale === 'id'}
    aria-label={idLabel}
    on:click={() => choose('id')}
  >
    ID
  </button>
  <span aria-hidden="true">/</span>
  <button
    type="button"
    class:active={$locale === 'en'}
    aria-pressed={$locale === 'en'}
    aria-label={enLabel}
    on:click={() => choose('en')}
  >
    EN
  </button>
</div>

<style>
  .language-switcher {
    display: inline-flex;
    align-items: center;
    gap: 0.12rem;
    border: 1px solid color-mix(in srgb, var(--color-outline), transparent 55%);
    border-radius: var(--radius-pill);
    padding: 0.18rem;
    background: color-mix(in srgb, var(--color-surface-low), transparent 8%);
    color: var(--color-text-muted);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.04em;
  }

  button {
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    min-width: 1.85rem;
    padding: 0.32rem 0.42rem;
    transition: color 120ms ease, background-color 120ms ease;
  }

  button.active {
    color: #fff;
    background: var(--color-primary-500);
  }

  span {
    opacity: 0.5;
  }

  .compact {
    font-size: 0.66rem;
  }
</style>
