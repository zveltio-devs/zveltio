<script lang="ts">
	/**
	 * PermissionGuard - Standalone permission gatekeeper
	 * 
	 * Props-based design: no external dependencies
	 * Compatible with Casbin, RBAC, or any auth system
	 */
	import type { Snippet } from 'svelte';

	let {
		children,
		fallback,
		canAccess = true, // Parent decides permission
		isLoading = false,
		showFallback = false,
		errorMessage = 'Access Denied'
	}: {
		children: Snippet;
		fallback?: Snippet;
		canAccess?: boolean;
		isLoading?: boolean;
		showFallback?: boolean;
		errorMessage?: string;
	} = $props();
</script>

{#if isLoading}
	<div class="flex items-center gap-2 p-4 text-sm opacity-50">
		<svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
			<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
			<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
		</svg>
		Verifying permissions...
	</div>
{:else if canAccess}
	{@render children()}
{:else if showFallback}
	{#if fallback}
		{@render fallback()}
	{:else}
		<div class="border-base-300 bg-base-200/50 flex flex-col items-center gap-4 rounded-3xl border-2 border-dashed p-8 text-center">
			<div class="bg-error/10 text-error rounded-full p-3 shadow-inner">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
				</svg>
			</div>
			<div class="max-w-xs">
				<h3 class="text-lg font-bold">Access Restricted</h3>
				<p class="text-xs opacity-60 mt-1">{errorMessage}</p>
			</div>
		</div>
	{/if}
{/if}
