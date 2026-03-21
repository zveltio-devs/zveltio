<script lang="ts">
	interface SearchResult {
		id: string;
		title: string;
		description?: string;
		category?: string;
		href?: string;
	}

	let {
		onSearch,
		placeholder = 'Search everything...',
		categories = []
	}: {
		onSearch: (query: string, category?: string) => Promise<SearchResult[]>;
		placeholder?: string;
		categories?: string[];
	} = $props();

	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let loading = $state(false);
	let selectedCategory = $state<string | null>(null);
	let showResults = $state(false);

	async function handleSearch() {
		if (query.length < 2) {
			results = [];
			return;
		}

		loading = true;
		try {
			results = await onSearch(query, selectedCategory || undefined);
			showResults = true;
		} finally {
			loading = false;
		}
	}

	let debounceTimer: number;
	function debounceSearch() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(handleSearch, 300) as any;
	}
</script>

<div class="relative">
	<div class="flex gap-2">
		<div class="relative flex-1">
			<input
				type="text"
				bind:value={query}
				oninput={debounceSearch}
				{placeholder}
				class="input input-bordered w-full pr-10"
			/>
			<div class="absolute right-3 top-3">
				{#if loading}
					<span class="loading loading-spinner loading-sm"></span>
				{:else}
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
				{/if}
			</div>
		</div>

		{#if categories.length > 0}
			<select bind:value={selectedCategory} class="select select-bordered" onchange={handleSearch}>
				<option value={null}>All</option>
				{#each categories as cat}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		{/if}
	</div>

	{#if showResults && query.length >= 2}
		<div class="absolute z-50 w-full mt-2 bg-base-100 border border-base-200 rounded-lg shadow-lg max-h-96 overflow-auto">
			{#if results.length === 0}
				<div class="p-4 text-center text-sm opacity-60">No results found</div>
			{:else}
				{#each results as result}
					<a
						href={result.href || '#'}
						class="block p-3 hover:bg-base-200 transition"
						onclick={() => showResults = false}
					>
						<div class="flex items-start justify-between">
							<div class="flex-1">
								<h4 class="font-semibold text-sm">{result.title}</h4>
								{#if result.description}
									<p class="text-xs opacity-60 mt-1">{result.description}</p>
								{/if}
							</div>
							{#if result.category}
								<span class="badge badge-xs">{result.category}</span>
							{/if}
						</div>
					</a>
				{/each}
			{/if}
		</div>

		<button
			class="fixed inset-0 z-40"
			onclick={() => showResults = false}
			tabindex="-1"
		></button>
	{/if}
</div>
