<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    children,
    open = $bindable(false),
    title = '',
    size = 'md',
    onClose = null,
  }: {
    children: Snippet;
    open?: boolean;
    title?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
    onClose?: (() => void) | null;
  } = $props();

  const sizes: Record<string, string> = {
    sm:  'max-w-sm',
    md:  'max-w-lg',
    lg:  'max-w-2xl',
    xl:  'max-w-4xl',
    '2xl': 'max-w-6xl',
  };

  function close() {
    open = false;
    onClose?.();
  }
</script>

{#if open}
<dialog class="modal modal-open">
  <div class="modal-box {sizes[size] ?? sizes.md}">
    <h3 class="font-bold text-lg">{title}</h3>
    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" onclick={close}>✕</button>
    <div class="py-4">{@render children()}</div>
  </div>
  <button class="modal-backdrop" aria-label="Close modal" onclick={close}></button>
</dialog>
{/if}
