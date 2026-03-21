<script lang="ts">
let {
    items = [],
    onRowClick = null
}: {
    items: any[];
    onRowClick?: ((item: any) => void) | null;
} = $props();
</script>

<div class="space-y-2">
    {#each items as item}
        <div class="card bg-base-100 shadow cursor-pointer hover:shadow-lg transition" onclick={() => onRowClick?.(item)}>
            <div class="card-body p-4">
                <pre class="text-xs">{JSON.stringify(item, null, 2)}</pre>
            </div>
        </div>
    {/each}
</div>