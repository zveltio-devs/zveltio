<script lang="ts">
import type { Snippet } from 'svelte';

let {
    children,
    open = $bindable(false),
    title = '',
    onClose = null
}: {
    children: Snippet;
    open?: boolean;
    title?: string;
    onClose?: (() => void) | null;
} = $props();

function close() {
    open = false;
    onClose?.();
}
</script>

{#if open}
<dialog class="modal modal-open">
    <div class="modal-box">
        <h3 class="font-bold text-lg">{title}</h3>
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" onclick={close}>✕</button>
        <div class="py-4">{@render children()}</div>
    </div>
    <div class="modal-backdrop" onclick={close}></div>
</dialog>
{/if}