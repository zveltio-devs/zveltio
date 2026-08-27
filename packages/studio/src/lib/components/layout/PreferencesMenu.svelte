<script lang="ts">
/**
 * Language, theme and density — in the account menu, not in the navigation.
 *
 * They used to sit in the sidebar between "Tenants" and the account card, in the
 * middle of a list of places to go. They are not places to go. A person looking
 * to change the language looks where their own account lives, which is the one
 * place these were not.
 */
import { Settings2, Sun, Moon, Rows2, Rows3, UserCog } from '@lucide/svelte';
import { base } from '$app/paths';
import LocaleSwitcher from '$lib/components/common/LocaleSwitcher.svelte';
import { m } from '$lib/i18n.svelte.js';

let {
  dark,
  density,
  onToggleDark,
  onToggleDensity,
}: {
  dark: boolean;
  density: 'comfortable' | 'compact';
  onToggleDark: () => void;
  onToggleDensity: () => void;
} = $props();

let open = $state(false);
</script>

<div class="dropdown dropdown-end">
  <button
    type="button"
    class="btn btn-ghost btn-sm btn-square"
    onclick={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={m['shell.preferences']()}
    title={m['shell.preferences']()}
  >
    <Settings2 size={16} />
  </button>
  {#if open}
    <ul class="dropdown-content menu z-50 mt-1 w-60 rounded-box bg-base-100 p-1.5 shadow-z2">
      <li class="menu-title px-2 py-1 text-[11px] uppercase tracking-[.1em]">
        {m['shell.preferences']()}
      </li>
      <li><LocaleSwitcher collapsed={false} /></li>
      <li>
        <button type="button" onclick={onToggleDark} class="gap-3">
          {#if dark}<Sun size={15} />{:else}<Moon size={15} />{/if}
          {dark ? m['shell.lightMode']() : m['shell.darkMode']()}
        </button>
      </li>
      <li>
        <button
          type="button"
          onclick={onToggleDensity}
          aria-pressed={density === 'compact'}
          class="gap-3"
        >
          {#if density === 'compact'}<Rows3 size={15} />{:else}<Rows2 size={15} />{/if}
          {density === 'compact' ? m['shell.densityComfortable']() : m['shell.densityCompact']()}
        </button>
      </li>
      <li>
        <a href="{base}/account" class="gap-3"><UserCog size={15} /> {m['nav.account']()}</a>
      </li>
    </ul>
  {/if}
</div>
