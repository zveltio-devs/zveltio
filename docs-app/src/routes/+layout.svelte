<script>
	import '../app.css';
	import { page } from '$app/stores';
	
	const navItems = [
		{ title: 'Introduction', href: '/' },
		{ title: 'Installation', href: '/installation' },
		{ title: 'Architecture', href: '/architecture' },
		{ title: 'Authorization', href: '/authorization' },
		{ title: 'Extensions', href: '/extensions' },
		{ title: 'Deployment', href: '/deployment' },
		{ title: 'Security', href: '/security' },
	];
	
	// Check if we're on the homepage
	$: isHomepage = $page.url.pathname === '/';
</script>

{#if isHomepage}
	<slot />
{:else}
	<div class="app">
		<aside class="sidebar">
			<div class="logo">
				<span class="logo-icon">⚡</span>
				<span>Zveltio</span>
			</div>
			<nav>
				{#each navItems as item}
					<a href={item.href} class="nav-item">{item.title}</a>
				{/each}
			</nav>
			<div class="sidebar-footer">
				<a href="https://github.com/zveltio/zveltio" target="_blank" rel="noopener">GitHub</a>
				<span class="version">v1.0.0</span>
			</div>
		</aside>
		
		<main class="content">
			<slot />
		</main>
	</div>
{/if}

<style>
	.app {
		display: flex;
		min-height: 100vh;
	}
	
	.sidebar {
		width: 260px;
		background: #12121a;
		border-right: 1px solid #2e2e3a;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		position: fixed;
		height: 100vh;
		overflow-y: auto;
	}
	
	.logo {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 1.5rem;
		font-weight: 700;
		background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
		margin-bottom: 2rem;
		padding: 0.5rem;
	}
	
	.logo-icon {
		-webkit-text-fill-color: initial;
		font-size: 1.5rem;
	}
	
	nav {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
	}
	
	.nav-item {
		padding: 0.75rem 1rem;
		color: #94a3b8;
		text-decoration: none;
		border-radius: 8px;
		font-weight: 500;
		transition: all 0.2s;
	}
	
	.nav-item:hover {
		background: #1a1a24;
		color: #f8fafc;
	}
	
	.sidebar-footer {
		padding-top: 1rem;
		border-top: 1px solid #2e2e3a;
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.85rem;
	}
	
	.sidebar-footer a {
		color: #6366f1;
		text-decoration: none;
	}
	
	.version {
		color: #64748b;
	}
	
	.content {
		flex: 1;
		margin-left: 260px;
		padding: 2rem 3rem;
		max-width: 900px;
	}
	
	:global(h1) {
		font-size: 2.5rem;
		font-weight: 700;
		margin-bottom: 1rem;
		background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
	}
	
	:global(h2) {
		font-size: 1.75rem;
		font-weight: 600;
		margin: 2rem 0 1rem;
		color: #f8fafc;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid #2e2e3a;
	}
	
	:global(h3) {
		font-size: 1.25rem;
		font-weight: 600;
		margin: 1.5rem 0 0.75rem;
		color: #f8fafc;
	}
	
	:global(p) {
		margin-bottom: 1rem;
		color: #94a3b8;
	}
	
	:global(ul), :global(ol) {
		margin: 1rem 0 1rem 1.5rem;
		color: #94a3b8;
	}
	
	:global(li) {
		margin-bottom: 0.5rem;
	}
	
	:global(code) {
		background: #1a1a24;
		padding: 0.2rem 0.4rem;
		border-radius: 4px;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.9em;
		color: #8b5cf6;
	}
	
	:global(pre) {
		background: #1a1a24;
		padding: 1rem;
		border-radius: 8px;
		overflow-x: auto;
		margin: 1rem 0;
		border: 1px solid #2e2e3a;
	}
	
	:global(pre code) {
		background: none;
		padding: 0;
		color: #f8fafc;
	}
	
	:global(a) {
		color: #6366f1;
		text-decoration: none;
	}
	
	:global(a:hover) {
		text-decoration: underline;
	}
	
	:global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 1rem 0;
	}
	
	:global(th), :global(td) {
		padding: 0.75rem;
		text-align: left;
		border-bottom: 1px solid #2e2e3a;
	}
	
	:global(th) {
		font-weight: 600;
		color: #f8fafc;
		background: #1a1a24;
	}
	
	:global(blockquote) {
		border-left: 4px solid #6366f1;
		padding-left: 1rem;
		margin: 1rem 0;
		color: #94a3b8;
		font-style: italic;
	}
	
	:global(hr) {
		border: none;
		border-top: 1px solid #2e2e3a;
		margin: 2rem 0;
	}
	
	:global(strong) {
		color: #f8fafc;
		font-weight: 600;
	}
</style>
