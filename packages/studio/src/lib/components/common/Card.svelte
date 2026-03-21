<script lang="ts">
import type { Snippet } from 'svelte';

let {
    children,
    title = '',
    actions = null
}: {
    children: Snippet;
    title?: string;
    actions?: Snippet | null;
} = $props();
</script>

<div class="card bg-base-100 shadow-xl">
    <div class="card-body">
        {#if title || actions}
        <div class="flex justify-between items-center mb-4">
            {#if title}<h2 class="card-title">{title}</h2>{/if}
            {#if actions}<div class="card-actions">{@render actions()}</div>{/if}
        </div>
        {/if}
        {@render children()}
    </div>
</div>