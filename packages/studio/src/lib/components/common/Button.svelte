<script lang="ts">
let {
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  onclick = null,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  children: any;
  variant?: 'primary' | 'secondary' | 'ghost' | 'error';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  onclick?: (() => void) | null;
} = $props();
</script>

<button
    class="btn btn-{variant} btn-{size}"
    {disabled}
    {onclick}
>
    {#if loading}
        <span class="loading loading-spinner loading-sm"></span>
    {/if}
    {@render children()}
</button>