<script lang="ts">
 import { onMount } from 'svelte';
 import { goto } from '$app/navigation';
 import { base } from '$app/paths';
 import { page } from '$app/state';
 import { auth } from '$lib/auth.svelte.js';
 import { initExtensions, extensions } from '$lib/extensions.svelte.js';
 import { extensionRegistry } from '$lib/extension-registry.svelte.js';
 import {
 LayoutDashboard, Database, Users, Shield, Webhook, Settings,
 Puzzle, ChevronDown, LogOut, Menu, X, HardDrive, Key, ClipboardList, Languages, Upload, Bot,
 Bell, Download, Workflow, Package, GitBranch, Plug, Wand2, Building2, Images, DatabaseBackup, Layout, CheckSquare, ScanSearch, Mail, FlaskConical, Search, Code, Bookmark, BarChart2,
 CreditCard, FileText, MessageSquare, SearchCode, LayoutGrid
 } from '@lucide/svelte';
 import ToastContainer from '$lib/components/common/ToastContainer.svelte';
 import UpdateBanner from '$lib/components/common/UpdateBanner.svelte';

 function isActive(href: string): boolean {
 const current = page.url.pathname;
 if (href === `${base}/`) return current === `${base}/` || current === `${base}`;
 return current.startsWith(href);
 }

 let { children } = $props();
 let sidebarOpen = $state(true);

 onMount(async () => {
 await auth.init();
 if (!auth.isAuthenticated) {
 goto(`${base}/login`);
 return;
 }
 await initExtensions();
 });

 const coreNav = [
 { href: `${base}/`, icon: LayoutDashboard, label: 'Dashboard' },
 { href: `${base}/collections`, icon: Database, label: 'Collections' },
 { href: `${base}/users`, icon: Users, label: 'Users' },
 { href: `${base}/permissions`, icon: Shield, label: 'Permissions' },
 { href: `${base}/webhooks`, icon: Webhook, label: 'Webhooks' },
 { href: `${base}/storage`, icon: HardDrive, label: 'Storage' },
 { href: `${base}/api-keys`, icon: Key, label: 'API Keys' },
 { href: `${base}/audit`, icon: ClipboardList, label: 'Audit Log' },
 { href: `${base}/translations`, icon: Languages, label: 'Translations' },
 { href: `${base}/import`, icon: Upload, label: 'Import' },
 { href: `${base}/export`, icon: Download, label: 'Export' },
 { href: `${base}/media`, icon: Images, label: 'Media' },
 { href: `${base}/flows`, icon: Workflow, label: 'Flows' },
 { href: `${base}/pages`, icon: Layout, label: 'Pages' },
 { href: `${base}/portal`, icon: LayoutGrid, label: 'Portal Builder' },
 { href: `${base}/backup`, icon: DatabaseBackup, label: 'Backup' },
 { href: `${base}/introspect`, icon: ScanSearch, label: 'BYOD Import' },
 { href: `${base}/notifications`, icon: Bell, label: 'Notifications' },
 { href: `${base}/ai`, icon: Bot, label: 'AI Assistant' },
 { href: `${base}/marketplace`, icon: Package, label: 'Marketplace' },
 { href: `${base}/approvals`, icon: CheckSquare, label: 'Approvals' },
 { href: `${base}/schema-branches`, icon: GitBranch, label: 'Schema Branches' },
 { href: `${base}/virtual-collections`, icon: Plug, label: 'Virtual Collections' },
 { href: `${base}/prompt-to-schema`, icon: Wand2, label: 'AI Schema Gen' },
 { href: `${base}/ai/query`, icon: Search, label: 'AI Query (SQL)' },
 { href: `${base}/ai/alchemist`, icon: FlaskConical, label: 'Data Alchemist' },
 { href: `${base}/mail`, icon: Mail, label: 'Mail' },
 { href: `${base}/edge-functions`, icon: Code, label: 'Edge Functions' },
 { href: `${base}/tenants`, icon: Building2, label: 'Tenants' },
 { href: `${base}/saved-queries`, icon: Bookmark, label: 'Saved Queries' },
 { href: `${base}/insights`, icon: BarChart2, label: 'Insights' },
 { href: `${base}/billing`, icon: CreditCard, label: 'Billing' },
 { href: `${base}/forms`, icon: FileText, label: 'Forms' },
 { href: `${base}/sms`, icon: MessageSquare, label: 'SMS' },
 { href: `${base}/search`, icon: SearchCode, label: 'Search' },
 { href: `${base}/settings`, icon: Settings, label: 'Settings' },
 ];

 async function signOut() {
 await auth.signOut();
 goto(`${base}/login`);
 }
</script>

{#if auth.loading}
 <div class="flex items-center justify-center h-screen">
 <span class="loading loading-spinner loading-lg text-primary"></span>
 </div>
{:else if auth.isAuthenticated}
 <div class="flex h-screen bg-base-100">
 <!-- Sidebar -->
 <aside class="w-64 bg-base-200 border-r border-base-300 flex flex-col shrink-0 {sidebarOpen ? '' : 'hidden'} lg:flex">
 <!-- Logo -->
 <div class="p-4 border-b border-base-300 flex items-center">
 <img src="{base}/zveltio-logo.svg" alt="Zveltio" class="h-8 w-auto" />
 </div>

 <!-- Navigation -->
 <nav class="flex-1 overflow-y-auto p-2 space-y-1">
 <!-- Core navigation -->
 {#each coreNav as item}
 <a
 href={item.href}
 class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium hover:bg-base-300 transition-colors {isActive(item.href) ? 'bg-primary/10 text-primary' : ''}"
 >
 <item.icon size={18} />
 {item.label}
 </a>
 {/each}

 <!-- Extension routes (dynamic) -->
 {#if extensions.initialized && extensionRegistry.routes.length > 0}
 <div class="divider my-2 text-xs opacity-50">Extensions</div>
 {#each [...new Set(extensionRegistry.routes.map((r) => r.category))] as category}
 <div>
 <div class="px-3 py-1 text-xs font-semibold text-base-content/50 uppercase tracking-wider flex items-center gap-1">
 <Puzzle size={12} />
 {category}
 </div>
 {#each extensionRegistry.routes.filter((r) => r.category === category) as route}
 <a
 href="{base}/extensions/{route.path}"
 class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium hover:bg-base-300 transition-colors ml-2 {isActive(`${base}/extensions/${route.path}`) ? 'bg-primary/10 text-primary' : ''}"
 >
 {route.label}
 </a>
 {/each}
 </div>
 {/each}
 {/if}
 </nav>

 <!-- User footer -->
 <div class="p-3 border-t border-base-300">
 <div class="flex items-center gap-2 px-2 py-1">
 <div class="avatar placeholder">
 <div class="bg-primary text-primary-content rounded-full w-8">
 <span class="text-xs">{auth.user?.name?.charAt(0) || 'U'}</span>
 </div>
 </div>
 <div class="flex-1 min-w-0">
 <p class="text-sm font-medium truncate">{auth.user?.name || 'User'}</p>
 <p class="text-xs text-base-content/50 truncate">{auth.user?.email}</p>
 </div>
 <button onclick={signOut} class="btn btn-ghost btn-xs" title="Sign out">
 <LogOut size={14} />
 </button>
 </div>
 </div>
 </aside>

 <!-- Main content -->
 <div class="flex-1 flex flex-col min-w-0">
 <!-- Mobile header -->
 <header class="lg:hidden flex items-center gap-2 p-4 border-b border-base-300">
 <button onclick={() => (sidebarOpen = !sidebarOpen)} class="btn btn-ghost btn-sm">
 {#if sidebarOpen}<X size={18} />{:else}<Menu size={18} />{/if}
 </button>
 <img src="{base}/zveltio-logo.svg" alt="Zveltio" class="h-7 w-auto" />
 </header>

 <main class="flex-1 overflow-y-auto p-6">
 {@render children()}
 </main>
 </div>
 </div>
{/if}

<ToastContainer />
<UpdateBanner />
