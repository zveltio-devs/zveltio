<script lang="ts">
let {
    tableName = $bindable(''),
    columns = $bindable([]),
    onSave
}: {
    tableName?: string;
    columns?: any[];
    onSave: (data: any) => Promise<void>;
} = $props();

function addColumn() {
    columns = [...columns, { name: '', type: 'text', nullable: true }];
}
</script>

<div class="space-y-4">
    <input bind:value={tableName} placeholder="Table Name" class="input input-bordered w-full" />
    
    <div class="space-y-2">
        {#each columns as col, i}
            <div class="flex gap-2">
                <input bind:value={col.name} placeholder="Column Name" class="input input-bordered flex-1" />
                <select bind:value={col.type} class="select select-bordered">
                    <option>text</option>
                    <option>number</option>
                    <option>boolean</option>
                    <option>date</option>
                </select>
                <button class="btn btn-error btn-square" onclick={() => columns = columns.filter((_, idx) => idx !== i)}>✕</button>
            </div>
        {/each}
    </div>
    
    <button class="btn btn-primary" onclick={addColumn}>+ Add Column</button>
    <button class="btn btn-success" onclick={() => onSave({ tableName, columns })}>Save</button>
</div>