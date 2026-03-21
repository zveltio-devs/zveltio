<script lang="ts">
let {
    type = 'info',
    message = '',
    dismissible = false,
    onDismiss = null
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
        <button class="btn btn-sm btn-ghost btn-circle" onclick={onDismiss}>✕</button>
    {/if}
</div>