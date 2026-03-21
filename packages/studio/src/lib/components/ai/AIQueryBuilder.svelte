<script lang="ts">
	interface QueryCondition {
		field: string;
		operator: string;
		value: any;
	}

	let {
		query = $bindable<QueryCondition[]>([]),
		fields = [],
		onGenerate = null
	}: {
		query?: QueryCondition[];
		fields: Array<{name: string; type: string}>;
		onGenerate?: ((naturalLanguage: string) => Promise<QueryCondition[]>) | null;
	} = $props();

	let naturalQuery = $state('');
	let generating = $state(false);

	const operators = {
		text: ['equals', 'contains', 'starts with'],
		number: ['equals', '>', '<', '>=', '<='],
		date: ['equals', 'before', 'after']
	};

	function addCondition() {
		query = [...query, { field: fields[0]?.name || '', operator: 'equals', value: '' }];
	}

	function removeCondition(index: number) {
		query = query.filter((_, i) => i !== index);
	}

	async function generateFromNatural() {
		if (!onGenerate || !naturalQuery.trim()) return;
		generating = true;
		try {
			query = await onGenerate(naturalQuery);
		} finally {
			generating = false;
		}
	}
</script>

<div class="space-y-4">
	{#if onGenerate}
		<div class="flex gap-2">
			<input
				type="text"
				bind:value={naturalQuery}
				placeholder="Describe your query in plain English..."
				class="input input-bordered flex-1"
			/>
			<button class="btn btn-primary" onclick={generateFromNatural} disabled={generating}>
				{#if generating}
					<span class="loading loading-spinner loading-sm"></span>
				{:else}
					Generate
				{/if}
			</button>
		</div>
		<div class="divider">OR build manually</div>
	{/if}

	<div class="space-y-2">
		{#each query as condition, i}
			<div class="flex gap-2 items-start">
				<select bind:value={condition.field} class="select select-sm select-bordered">
					{#each fields as field}
						<option value={field.name}>{field.name}</option>
					{/each}
				</select>
				<select bind:value={condition.operator} class="select select-sm select-bordered">
					{#each operators[fields.find(f => f.name === condition.field)?.type || 'text'] || [] as op}
						<option value={op}>{op}</option>
					{/each}
				</select>
				<input
					type="text"
					bind:value={condition.value}
					class="input input-sm input-bordered flex-1"
					placeholder="Value"
				/>
				<button class="btn btn-sm btn-ghost btn-square text-error" onclick={() => removeCondition(i)}>✕</button>
			</div>
		{/each}
	</div>

	<button class="btn btn-sm btn-ghost" onclick={addCondition}>+ Add Condition</button>
</div>
