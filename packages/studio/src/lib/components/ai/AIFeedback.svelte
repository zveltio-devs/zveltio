<script lang="ts">
	let {
		onFeedback
	}: {
		onFeedback: (type: 'positive' | 'negative', comment?: string) => Promise<void>;
	} = $props();

	let showComment = $state(false);
	let comment = $state('');
	let submitted = $state(false);

	async function handleFeedback(type: 'positive' | 'negative') {
		await onFeedback(type, comment || undefined);
		submitted = true;
		setTimeout(() => {
			submitted = false;
			showComment = false;
			comment = '';
		}, 2000);
	}
</script>

<div class="flex items-center gap-2">
	{#if !submitted}
		<span class="text-xs opacity-60">Was this helpful?</span>
		<button class="btn btn-xs btn-ghost" onclick={() => handleFeedback('positive')} title="Helpful">👍</button>
		<button class="btn btn-xs btn-ghost" onclick={() => { showComment = true; }} title="Not helpful">👎</button>
		
		{#if showComment}
			<div class="flex gap-1">
				<input
					type="text"
					bind:value={comment}
					placeholder="Optional feedback..."
					class="input input-xs input-bordered w-40"
				/>
				<button class="btn btn-xs btn-primary" onclick={() => handleFeedback('negative')}>Send</button>
			</div>
		{/if}
	{:else}
		<span class="text-xs text-success">✓ Thank you!</span>
	{/if}
</div>
