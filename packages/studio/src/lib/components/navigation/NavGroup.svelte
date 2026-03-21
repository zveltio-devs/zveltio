<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		label,
		icon = null,
		collapsed = $bindable(false)
	}: {
		children: Snippet;
		label: string;
		icon?: Snippet | null;
		collapsed?: boolean;
	} = $props();
</script>

<div class="nav-group">
	<button
		class="flex items-center gap-2 w-full px-3 py-2 text-sm font-semibold opacity-70 hover:opacity-100"
		onclick={() => collapsed = !collapsed}
	>
		{#if icon}{@render icon()}{/if}
		<span class="flex-1 text-left">{label}</span>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			class="h-4 w-4 transition-transform {collapsed ? '' : 'rotate-90'}"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
		</svg>
	</button>
	
	{#if !collapsed}
		<div class="ml-4 space-y-1">
			{@render children()}
		</div>
	{/if}
</div>
