<script lang="ts">
	/**
	 * SearchableSelect - Dropdown with server-side search
	 * Zero dependencies, callback-based
	 */
	
	let {
		value = $bindable(),
		options = [],
		onSearch = null,
		placeholder = 'Search...',
		disabled = false,
		label = ''
	}: {
		value?: any;
		options?: Array<{value: any; label: string}>;
		onSearch?: ((term: string) => Promise<Array<{value: any; label: string}>>) | null;
		placeholder?: string;
		disabled?: boolean;
		label?: string;
	} = $props();

	let searchTerm = $state('');
	let isOpen = $state(false);
	let filteredOptions = $state<Array<{value: any; label: string}>>([]);
	let loading = $state(false);

	// Display label for selected value
	const selectedLabel = $derived(
		options.find(o => o.value === value)?.label || filteredOptions.find(o => o.value === value)?.label || ''
	);

	async function handleSearch(term: string) {
		searchTerm = term;
		
		if (onSearch) {
			// Server-side search
			loading = true;
			try {
				filteredOptions = await onSearch(term);
			} finally {
				loading = false;
			}
		} else {
			// Client-side filter
			filteredOptions = options.filter(o => 
				o.label.toLowerCase().includes(term.toLowerCase())
			);
		}
	}

	function selectOption(opt: {value: any; label: string}) {
		value = opt.value;
		isOpen = false;
		searchTerm = '';
	}

	// Initialize options on mount
	$effect(() => {
		if (options.length > 0 && filteredOptions.length === 0) {
			filteredOptions = options;
		}
	});
</script>

<div class="relative w-full">
	{#if label}
		<label class="label">
			<span class="label-text font-semibold">{label}</span>
		</label>
	{/if}

	<!-- Trigger Button -->
	<button
		type="button"
		class="input input-bordered w-full flex items-center justify-between"
		{disabled}
		onclick={() => !disabled && (isOpen = !isOpen)}
	>
		<span class={selectedLabel ? '' : 'opacity-50'}>
			{selectedLabel || placeholder}
		</span>
		<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if isOpen}
		<!-- Dropdown -->
		<div class="absolute z-50 w-full mt-1 bg-base-100 border border-base-200 rounded-lg shadow-lg">
			<!-- Search Input -->
			<div class="p-2">
				<input
					type="text"
					bind:value={searchTerm}
					oninput={(e) => handleSearch(e.currentTarget.value)}
					placeholder="Type to search..."
					class="input input-sm input-bordered w-full"
					autofocus
				/>
			</div>

			<!-- Options List -->
			<div class="max-h-60 overflow-auto">
				{#if loading}
					<div class="p-4 text-center text-sm opacity-50">Loading...</div>
				{:else if filteredOptions.length === 0}
					<div class="p-4 text-center text-sm opacity-50">No results</div>
				{:else}
					{#each filteredOptions as opt}
						<button
							type="button"
							class="w-full text-left px-4 py-2 hover:bg-base-200 transition flex items-center justify-between"
							onclick={() => selectOption(opt)}
						>
							<span>{opt.label}</span>
							{#if opt.value === value}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
								</svg>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		</div>

		<!-- Backdrop for closing dropdown -->
		<button
			type="button"
			class="fixed inset-0 z-40"
			onclick={() => isOpen = false}
			tabindex="-1"
		></button>
	{/if}
</div>
