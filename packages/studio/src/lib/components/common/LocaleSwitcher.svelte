<script lang="ts">
import { Languages } from '@lucide/svelte';
import { i18n, m } from '$lib/i18n.svelte.js';

interface Props {
  collapsed?: boolean;
}
let { collapsed = false }: Props = $props();

const labels: Record<string, () => string> = {
  en: () => m['shell.localeEn'](),
  ro: () => m['shell.localeRo'](),
  fr: () => m['shell.localeFr'](),
  de: () => m['shell.localeDe'](),
  es: () => m['shell.localeEs'](),
  it: () => m['shell.localeIt'](),
  pl: () => m['shell.localePl'](),
  nl: () => m['shell.localeNl'](),
  hu: () => m['shell.localeHu'](),
};
</script>

<div class="px-2 py-0.5">
  <label
    class="
      flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12px] font-medium w-full
      text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors
      focus-within:outline-2 focus-within:outline-primary
      {collapsed ? 'justify-center' : ''}
    "
    title={m['shell.language']()}
  >
    <Languages size={16} class="shrink-0" aria-hidden="true" />
    {#if !collapsed}
      <span class="leading-none shrink-0">{m['shell.language']()}</span>
      <select
        class="select select-xs select-ghost flex-1 min-w-0 max-w-[7rem] ml-auto font-medium"
        aria-label={m['shell.language']()}
        value={i18n.locale}
        onchange={(e) => i18n.setLocale((e.currentTarget as HTMLSelectElement).value)}
      >
        {#each i18n.availableLocales as loc (loc)}
          <option value={loc}>{labels[loc]?.() ?? loc}</option>
        {/each}
      </select>
    {:else}
      <select
        class="select select-xs select-ghost w-10 px-0 text-center"
        aria-label={m['shell.language']()}
        value={i18n.locale}
        onchange={(e) => i18n.setLocale((e.currentTarget as HTMLSelectElement).value)}
      >
        {#each i18n.availableLocales as loc (loc)}
          <option value={loc}>{loc.toUpperCase()}</option>
        {/each}
      </select>
    {/if}
  </label>
</div>
