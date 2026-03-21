<script lang="ts">
	/**
	 * ColumnList - Table columns editor
	 */
	interface Column {
		name: string;
		type: string;
		nullable: boolean;
		default_value?: string;
		is_primary?: boolean;
		is_unique?: boolean;
	}

	let {
		columns = $bindable<Column[]>([]),
		dataTypes = ['text', 'varchar', 'integer', 'bigint', 'decimal', 'boolean', 'date', 'timestamp', 'uuid', 'jsonb']
	}: {
		columns?: Column[];
		dataTypes?: string[];
	} = $props();

	function addColumn() {
		columns = [...columns, { name: '', type: 'text', nullable: true }];
	}

	function removeColumn(index: number) {
		columns = columns.filter((_, i) => i !== index);
	}
</script>

<div>
	<div class="flex items-center justify-between mb-3">
		<h3 class="font-semibold">Columns</h3>
		<button class="btn btn-sm btn-primary" onclick={addColumn}>+ Add Column</button>
	</div>

	<div class="space-y-2">
		{#each columns as col, i}
			<div class="grid grid-cols-12 gap-2 items-center p-3 bg-base-200 rounded-lg">
				<input
					type="text"
					bind:value={col.name}
					placeholder="name"
					class="col-span-4 input input-sm input-bordered font-mono"
				/>
				<select bind:value={col.type} class="col-span-3 select select-sm select-bordered">
					{#each dataTypes as t}
						<option value={t}>{t}</option>
					{/each}
				</select>
				<div class="col-span-4 flex gap-2 text-xs">
					<label class="flex items-center gap-1 cursor-pointer">
						<input type="checkbox" bind:checked={col.nullable} class="checkbox checkbox-xs" />
						Null
					</label>
					<label class="flex items-center gap-1 cursor-pointer">
						<input type="checkbox" bind:checked={col.is_unique} class="checkbox checkbox-xs" />
						Unique
					</label>
				</div>
				<button class="col-span-1 btn btn-xs btn-ghost text-error" onclick={() => removeColumn(i)}>✕</button>
			</div>
		{/each}
		{#if columns.length === 0}
			<div class="text-center py-4 text-sm opacity-50">No columns</div>
		{/if}
	</div>
</div>
