<script lang="ts">
	/**
	 * DynamicDataTable - Universal data table with sorting, filtering, actions
	 */
	interface Column {
		key: string;
		label: string;
		sortable?: boolean;
		format?: (value: any) => string;
	}

	let {
		columns,
		data = [],
		onRowClick = null,
		onSort = null,
		loading = false,
		emptyMessage = 'No data'
	}: {
		columns: Column[];
		data?: any[];
		onRowClick?: ((row: any) => void) | null;
		onSort?: ((column: string, direction: 'asc' | 'desc') => void) | null;
		loading?: boolean;
		emptyMessage?: string;
	} = $props();

	let sortColumn = $state<string | null>(null);
	let sortDirection = $state<'asc' | 'desc'>('asc');

	function handleSort(col: Column) {
		if (!col.sortable) return;
		if (sortColumn === col.key) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortColumn = col.key;
			sortDirection = 'asc';
		}
		onSort?.(col.key, sortDirection);
	}

	function getCellValue(row: any, col: Column) {
		const val = row[col.key];
		return col.format ? col.format(val) : val;
	}
</script>

<div class="overflow-x-auto">
	<table class="table table-zebra">
		<thead>
			<tr>
				{#each columns as col}
					<th>
						{#if col.sortable}
							<button class="flex items-center gap-1" onclick={() => handleSort(col)}>
								{col.label}
								{#if sortColumn === col.key}
									<span>{sortDirection === 'asc' ? '↑' : '↓'}</span>
								{/if}
							</button>
						{:else}
							{col.label}
						{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#if loading}
				<tr><td colspan={columns.length} class="text-center"><span class="loading loading-spinner"></span></td></tr>
			{:else if data.length === 0}
				<tr><td colspan={columns.length} class="text-center opacity-50">{emptyMessage}</td></tr>
			{:else}
				{#each data as row}
					<tr class={onRowClick ? 'cursor-pointer hover:bg-base-200' : ''} onclick={() => onRowClick?.(row)}>
						{#each columns as col}
							<td>{getCellValue(row, col)}</td>
						{/each}
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
