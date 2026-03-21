<script lang="ts">
	/**
	 * SmartNavbar - Intelligent navbar with dynamic positioning
	 * Positions: top, bottom, left, right
	 * Includes: user menu, theme switcher, logo, nav items
	 */
	import type { Snippet } from 'svelte';

	interface NavItem {
		label: string;
		href: string;
		icon?: Snippet;
	}

	interface User {
		name?: string;
		email?: string;
		avatar?: string;
	}

	let {
		position = 'top',
		user = null,
		navItems = [],
		logo = null,
		currentTheme = 'light',
		onThemeToggle,
		onLogout = null,
		onPositionChange = null,
		isDraggable = false
	}: {
		position?: 'top' | 'bottom' | 'left' | 'right';
		user?: User | null;
		navItems?: NavItem[];
		logo?: Snippet | null;
		currentTheme?: string;
		onThemeToggle: (theme: string) => void;
		onLogout?: (() => void) | null;
		onPositionChange?: ((position: string) => Promise<void>) | null;
		isDraggable?: boolean;
	} = $props();

	let dragging = $state(false);
	let showPositionMenu = $state(false);

	const isHorizontal = $derived(position === 'top' || position === 'bottom');
	const isVertical = $derived(position === 'left' || position === 'right');

	const positionClasses = {
		top: 'top-0 left-0 right-0 flex-row border-b',
		bottom: 'bottom-0 left-0 right-0 flex-row border-t',
		left: 'top-0 bottom-0 left-0 flex-col border-r w-64',
		right: 'top-0 bottom-0 right-0 flex-col border-l w-64'
	};

	async function changePosition(newPos: 'top' | 'bottom' | 'left' | 'right') {
		if (onPositionChange) {
			await onPositionChange(newPos);
		}
		showPositionMenu = false;
	}

	function handleThemeToggle() {
		const newTheme = currentTheme === 'light' ? 'dark' : 'light';
		onThemeToggle(newTheme);
	}
</script>

<nav
	class="navbar bg-base-100 border-base-200 fixed z-50 {positionClasses[position]} {dragging ? 'opacity-50' : ''}"
	class:draggable={isDraggable}
>
	<!-- Logo/Brand -->
	<div class="flex-none {isVertical ? 'px-4 py-3 border-b border-base-200 w-full' : ''}">
		{#if logo}
			{@render logo()}
		{:else}
			<a href="/" class="btn btn-ghost text-xl font-bold">App</a>
		{/if}
	</div>

	<!-- Nav Items -->
	{#if navItems.length > 0}
		<div class="flex-1 {isVertical ? 'flex-col p-2 space-y-1' : 'px-4'}">
			{#each navItems as item}
				<a
					href={item.href}
					class="btn btn-ghost {isVertical ? 'w-full justify-start' : 'btn-sm'}"
				>
					{#if item.icon}
						<span class="w-5 h-5">{@render item.icon()}</span>
					{/if}
					{item.label}
				</a>
			{/each}
		</div>
	{/if}

	<!-- Actions (Theme, Position, User) -->
	<div class="flex-none {isVertical ? 'p-2 border-t border-base-200 space-y-2 w-full' : 'gap-2'}">
		<!-- Theme Toggle -->
		<button
			class="btn btn-ghost btn-circle btn-sm"
			onclick={handleThemeToggle}
			title="Toggle theme"
		>
			{#if currentTheme === 'light'}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
				</svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
				</svg>
			{/if}
		</button>

		<!-- Position Menu (if draggable) -->
		{#if isDraggable && onPositionChange}
			<div class="dropdown {isVertical ? 'dropdown-right' : 'dropdown-end'}">
				<button
					tabindex="0"
					class="btn btn-ghost btn-circle btn-sm"
					title="Change position"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
					</svg>
				</button>
				<ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-40">
					<li><button onclick={() => changePosition('top')}>Top</button></li>
					<li><button onclick={() => changePosition('bottom')}>Bottom</button></li>
					<li><button onclick={() => changePosition('left')}>Left</button></li>
					<li><button onclick={() => changePosition('right')}>Right</button></li>
				</ul>
			</div>
		{/if}

		<!-- User Menu -->
		{#if user}
			<div class="dropdown {isVertical ? 'dropdown-right' : 'dropdown-end'}">
				<button tabindex="0" class="btn btn-ghost btn-circle avatar placeholder">
					{#if user.avatar}
						<div class="w-10 rounded-full">
							<img src={user.avatar} alt={user.name} />
						</div>
					{:else}
						<div class="w-10 rounded-full bg-neutral text-neutral-content">
							<span class="text-sm">{user.name?.substring(0, 2).toUpperCase() || 'U'}</span>
						</div>
					{/if}
				</button>
				<ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-52">
					<li class="menu-title">
						<span>{user.name || user.email}</span>
					</li>
					<li><a href="/private/profile">Profile</a></li>
					<li><a href="/private/settings">Settings</a></li>
					<li class="divider"></li>
					{#if onLogout}
						<li><button onclick={onLogout}>Logout</button></li>
					{/if}
				</ul>
			</div>
		{/if}
	</div>
</nav>

<!-- Spacer to prevent content overlap -->
{#if position === 'top'}
	<div class="h-16"></div>
{:else if position === 'bottom'}
	<div class="h-16"></div>
{:else if position === 'left'}
	<div class="w-64 flex-shrink-0"></div>
{:else if position === 'right'}
	<div class="w-64 flex-shrink-0"></div>
{/if}

<style>
	.draggable {
		cursor: move;
	}
</style>
