<script lang="ts">
import { Search, X } from '@lucide/svelte';
import { m } from '$lib/i18n.svelte.js';
interface Props {
  value: string;
  placeholder?: string;
  onchange: (v: string) => void;
}
let { value, placeholder = 'Search...', onchange }: Props = $props();
</script>

<label class="input input-sm flex items-center gap-2 max-w-64">
  <Search size={13} class="text-base-content/65 shrink-0" />
  <input type="text" {placeholder} value={value}
         oninput={(e) => onchange((e.target as HTMLInputElement).value)}
         class="grow" />
  {#if value}
    <button
      type="button"
      onclick={() => onchange('')}
      aria-label={m['common.clear']()}
      class="text-base-content/55 hover:text-base-content"
    >
      <X size={12} />
    </button>
  {/if}
</label>
