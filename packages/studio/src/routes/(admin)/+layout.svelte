<script lang="ts">
  /**
   * Admin shell.
   *
   * Owns:
   *   - Auth init + the redirect to /login if unauthenticated.
   *   - Extension bundle load (extensions must register routes/slots/form-alters
   *     before any admin page renders).
   *   - First-login redirect to onboarding (when no collections exist).
   *   - Persistent sidebar collapse + theme state.
   *   - Cmd+K palette open/close.
   *
   * Delegates:
   *   - Desktop sidebar  → `lib/components/layout/Sidebar.svelte`
   *   - Mobile drawer    → `lib/components/layout/MobileSidebar.svelte`
   *   - Nav model        → `lib/nav-model.ts`
   *
   * Keeping the shell thin makes it easy to swap the sidebar layout without
   * also touching auth/init/onboarding logic.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { realtime } from '$lib/stores/realtime.svelte.js';
  import { initExtensions, extensions } from '$lib/extensions.svelte.js';
  import { loadExtensionBundles } from '$lib/bundle-loader.js';
  import { buildNavModel, buildExtensionNav } from '$lib/nav-model.js';
  import { studioApi } from '$lib/extension-api.svelte.js';
  import Sidebar from '$lib/components/layout/Sidebar.svelte';
  import MobileSidebar from '$lib/components/layout/MobileSidebar.svelte';
  import DemoBanner from '$lib/components/common/DemoBanner.svelte';
  import Slot from '$lib/components/common/Slot.svelte';
  import ToastContainer from '$lib/components/common/ToastContainer.svelte';
  import UpdateBanner from '$lib/components/common/UpdateBanner.svelte';
  import CommandPalette from '$lib/components/common/CommandPalette.svelte';
  import { Menu, Search, Sun, Moon } from '@lucide/svelte';

  let { children } = $props();
  let collapsed = $state(false);
  let mobileOpen = $state(false);
  let dark = $state(false);
  let cmdOpen = $state(false);
  let density = $state<'comfortable' | 'compact'>('comfortable');

  $effect(() => {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-sidebar', String(collapsed));
  });

  $effect(() => {
    const theme = dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-theme', theme);
  });

  $effect(() => {
    document.documentElement.setAttribute('data-density', density);
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-density', density);
  });

  onMount(async () => {
    const sc = localStorage.getItem('zveltio-sidebar');
    if (sc !== null) collapsed = sc === 'true';
    const t = localStorage.getItem('zveltio-theme');
    if (t) dark = t === 'dark';
    const d = localStorage.getItem('zveltio-density');
    if (d === 'compact' || d === 'comfortable') density = d;

    await auth.init();
    if (!auth.isAuthenticated) {
      // Preserve the deep link so the user lands on the page they wanted
      // after sign-in instead of the dashboard.
      const from = page.url.pathname + page.url.search;
      const params = new URLSearchParams();
      if (from && from !== '/' && !from.startsWith('/login')) params.set('redirect', from);
      params.set('reason', 'session_required');
      goto(`${base}/login?${params.toString()}`);
      return;
    }
    await initExtensions();

    // S3-02 + S3-03: extension Studio bundles register routes/slots before
    // any admin page renders. One bad bundle can't block the others.
    await loadExtensionBundles();

    // First-login redirect to onboarding when no collections exist.
    const onboardingDone = localStorage.getItem('zveltio-onboarding-done');
    const isOnboarding = page.url.pathname.includes('/onboarding');
    if (!onboardingDone && !isOnboarding) {
      try {
        const engineUrl = (window as { __ZVELTIO_ENGINE_URL__?: string }).__ZVELTIO_ENGINE_URL__ ?? '';
        const res = await fetch(`${engineUrl}/api/collections`, { credentials: 'include' });
        const data = await res.json();
        if (!data?.collections?.length) goto(`${base}/onboarding`);
      } catch { /* silently skip — don't block admin on network error */ }
    }
  });

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        cmdOpen = !cmdOpen;
      }
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  const nav = $derived(buildNavModel(extensions));
  const allExtNav = $derived(buildExtensionNav(extensions));

  // Conditional desktop top-bar — only renders if an extension contributed
  // to topbar.center or topbar.right (e.g. AI extension's global prompt
  // bar). Keeps chrome minimal when nothing wants the space.
  const hasTopbarContent = $derived(
    studioApi.getSlotContributions('topbar.center').length > 0
      || studioApi.getSlotContributions('topbar.right').length > 0,
  );

  async function signOut() {
    // Close the realtime WS first so the next signed-in user gets a
    // fresh session instead of inheriting subscriptions from the
    // previous one. realtime.disconnect() is idempotent so this is
    // safe even if no WS was ever opened.
    realtime.disconnect();
    await auth.signOut();
    goto(`${base}/login?reason=signed_out`);
  }
</script>

{#if auth.loading}
  <div class="flex h-screen items-center justify-center bg-base-100">
    <div class="flex flex-col items-center gap-3">
      <span class="loading loading-spinner loading-lg text-primary"></span>
      <p class="text-sm text-base-content/50">Loading…</p>
    </div>
  </div>

{:else if auth.isAuthenticated}
  <!-- Skip-to-content link for keyboard users. Hidden until focused. -->
  <a href="#admin-main" class="skip-link">Skip to main content</a>

  <DemoBanner />

  <div class="flex h-screen bg-base-100 overflow-hidden">

    <Sidebar
      {nav}
      {allExtNav}
      {collapsed}
      {dark}
      {density}
      user={auth.user}
      onToggleCollapse={() => (collapsed = !collapsed)}
      onToggleDark={() => (dark = !dark)}
      onToggleDensity={() => (density = density === 'compact' ? 'comfortable' : 'compact')}
      onSignOut={signOut}
    />

    <MobileSidebar
      open={mobileOpen}
      {nav}
      {allExtNav}
      onClose={() => (mobileOpen = false)}
    />

    <!-- Main content -->
    <div class="flex-1 flex flex-col min-w-0">

      <!-- Mobile header -->
      <header class="lg:hidden flex items-center gap-3 px-4 h-14 bg-base-100/80 backdrop-blur-xl shadow-z1 shrink-0">
        <button onclick={() => (mobileOpen = true)} aria-label="Open menu" class="btn btn-ghost btn-sm">
          <Menu size={18} />
        </button>
        <div class="w-7 h-7 rounded-lg bg-linear-to-br from-primary to-secondary flex items-center justify-center shadow-z1">
          <span class="text-primary-content font-bold text-xs">Z</span>
        </div>
        <span class="font-bold text-sm">Zveltio</span>
        <!-- Extension slot: mobile topbar center (e.g. AI prompt bar). -->
        <div class="flex-1 min-w-0">
          <Slot name="topbar.center" ctx={{ user: auth.user, viewport: 'mobile' }} />
        </div>
        <div class="ml-auto flex items-center gap-1">
          <Slot name="topbar.right" ctx={{ user: auth.user, viewport: 'mobile' }} />
          <button onclick={() => (cmdOpen = true)} aria-label="Search (⌘K)" class="btn btn-ghost btn-sm" title="Search (⌘K)">
            <Search size={16} />
          </button>
          <button onclick={() => (dark = !dark)} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} class="btn btn-ghost btn-sm">
            {#if dark}<Sun size={16} />{:else}<Moon size={16} />{/if}
          </button>
        </div>
      </header>

      <!-- Desktop top-bar — conditional. Only renders when an extension
           targets topbar.center or topbar.right (e.g. AI extension's
           global prompt bar). Keeps chrome minimal otherwise. -->
      {#if hasTopbarContent}
        <header class="hidden lg:flex items-center gap-3 px-6 h-12 bg-base-100/70 backdrop-blur-xl shadow-z1 shrink-0">
          <Slot name="topbar.left" ctx={{ user: auth.user, viewport: 'desktop' }} />
          <div class="flex-1 min-w-0">
            <Slot name="topbar.center" ctx={{ user: auth.user, viewport: 'desktop' }} />
          </div>
          <div class="flex items-center gap-1 ml-auto">
            <Slot name="topbar.right" ctx={{ user: auth.user, viewport: 'desktop' }} />
          </div>
        </header>
      {/if}

      <main id="admin-main" class="flex-1 overflow-y-auto p-6 relative" tabindex="-1">
        {@render children()}

        <!-- Floating-assist slot — extensions can inject a fixed-position
             CTA (e.g. AI "Ask anything" floating button) that lives over
             the page content. Slot ctx carries the current pathname so
             contributions can render page-specific copy. -->
        <Slot name="page.assist" ctx={{ user: auth.user, pathname: page.url.pathname }} />
      </main>
    </div>
  </div>
{/if}

<ToastContainer />
<UpdateBanner />
<CommandPalette open={cmdOpen} onclose={() => (cmdOpen = false)} />
