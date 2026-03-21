<script lang="ts">
	/**
	 * RecentActivity - Dashboard widget showing recent system activity
	 */
	interface Activity {
		id: string;
		user: string;
		action: string;
		entity: string;
		timestamp: string;
	}

	let {
		activities = [],
		loading = false,
		onLoadMore = null
	}: {
		activities: Activity[];
		loading?: boolean;
		onLoadMore?: (() => void) | null;
	} = $props();

	function formatTime(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);
		
		if (minutes < 1) return 'Just now';
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		return `${days}d ago`;
	}
</script>

<div class="space-y-4">
	<h3 class="font-semibold">Recent Activity</h3>
	
	<div class="space-y-2">
		{#if loading}
			<div class="flex justify-center py-4"><span class="loading loading-spinner"></span></div>
		{:else if activities.length === 0}
			<div class="text-center py-4 text-sm opacity-50">No recent activity</div>
		{:else}
			{#each activities as activity}
				<div class="flex items-start gap-3 p-3 bg-base-200 rounded-lg">
					<div class="avatar placeholder">
						<div class="w-8 rounded-full bg-neutral text-neutral-content text-xs">
							{activity.user.substring(0, 2).toUpperCase()}
						</div>
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm">
							<span class="font-medium">{activity.user}</span>
							{' '}{activity.action}{' '}
							<span class="font-medium">{activity.entity}</span>
						</p>
						<p class="text-xs opacity-60">{formatTime(activity.timestamp)}</p>
					</div>
				</div>
			{/each}
			
			{#if onLoadMore}
				<button class="btn btn-sm btn-ghost w-full" onclick={onLoadMore}>Load More</button>
			{/if}
		{/if}
	</div>
</div>
