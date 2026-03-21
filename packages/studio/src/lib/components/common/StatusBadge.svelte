<script lang="ts">
	let {
		status,
		label = ''
	}: {
		status: string;
		label?: string;
	} = $props();

	const statusColors: Record<string, string> = {
		active: 'badge-success',
		pending: 'badge-warning',
		inactive: 'badge-ghost',
		error: 'badge-error',
		draft: 'badge-neutral'
	};

	const displayLabel = $derived(label || status);
	const colorClass = $derived(statusColors[status.toLowerCase()] || 'badge-neutral');
</script>

<span class="badge {colorClass}">{displayLabel}</span>
