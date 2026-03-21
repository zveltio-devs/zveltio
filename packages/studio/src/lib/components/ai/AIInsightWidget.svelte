<script lang="ts">
	interface Insight {
		title: string;
		description: string;
		confidence?: number;
		category?: string;
	}

	let {
		insights = [],
		loading = false,
		onRefresh = null
	}: {
		insights: Insight[];
		loading?: boolean;
		onRefresh?: (() => Promise<void>) | null;
	} = $props();
</script>

<div class="card bg-base-100 border border-base-200">
	<div class="card-body">
		<div class="flex items-center justify-between mb-4">
			<h3 class="card-title text-sm">AI Insights</h3>
			{#if onRefresh}
				<button class="btn btn-xs btn-ghost" onclick={onRefresh} disabled={loading}>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 {loading ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
				</button>
			{/if}
		</div>

		{#if loading}
			<div class="flex justify-center py-4"><span class="loading loading-spinner"></span></div>
		{:else if insights.length === 0}
			<p class="text-sm opacity-60 text-center py-4">No insights available</p>
		{:else}
			<div class="space-y-3">
				{#each insights as insight}
					<div class="p-3 bg-base-200 rounded-lg">
						<div class="flex items-start justify-between mb-1">
							<h4 class="font-semibold text-sm">{insight.title}</h4>
							{#if insight.confidence}
								<span class="badge badge-xs">{Math.round(insight.confidence * 100)}%</span>
							{/if}
						</div>
						<p class="text-xs opacity-70">{insight.description}</p>
						{#if insight.category}
							<span class="badge badge-xs badge-primary mt-2">{insight.category}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
