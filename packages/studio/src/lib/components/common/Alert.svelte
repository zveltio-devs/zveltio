<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
let {
  type = 'info',
  message = '',
  dismissible = false,
  onDismiss = null,
}: {
  type?: 'info' | 'success' | 'warning' | 'error';
  message: string;
  dismissible?: boolean;
  onDismiss?: (() => void) | null;
} = $props();
</script>

<div class="alert alert-{type}">
    <span>{message}</span>
    {#if dismissible}
        <button class="btn btn-sm btn-ghost btn-circle" onclick={onDismiss} aria-label={m['common.dismiss']()}>✕</button>
    {/if}
</div>