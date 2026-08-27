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
import { onMount, untrack } from 'svelte';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { page } from '$app/state';
import { auth } from '$lib/auth.svelte.js';
import { realtime } from '$lib/stores/realtime.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { initExtensions, extensions } from '$lib/extensions.svelte.js';
import { initFormat } from '$lib/stores/format.svelte.js';
// Extension Studio pages: declarative SDUI pages render via the generic
// host (data, not code) and Tier-3 code pages are baked into this Studio's
// route tree at release. Compile-time slot contributions load from
// `$lib/ext/<name>/contribute.ts` when an extension is enabled — no runtime
// bundle loader and no rebuild-on-enable.
import { installGlobalApi as installExtensionApi } from '$lib/extension-api.svelte.js';
import { loadExtensionContributions } from '$lib/load-extension-contributions.js';
import {
  buildNavModel,
  buildExtensionNavGroups,
  buildPaletteNavItems,
  type ExtensionNavGroupId,
} from '$lib/nav-model.js';
import { navLabel } from '$lib/nav-i18n.js';
import { m, i18n } from '$lib/i18n.svelte.js';
import { studioApi } from '$lib/extension-api.svelte.js';
import Sidebar from '$lib/components/layout/Sidebar.svelte';
import MobileSidebar from '$lib/components/layout/MobileSidebar.svelte';
import DemoBanner from '$lib/components/common/DemoBanner.svelte';
import Slot from '$lib/components/common/Slot.svelte';
import ToastContainer from '$lib/components/common/ToastContainer.svelte';
import UpdateBanner from '$lib/components/common/UpdateBanner.svelte';
import CommandPalette from '$lib/components/common/CommandPalette.svelte';
import TenantSwitcher from '$lib/components/layout/TenantSwitcher.svelte';
import KeyboardMap from '$lib/components/common/KeyboardMap.svelte';
import PreferencesMenu from '$lib/components/layout/PreferencesMenu.svelte';
import { Menu, Search, Sun, Moon } from '@lucide/svelte';

let { children } = $props();
let collapsed = $state(false);
let mobileOpen = $state(false);
let dark = $state(false);
let cmdOpen = $state(false);
let keysOpen = $state(false);
let density = $state<'comfortable' | 'compact'>('comfortable');
/** Set after `installExtensionApi` — contributions must not run before the global exists. */
let contributionApiReady = $state(false);

$effect(() => {
  if (typeof localStorage !== 'undefined')
    localStorage.setItem('zveltio-sidebar', String(collapsed));
});

$effect(() => {
  const theme = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  if (typeof localStorage !== 'undefined') localStorage.setItem('zveltio-theme', theme);
});

$effect(() => {
  document.documentElement.setAttribute('data-density', density);
  if (typeof localStorage !== 'undefined') localStorage.setItem('zveltio-density', density);
});

$effect(() => {
  if (!extensions.initialized || !contributionApiReady) return;
  const active = extensions.active;
  untrack(() => {
    void loadExtensionContributions(active);
  });
});

onMount(async () => {
  const sc = localStorage.getItem('zveltio-sidebar');
  if (sc !== null) collapsed = sc === 'true';
  const t = localStorage.getItem('zveltio-theme');
  if (t) dark = t === 'dark';
  const d = localStorage.getItem('zveltio-density');
  if (d === 'compact' || d === 'comfortable') density = d;

  // The session check moved to `+layout.ts`, which runs BEFORE this component
  // renders — `onMount` fires after, so an unauthenticated visitor saw the
  // whole admin chrome and was then redirected. Deliberately not repeated
  // here: a rule written in two places is the one that goes missing from one
  // of them, which is most of what this codebase's audits keep finding.
  //
  // `auth.init()` is idempotent and has already run in the load, so
  // `auth.isAuthenticated` is populated by the time anything below reads it.
  // Tenant date formatting — non-blocking; screens fall back to browser locale.
  initFormat();
  await initExtensions();

  // Install the contribution API on window for any extension that
  // wants to register slot items at runtime. The compiled extension
  // pages (now native SvelteKit routes after Studio rebuild) call
  // into this from their <script> blocks.
  const engineUrl = (window as { __ZVELTIO_ENGINE_URL__?: string }).__ZVELTIO_ENGINE_URL__ ?? '';
  installExtensionApi(engineUrl);
  contributionApiReady = true;

  // Listen for "studio:reloaded" events — emitted by the engine after
  // it rebuilds the Studio dist following an extension install/enable.
  // Browser's currently-loaded chunks are stale at this point; prompt
  // the user to refresh so they pick up the new ext pages.
  realtime.onSystem('studio:reloaded', (event) => {
    const changed = (event?.changed as string[] | undefined) ?? [];
    const label = changed.length === 1 ? changed[0] : `${changed.length} extensions`;
    toast.info(`Studio updated (${label}) — refresh to load new pages.`, {
      action: { label: 'Refresh now', handler: () => location.reload() },
    });
  });

  // First-login redirect to onboarding when no collections exist.
  const onboardingDone = localStorage.getItem('zveltio-onboarding-done');
  const isOnboarding = page.url.pathname.includes('/onboarding');
  if (!onboardingDone && !isOnboarding) {
    try {
      const { api: layoutApi } = await import('$lib/api.js');
      const res = await layoutApi.fetch(`/api/collections`);
      const data = await res.json();
      if (!data?.collections?.length) goto(`${base}/onboarding`);
    } catch {
      /* silently skip — don't block admin on network error */
    }
  }
});

$effect(() => {
  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      cmdOpen = !cmdOpen;
      return;
    }
    // `?` opens the keyboard map — but not while somebody is typing one. A
    // shortcut that eats a character out of a search box is worse than no
    // shortcut, so focus in a field, a textarea or a contenteditable is left
    // alone.
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      keysOpen = !keysOpen;
    }
  }
  window.addEventListener('keydown', onKeydown);
  return () => window.removeEventListener('keydown', onKeydown);
});

const nav = $derived(buildNavModel(extensions));
const extNavGroups = $derived(buildExtensionNavGroups(extensions));

const extGroupLabels: Record<ExtensionNavGroupId, () => string> = {
  business: () => m['nav.group.business'](),
  finance: () => m['nav.group.finance'](),
  hr: () => m['nav.group.hr'](),
  operations: () => m['nav.group.operations'](),
  compliance: () => m['nav.group.compliance'](),
  content: () => m['nav.group.content'](),
  communications: () => m['nav.group.communications'](),
  developer: () => m['nav.group.developer'](),
  projects: () => m['nav.group.projects'](),
  other: () => m['nav.group.other'](),
};

const paletteNavItems = $derived.by(() => {
  void i18n.locale;
  return buildPaletteNavItems(
    extensions,
    navLabel,
    (id) => extGroupLabels[id](),
    m['palette.group.navigation'](),
  );
});

// Conditional desktop top-bar — only renders if an extension contributed
// to topbar.center or topbar.right (e.g. AI extension's global prompt
// bar). Keeps chrome minimal when nothing wants the space.
const hasTopbarContent = $derived(
  studioApi.getSlotContributions('topbar.center').length > 0 ||
    studioApi.getSlotContributions('topbar.right').length > 0,
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
      <p class="text-sm text-base-content/65">{m['common.loading']()}</p>
    </div>
  </div>

{:else if auth.isAuthenticated}
  <!-- Skip-to-content link for keyboard users. Hidden until focused. -->
  <a href="#admin-main" class="skip-link">{m['shell.skipToContent']()}</a>

  <DemoBanner />

  <div class="flex h-screen bg-base-100 overflow-hidden">

    <Sidebar
      {nav}
      {extNavGroups}
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
      {extNavGroups}
      onClose={() => (mobileOpen = false)}
    />

    <!-- Main content -->
    <div class="flex-1 flex flex-col min-w-0">

      <!-- Mobile header -->
      <header class="lg:hidden flex items-center gap-3 px-4 h-14 bg-base-100/80 backdrop-blur-xl shadow-z1 shrink-0">
        <button type="button" onclick={() => (mobileOpen = true)} aria-label={m['shell.openMenu']()} class="btn btn-ghost btn-sm">
          <Menu size={18} />
        </button>
        <div class="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-z1">
          <span class="text-primary-content font-bold text-xs">Z</span>
        </div>
        <span class="font-bold text-sm">Zveltio</span>
        <!-- Extension slot: mobile topbar center (e.g. AI prompt bar). -->
        <div class="flex-1 min-w-0">
          <Slot name="topbar.center" ctx={{ user: auth.user, viewport: 'mobile' }} />
        </div>
        <div class="ml-auto flex items-center gap-1">
          <Slot name="topbar.right" ctx={{ user: auth.user, viewport: 'mobile' }} />
          <button onclick={() => (cmdOpen = true)} aria-label={m['shell.search']()} class="btn btn-ghost btn-sm" title={m['shell.search']()}>
            <Search size={16} />
          </button>
          <button onclick={() => (dark = !dark)} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} class="btn btn-ghost btn-sm">
            {#if dark}<Sun size={16} />{:else}<Moon size={16} />{/if}
          </button>
        </div>
      </header>

      <!-- Desktop top-bar. It used to render only when an extension asked for one,
           which meant the shell owed a person four things and showed none of them:
           which unit they are standing in, that search exists at all, where their
           account lives, and room for an extension.
           Search is a control shaped like a field rather than an icon — ⌘K is not
           discoverable, and a shortcut nobody can find is a shortcut nobody uses. -->
      <header
        class="hidden h-12 shrink-0 items-center gap-3 border-b border-base-300 bg-base-100 px-6 lg:flex"
      >
        <Slot name="topbar.left" ctx={{ user: auth.user, viewport: 'desktop' }} />
        <TenantSwitcher />
        <button
          type="button"
          onclick={() => (cmdOpen = true)}
          class="btn btn-ghost btn-sm w-64 justify-between gap-2 border border-base-300 font-normal text-base-content/65"
        >
          <span class="flex items-center gap-2"><Search size={14} /> {m['shell.searchHint']()}</span>
          <kbd class="kbd kbd-xs">⌘K</kbd>
        </button>
        <div class="min-w-0 flex-1">
          <Slot name="topbar.center" ctx={{ user: auth.user, viewport: 'desktop' }} />
        </div>
        <div class="ml-auto flex items-center gap-1">
          <Slot name="topbar.right" ctx={{ user: auth.user, viewport: 'desktop' }} />
          <PreferencesMenu
            {dark}
            {density}
            onToggleDark={() => (dark = !dark)}
            onToggleDensity={() => (density = density === 'compact' ? 'comfortable' : 'compact')}
          />
        </div>
      </header>

      <!-- The content area carries the tint and cards are white, not the other way
           round. A card on a white page has to draw a border to be seen at all; a
           white card on a tinted ground is simply an object sitting on a surface. -->
      <main id="admin-main" class="relative flex-1 overflow-y-auto bg-base-200 p-4 lg:p-6" tabindex="-1">
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
<CommandPalette open={cmdOpen} onclose={() => (cmdOpen = false)} navItems={paletteNavItems} />
<KeyboardMap open={keysOpen} onclose={() => (keysOpen = false)} />
