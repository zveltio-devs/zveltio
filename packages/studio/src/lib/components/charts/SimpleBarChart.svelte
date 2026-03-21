<script lang="ts">
let {
    data = [],
    xKey = 'name',
    yKey = 'value'
}: {
    data: any[];
    xKey?: string;
    yKey?: string;
} = $props();

const maxValue = $derived(Math.max(...data.map(d => d[yKey])));
</script>

<div class="space-y-2">
    {#each data as item}
        <div class="flex items-center gap-2">
            <span class="text-sm w-24 truncate">{item[xKey]}</span>
            <div class="flex-1 bg-base-200 rounded-full h-6 relative">
                <div 
                    class="bg-primary h-full rounded-full" 
                    style="width: {(item[yKey] / maxValue) * 100}%"
                ></div>
            </div>
            <span class="text-sm font-mono">{item[yKey]}</span>
        </div>
    {/each}
</div>