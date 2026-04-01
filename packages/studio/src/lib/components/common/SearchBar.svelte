<script lang="ts">
  import { Search, X } from '@lucide/svelte';
  interface Props {
    value: string;
    placeholder?: string;
    onchange: (v: string) => void;
  }
  let { value, placeholder = 'Search...', onchange } = $props();
</script>

<label class="input input-sm flex items-center gap-2 max-w-64">
  <Search size={13} class="text-base-content/40 shrink-0" />
  <input type="text" {placeholder} value={value}
         oninput={(e) => onchange((e.target as HTMLInputElement).value)}
         class="grow" />
  {#if value}
    <button onclick={() => onchange('')} class="text-base-content/30 hover:text-base-content">
      <X size={12} />
    </button>
  {/if}
</label>
