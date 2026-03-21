<script lang="ts">
	/**
	 * AddressInput - Address field with geocoding
	 */
	interface Address {
		street?: string;
		city?: string;
		country?: string;
		postal_code?: string;
		lat?: number;
		lng?: number;
	}

	let {
		value = $bindable<Address>({}),
		onSearch = null,
		label = 'Address',
		disabled = false
	}: {
		value?: Address;
		onSearch?: ((query: string) => Promise<Address[]>) | null;
		label?: string;
		disabled?: boolean;
	} = $props();

	let searchResults = $state<Address[]>([]);
	let searching = $state(false);
	let showResults = $state(false);

	async function handleSearch(query: string) {
		if (!onSearch || query.length < 3) return;
		searching = true;
		try {
			searchResults = await onSearch(query);
			showResults = true;
		} finally {
			searching = false;
		}
	}

	function selectAddress(addr: Address) {
		value = addr;
		showResults = false;
	}
</script>

<div class="form-control">
	<label class="label"><span class="label-text">{label}</span></label>
	
	<div class="relative">
		<input
			type="text"
			value={value.street || ''}
			oninput={(e) => handleSearch(e.currentTarget.value)}
			placeholder="Start typing address..."
			{disabled}
			class="input input-bordered w-full"
		/>
		
		{#if searching}
			<div class="absolute right-3 top-3">
				<span class="loading loading-spinner loading-sm"></span>
			</div>
		{/if}
		
		{#if showResults && searchResults.length > 0}
			<div class="absolute z-10 w-full mt-1 bg-base-100 border rounded-lg shadow-lg max-h-60 overflow-auto">
				{#each searchResults as result}
					<button
						type="button"
						class="w-full text-left px-4 py-2 hover:bg-base-200"
						onclick={() => selectAddress(result)}
					>
						<div class="font-medium">{result.street}</div>
						<div class="text-sm opacity-60">{result.city}, {result.country}</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if value.city}
		<div class="grid grid-cols-2 gap-2 mt-2">
			<input type="text" bind:value={value.city} placeholder="City" class="input input-sm input-bordered" {disabled} />
			<input type="text" bind:value={value.postal_code} placeholder="Postal" class="input input-sm input-bordered" {disabled} />
		</div>
	{/if}
</div>
