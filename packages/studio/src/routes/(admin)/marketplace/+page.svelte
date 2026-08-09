<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import {
  Package,
  CheckCircle,
  Power,
  PowerOff,
  Settings,
  Trash2,
  Download,
  RefreshCw,
  AlertTriangle,
  Puzzle,
  Workflow,
  Brain,
  FileText,
  Zap,
  Map,
  Shield,
  Code2,
  Key,
  Circle,
  Hammer,
  ShieldAlert,
  ShieldCheck,
} from '@lucide/svelte';
import { api as marketplaceApi } from '$lib/api.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import PageSpinner from '$lib/components/common/PageSpinner.svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import { toast } from '$lib/stores/toast.svelte.js';
import { refreshExtensions } from '$lib/extensions.svelte.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
const CATEGORY_ICONS: Record<string, any> = {
  workflow: Workflow,
  ai: Brain,
  content: FileText,
  automation: Zap,
  geospatial: Map,
  compliance: Shield,
  developer: Code2,
  custom: Puzzle,
};

const CATEGORY_COLORS: Record<string, string> = {
  workflow: 'text-blue-500',
  ai: 'text-purple-500',
  content: 'text-orange-500',
  automation: 'text-yellow-500',
  geospatial: 'text-teal-500',
  compliance: 'text-red-500',
  developer: 'text-cyan-500',
  custom: 'text-gray-400',
};

interface Extension {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  author: string;
  tags: string[];
  requires_license?: boolean;
  has_license?: boolean;
  is_installed: boolean;
  is_enabled: boolean;
  is_running: boolean;
  needs_restart: boolean;
  files_on_disk: boolean;
  /**
   * Why the last load attempt failed, straight from the engine.
   *
   * The engine has always recorded this — it hot-loads on enable, and when that
   * throws it stores the reason "so the operator sees WHY in the marketplace
   * instead of the extension silently vanishing". The API has always returned
   * it. This page never read it, so every failure looked like the one thing the
   * card could say: "Restart".
   *
   * That is worse than saying nothing. `geospatial/postgis` fails to load until
   * someone runs `CREATE EXTENSION postgis`, and the engine says exactly that.
   * A restart does not fix it, so the badge sent people to do the one thing
   * guaranteed not to work, twice, while the real instruction sat in the
   * response body.
   */
  last_load_error?: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  config: Record<string, any>;
  /** Other extensions this one requires (by name). */
  dependencies?: string[];
  /** Subset of `dependencies` that are not yet enabled — blocks Install/Enable. */
  missing_dependencies?: string[];
  /**
   * Who stands behind this build. Governs whether the engine runs it inline
   * or confines it to a worker, so it is the single most consequential fact
   * on the card. Absent (old engine) is treated as `community`: unknown
   * provenance is not a weaker claim than known-untrusted.
   */
  publisher_tier?: 'first-party' | 'verified' | 'community';
  /** Capabilities the manifest asks for. */
  declared_capabilities?: string[];
  /** Capabilities an admin approved. null = install predating consent tracking. */
  granted_capabilities?: string[] | null;
  /**
   * Declared but never approved. Non-empty means this version asks for MORE
   * than was agreed to and is running WITHOUT the difference — the admin has a
   * decision to make. This is the whole point of recording consent: an update
   * must not be able to widen an extension's power on its own say-so.
   */
  pending_capabilities?: string[];
}

// ── License key modal state ────────────────────────────────────────────────
let licenseExt = $state<Extension | null>(null);
let licenseKey = $state('');
let licenseError = $state('');
let licenseSaving = $state(false);

// ── Catalog state ──────────────────────────────────────────────────────────
let extensions = $state<Extension[]>([]);
let loading = $state(false);
let error = $state('');
let processingId = $state<string | null>(null);
let restartNeeded = $state(false);
let searchQuery = $state('');
let selectedCategory = $state('all');
let configuringExt = $state<Extension | null>(null);
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmClass?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });
let configJson = $state('{}');
let configError = $state('');

let cat = $state('all');

// ── Rebuild state ──────────────────────────────────────────────────────────
let rebuildingExt = $state<string | null>(null);
let rebuildElapsed = $state(0);
let rebuildTimer = $state<ReturnType<typeof setInterval> | null>(null);

function startRebuildIndicator(extName: string) {
  if (rebuildTimer) clearInterval(rebuildTimer);
  rebuildingExt = extName;
  rebuildElapsed = 0;
  rebuildTimer = setInterval(() => {
    rebuildElapsed += 1;
  }, 1000);
  // Auto-reload studio after 35s to surface new nav item
  setTimeout(async () => {
    clearInterval(rebuildTimer!);
    rebuildTimer = null;
    rebuildingExt = null;
    rebuildElapsed = 0;
    await loadCatalog();
    await refreshExtensions();
  }, 35_000);
}

const CATEGORIES = [
  'analytics',
  'auth',
  'business',
  'communications',
  'compliance',
  'content',
  'data',
  'developer',
  'ecommerce',
  'finance',
  'geospatial',
  'hr',
  'i18n',
  'integrations',
  'operations',
  'projects',
  'storage',
  'workflow',
];

const filtered = $derived(
  extensions.filter((e) => {
    const q = searchQuery.toLowerCase();
    const matchSearch =
      !q ||
      e.displayName.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some((t) => t.includes(q));
    const matchSideCat = cat === 'all' || e.category === cat;
    return matchSearch && matchSideCat;
  }),
);

const stats = $derived({
  total: extensions.length,
  installed: extensions.filter((e) => e.is_installed).length,
  running: extensions.filter((e) => e.is_running).length,
});

// ── API helper ─────────────────────────────────────────────────────────────
// Local wrapper around the shared $lib/api client — keeps the existing
// call sites unchanged while routing through the centralised credentials/
// base-URL logic instead of re-implementing it per page.
async function api(path: string, opts: RequestInit = {}) {
  const res = await marketplaceApi.fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: m['mkt.requestFailed']() }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── License key actions ────────────────────────────────────────────────────
function openLicense(ext: Extension) {
  licenseExt = ext;
  licenseKey = '';
  licenseError = '';
}

async function saveLicense() {
  if (!licenseExt) return;
  licenseError = '';
  licenseSaving = true;
  try {
    await api(`/api/marketplace/license/${encodeURIComponent(licenseExt.name)}`, {
      method: 'POST',
      body: JSON.stringify({ license_key: licenseKey }),
    });
    licenseExt = null;
    await loadCatalog();
    toast.success(m['mkt.licenseSaved']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    licenseError = e.message;
  } finally {
    licenseSaving = false;
  }
}

async function removeLicense(ext: Extension) {
  await api(`/api/marketplace/license/${encodeURIComponent(ext.name)}`, { method: 'DELETE' }).catch(
    () => {},
  );
  await loadCatalog();
  toast.success(m['mkt.licenseRemoved']());
}

// ── Catalog actions ────────────────────────────────────────────────────────
async function loadCatalog() {
  loading = true;
  error = '';
  try {
    const data = await api('/api/marketplace');
    extensions = data.extensions || [];
    // An extension that failed to load does not need a restart — it needs
    // whatever its error says. Counting it here put a banner across the top of
    // the page telling the operator to restart, above a card that could not be
    // fixed by restarting.
    restartNeeded = extensions.some((e) => e.needs_restart && !e.last_load_error);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    error = e.message;
  } finally {
    loading = false;
  }
}

/**
 * Publisher-tier badge.
 *
 * A missing tier reads as `community`. An old engine that does not send the
 * field, or an extension absent from the catalog, are both cases of unknown
 * provenance — which is not a weaker claim than known-untrusted, so the badge
 * must not quietly disappear and leave the card looking endorsed.
 *
 * The title carries the consequence rather than the label: "Community" on its
 * own tells an operator nothing about what they are approving.
 */
type Tier = 'first-party' | 'verified' | 'community';
const asTier = (t: Tier | undefined): Tier => t ?? 'community';

function tierLabel(t: Tier | undefined): string {
  const tier = asTier(t);
  if (tier === 'community') return m['mkt.tier.community']();
  if (tier === 'verified') return m['mkt.tier.verified']();
  return m['mkt.tier.firstParty']();
}

function tierTitle(t: Tier | undefined): string {
  const tier = asTier(t);
  if (tier === 'community') return m['mkt.tier.communityTitle']();
  if (tier === 'verified') return m['mkt.tier.verifiedTitle']();
  return m['mkt.tier.firstPartyTitle']();
}

function tierBadgeClass(t: Tier | undefined): string {
  const tier = asTier(t);
  if (tier === 'community') return 'badge-warning';
  if (tier === 'verified') return 'badge-info badge-outline';
  return 'badge-ghost';
}

async function install(ext: Extension) {
  processingId = ext.name;
  try {
    await api(`/api/marketplace/${encodeURIComponent(ext.name)}/install`, { method: 'POST' });
    await loadCatalog();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(m['mkt.installFailed']({ error: e.message }));
  } finally {
    processingId = null;
  }
}

/**
 * Grant exactly the capabilities the admin was shown.
 *
 * Sends the explicit list rather than "approve whatever it asks for", so a
 * version landing between rendering this card and the click cannot be approved
 * unseen — the server refuses anything the manifest does not currently declare.
 */
async function approveCapabilities(ext: Extension) {
  const pending = ext.pending_capabilities ?? [];
  if (pending.length === 0) return;
  processingId = ext.name;
  try {
    await api(`/api/marketplace/${encodeURIComponent(ext.name)}/approve-capabilities`, {
      method: 'POST',
      body: JSON.stringify({ capabilities: ext.declared_capabilities ?? [] }),
    });
    toast.success(m['mkt.approved']({ caps: pending.join(', '), name: ext.displayName }));
    await loadCatalog();
  } catch (e) {
    toast.error(m['mkt.approvalFailed']({ error: (e as Error).message }));
  } finally {
    processingId = null;
  }
}

async function enable(ext: Extension) {
  processingId = ext.name;
  try {
    // Engine now awaits the Studio rebuild inline (v2 model: rebuild
    // IS the install step, not a side-effect). The response carries
    // the real outcome — no more "triggered" / unknown end-state.
    const res = await api(`/api/marketplace/${encodeURIComponent(ext.name)}/enable`, {
      method: 'POST',
    });
    if (res.needs_restart) restartNeeded = true;
    await loadCatalog();
    await refreshExtensions();

    if (!res.success) {
      toast.error(res.error_detail ?? m['mkt.couldNotLoad']({ name: ext.displayName }));
      return;
    }

    const rebuild = res.studio_rebuild as 'success' | 'failed' | 'skipped' | undefined;
    const sec = res.studio_rebuild_ms ? `${(res.studio_rebuild_ms / 1000).toFixed(1)}s` : '';

    if (rebuild === 'success') {
      // Engine broadcasts `studio:reloaded` on WS — the (admin) layout
      // shows a refresh prompt with "Refresh now" button. We just
      // confirm the action here.
      toast.success(m['mkt.activeRebuilt']({ name: ext.displayName, sec }));
    } else if (rebuild === 'failed') {
      // Non-fatal: every bundled extension page ships in the pre-built
      // Studio dist, so the UI is reachable after a refresh regardless.
      // Only genuinely custom pages need a successful rebuild.
      toast.info(m['mkt.activePrebuilt']({ name: ext.displayName }));
    } else {
      // skipped → in-process rebuild is off (the default). Bundled extension
      // pages already ship in the pre-built Studio dist, so the page is live
      // after a refresh — no rebuild or restart needed.
      toast.success(m['mkt.activeRefresh']({ name: ext.displayName }));
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(m['mkt.enableFailed']({ error: e.message }));
  } finally {
    processingId = null;
  }
}

async function disable(ext: Extension) {
  confirmState = {
    open: true,
    title: m['mkt.disableExt'](),
    message: m['mkt.disableMsg']({ name: ext.displayName }),
    confirmLabel: m['mkt.disable'](),
    confirmClass: 'btn-warning',
    onconfirm: async () => {
      confirmState.open = false;
      processingId = ext.name;
      try {
        const res = await api(`/api/marketplace/${encodeURIComponent(ext.name)}/disable`, {
          method: 'POST',
        });
        await loadCatalog();
        await refreshExtensions();

        const rebuild = res?.studio_rebuild as 'success' | 'failed' | 'skipped' | undefined;
        const sec = res?.studio_rebuild_ms ? `${(res.studio_rebuild_ms / 1000).toFixed(1)}s` : '';

        if (rebuild === 'success') {
          toast.success(m['mkt.disabledRebuilt']({ name: ext.displayName, sec }));
        } else if (rebuild === 'failed') {
          // Non-fatal — disable already took effect in the engine; the
          // Studio dist just wasn't recompiled. Refresh still reflects it.
          toast.info(m['mkt.disabledRecompile']({ name: ext.displayName }));
        } else {
          // skipped → default path. The extension is gone from the engine and
          // its nav entry; the (still-compiled) page just won't be linked.
          toast.success(m['mkt.disabled']({ name: ext.displayName }));
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (e: any) {
        toast.error(m['mkt.disableFailed']({ error: e.message }));
      } finally {
        processingId = null;
      }
    },
  };
}

async function uninstall(ext: Extension) {
  confirmState = {
    open: true,
    title: m['mkt.uninstallExt'](),
    message: m['mkt.uninstallMsg']({ name: ext.displayName }),
    confirmLabel: m['mkt.uninstall'](),
    onconfirm: async () => {
      confirmState.open = false;
      processingId = ext.name;
      try {
        await api(`/api/marketplace/${encodeURIComponent(ext.name)}/uninstall`, { method: 'POST' });
        await loadCatalog();
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (e: any) {
        toast.error(m['mkt.uninstallFailed']({ error: e.message }));
      } finally {
        processingId = null;
      }
    },
  };
}

function openConfig(ext: Extension) {
  configuringExt = ext;
  configJson = JSON.stringify(ext.config || {}, null, 2);
  configError = '';
}

async function saveConfig() {
  if (!configuringExt) return;
  configError = '';
  try {
    const parsed = JSON.parse(configJson);
    await api(`/api/marketplace/${encodeURIComponent(configuringExt.name)}/config`, {
      method: 'PUT',
      body: JSON.stringify(parsed),
    });
    configuringExt = null;
    await loadCatalog();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    configError = e instanceof SyntaxError ? m['mkt.invalidJson']() : e.message;
  }
}

onMount(loadCatalog);
</script>

<div class="space-y-6">

  <PageHeader title={m['nav.marketplace']()} subtitle={m['mkt.subtitle']()}>
    <button class="btn btn-ghost btn-sm gap-1" onclick={loadCatalog} disabled={loading}>
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      {m['common.refresh']()}
    </button>
  </PageHeader>

    {#if rebuildingExt}
      <div class="alert alert-info py-3 mb-4 gap-3">
        <Hammer size={18} class="shrink-0 animate-bounce" />
        <div class="flex-1">
          <p class="font-medium text-sm">{m['mkt.rebuilding']({ name: rebuildingExt })}</p>
          <p class="text-xs opacity-70">{m['mkt.rebuildTakes']()} {m['mkt.elapsed']({ s: rebuildElapsed })}</p>
        </div>
        <span class="loading loading-spinner loading-sm shrink-0"></span>
      </div>
    {/if}

    {#if restartNeeded}
      <div class="alert alert-warning py-2 mb-4 text-sm">
        <span>{m['mkt.restartNeeded']()}</span>
      </div>
    {/if}

    {#if error}
      <div class="alert alert-error mb-6">{error}</div>
    {/if}

    <!-- Search bar -->
    <div class="mb-5">
      <input
        type="text"
        class="input input-sm w-full"
        placeholder={m['mkt.searchPh']()}
        bind:value={searchQuery}
      />
    </div>

    <!-- Sidebar + Grid -->
    <div class="flex gap-5">

      <!-- Sidebar categories -->
      <nav class="w-36 shrink-0 space-y-0.5">
        <button
          class="w-full text-left px-3 py-1.5 rounded-lg text-sm
                 {cat === 'all' ? 'bg-primary/10 text-primary font-medium' : 'text-base-content/60 hover:bg-base-200'}"
          onclick={() => cat = 'all'}
        >
          {m['common.filter.all']()} ({extensions.length})
        </button>
        {#each CATEGORIES as c}
          <button
            class="w-full text-left px-3 py-1.5 rounded-lg text-sm capitalize
                   {cat === c ? 'bg-primary/10 text-primary font-medium' : 'text-base-content/60 hover:bg-base-200'}"
            onclick={() => cat = c}
          >
            {c}
          </button>
        {/each}
      </nav>

      <!-- Grid -->
      <div class="flex-1">
        {#if loading}
          <PageSpinner py={20} />
        {:else if filtered.length === 0}
          <div class="text-center py-20 opacity-50">
            <Puzzle size={48} class="mx-auto mb-3" />
            <p>{m['mkt.noneFound']()}</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {#each filtered as ext}
              {@const Icon = CATEGORY_ICONS[ext.category] ?? Puzzle}
              {@const iconColor = CATEGORY_COLORS[ext.category] ?? 'text-gray-400'}
              {@const isProcessing = processingId === ext.name}
              {@const isRebuilding = rebuildingExt === ext.displayName}
              {@const missingDeps = ext.missing_dependencies ?? []}
              {@const depsBlocked = missingDeps.length > 0}

              <div class="card bg-base-100 shadow-sm border transition-all
                {ext.is_running
                  ? 'border-success/40'
                  : ext.is_enabled && ext.needs_restart && !ext.files_on_disk
                  ? 'border-error/40'
                  : ext.is_enabled && ext.needs_restart
                  ? 'border-warning/40'
                  : ext.is_installed
                  ? 'border-primary/30'
                  : 'border-base-300'}">
                <div class="card-body p-5">

                  <!-- Card header -->
                  <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <Icon size={22} class={iconColor} />
                      <div class="min-w-0">
                        <h3 class="font-bold truncate">{ext.displayName}</h3>
                        <p class="text-xs opacity-40">v{ext.version} · {ext.author}</p>
                      </div>
                    </div>

                    <!-- Status badge -->
                    {#if isRebuilding}
                      <span class="badge badge-info badge-sm shrink-0 gap-1">
                        <span class="loading loading-spinner loading-xs"></span> {m['mkt.building']()}
                      </span>
                    {:else if ext.is_running}
                      <span class="badge badge-success badge-sm shrink-0 gap-1">
                        <CheckCircle size={10} /> {m['mkt.running']()}
                      </span>
                    {:else if ext.is_enabled && !ext.files_on_disk}
                      <span class="badge badge-error badge-sm shrink-0 gap-1" title={m['mkt.filesMissingTitle']()}>
                        <AlertTriangle size={10} /> {m['mkt.filesMissing']()}
                      </span>
                    {:else if ext.is_enabled && ext.last_load_error}
                      <span class="badge badge-error badge-sm shrink-0 gap-1">
                        <AlertTriangle size={10} /> {m['mkt.loadFailed']()}
                      </span>
                    {:else if ext.is_enabled && ext.needs_restart}
                      <span class="badge badge-warning badge-sm shrink-0 gap-1">
                        <AlertTriangle size={10} /> {m['mkt.restart']()}
                      </span>
                    {:else if ext.is_installed}
                      <span class="badge badge-ghost badge-sm shrink-0">{m['mkt.installed']()}</span>
                    {:else}
                      <span class="badge badge-ghost badge-sm shrink-0 opacity-50">
                        <Circle size={10} /> {m['mkt.available']()}
                      </span>
                    {/if}
                  </div>

                  <!-- Description -->
                  <p class="text-sm opacity-60 line-clamp-2 mb-3">{ext.description}</p>

                  <!--
                    The reason, in full and not truncated. It is the engine's own
                    sentence and it is usually a command to run — clipping it to
                    two lines would cut off the half that matters.
                  -->
                  {#if ext.is_enabled && ext.last_load_error}
                    <div class="alert alert-error alert-soft text-xs mb-3 py-2 items-start">
                      <AlertTriangle size={14} class="shrink-0 mt-0.5" />
                      <span class="break-words">{ext.last_load_error}</span>
                    </div>
                  {/if}

                  <!-- Tags -->
                  <div class="flex flex-wrap gap-1 mb-2">
                    <!--
                      Who stands behind this build. The engine already decides
                      with it — first-party and verified run in the engine
                      process, community is confined to a worker — so the
                      operator approving an install was the one person the
                      answer was kept from. The title carries the consequence,
                      not the label: "Community" means nothing on its own.
                    -->
                    <span
                      class="badge badge-xs gap-1 {tierBadgeClass(ext.publisher_tier)}"
                      title={tierTitle(ext.publisher_tier)}
                    >
                      {#if (ext.publisher_tier ?? 'community') === 'community'}
                        <ShieldAlert size={8} />
                      {/if}
                      {tierLabel(ext.publisher_tier)}
                    </span>
                    {#each ext.tags.slice(0, 3) as tag}
                      <span class="badge badge-xs badge-ghost">{tag}</span>
                    {/each}
                    {#if ext.requires_license}
                      <span class="badge badge-xs badge-warning gap-1">
                        <Key size={8} /> {ext.has_license ? m['mkt.licensed']() : m['mkt.paid']()}
                      </span>
                    {/if}
                  </div>

                  <!-- Dependencies -->
                  {#if ext.dependencies && ext.dependencies.length > 0}
                    <div class="flex flex-wrap items-center gap-1 mb-4 text-xs">
                      <span class="opacity-50">{m['mkt.dependsOn']()}</span>
                      {#each ext.dependencies as dep}
                        {@const unmet = missingDeps.includes(dep)}
                        <span
                          class="badge badge-xs {unmet ? 'badge-warning' : 'badge-success badge-outline'}"
                          title={unmet ? m['mkt.depNotEnabled']() : m['common.col.enabled']()}
                        >{dep}</span>
                      {/each}
                    </div>
                  {:else}
                    <div class="mb-4"></div>
                  {/if}

                  <!-- Pending capability request. Shown whenever this version
                       asks for more than was approved: it is running WITHOUT
                       these, so an admin who never sees this never finds out
                       why a feature silently does nothing. -->
                  {#if (ext.pending_capabilities ?? []).length > 0}
                    <div class="alert alert-warning py-2 px-3 mb-3 text-xs items-start">
                      <ShieldAlert size={14} class="mt-0.5 shrink-0" />
                      <div class="min-w-0">
                        <p class="font-semibold">{m['mkt.requestsNewPerms']()}</p>
                        <p class="opacity-80 mb-2">
                          {m['mkt.asksFor1']()}
                          {#each ext.pending_capabilities ?? [] as cap, i}<code
                            class="font-mono">{cap}</code>{#if i < (ext.pending_capabilities ?? []).length - 1}, {/if}{/each},
                          {m['mkt.asksFor2']()}
                        </p>
                        <button
                          class="btn btn-warning btn-xs gap-1"
                          disabled={isProcessing}
                          onclick={() => approveCapabilities(ext)}
                        >
                          <ShieldCheck size={12} /> {m['common.approve']()}
                        </button>
                      </div>
                    </div>
                  {/if}

                  <!-- Actions -->
                  <div class="flex items-center gap-2 mt-auto">
                    {#if isProcessing}
                      <span class="loading loading-spinner loading-sm text-primary"></span>

                    {:else if ext.requires_license && !ext.has_license}
                      <button class="btn btn-warning btn-sm flex-1 gap-1" onclick={() => openLicense(ext)}>
                        <Key size={14} /> {m['mkt.enterLicense']()}
                      </button>

                    {:else if !ext.is_installed}
                      {#if depsBlocked}
                        <button
                          class="btn btn-sm flex-1 gap-1"
                          disabled
                          title={m['mkt.enableFirst']({ deps: missingDeps.join(', ') })}
                        >
                          <Download size={14} /> {m['mkt.install']()}
                        </button>
                      {:else}
                        <button class="btn btn-primary btn-sm flex-1 gap-1" onclick={() => install(ext)}>
                          <Download size={14} /> {m['mkt.install']()}
                        </button>
                      {/if}

                    {:else if !ext.is_enabled && !ext.is_running}
                      {#if depsBlocked}
                        <button
                          class="btn btn-sm flex-1 gap-1"
                          disabled
                          title={m['mkt.enableFirst']({ deps: missingDeps.join(', ') })}
                        >
                          <Power size={14} /> {m['mkt.enable']()}
                        </button>
                      {:else}
                        <button class="btn btn-success btn-sm flex-1 gap-1" onclick={() => enable(ext)}>
                          <Power size={14} /> {m['mkt.enable']()}
                        </button>
                      {/if}
                      <button class="btn btn-ghost btn-sm" onclick={() => openConfig(ext)} title={m['mkt.configure']()}>
                        <Settings size={14} />
                      </button>
                      <button class="btn btn-ghost btn-sm text-error" onclick={() => uninstall(ext)} title={m['mkt.uninstall']()}>
                        <Trash2 size={14} />
                      </button>

                    {:else}
                      <button class="btn btn-ghost btn-sm flex-1 gap-1 text-error" onclick={() => disable(ext)}>
                        <PowerOff size={14} /> {m['mkt.disable']()}
                      </button>
                      <button class="btn btn-ghost btn-sm" onclick={() => openConfig(ext)} title={m['mkt.configure']()}>
                        <Settings size={14} />
                      </button>
                    {/if}
                  </div>

                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

  </div>

<!-- License key modal -->
{#if licenseExt}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <h3 class="font-bold text-lg mb-1">{m['mkt.enterLicense']()}</h3>
      <p class="text-sm opacity-60 mb-4">
        {m['mkt.licenseFor']()} <strong>{licenseExt.displayName}</strong>.
        {m['mkt.purchaseAt']()} <a href="https://apps.zveltio.com" target="_blank" rel="noopener" class="link">apps.zveltio.com</a>.
      </p>

      <input
        type="text"
        class="input input-bordered w-full font-mono text-sm {licenseError ? 'input-error' : ''}"
        placeholder="XXXX-XXXX-XXXX-XXXX"
        bind:value={licenseKey}
        spellcheck={false}
      />

      {#if licenseError}
        <p class="text-error text-sm mt-1">{licenseError}</p>
      {/if}

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => licenseExt = null}>{m['common.cancel']()}</button>
        <button class="btn btn-primary gap-1" onclick={saveLicense} disabled={licenseSaving || !licenseKey.trim()}>
          {#if licenseSaving}<span class="loading loading-spinner loading-xs"></span>{:else}<Key size={14} />{/if}
          {m['mkt.saveKey']()}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label={m['common.close']()} onclick={() => licenseExt = null}></button>
  </div>
{/if}

<!-- Config modal -->
{#if configuringExt}
  <div class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-1">{m['mkt.configureName']({ name: configuringExt.displayName })}</h3>
      <p class="text-sm opacity-60 mb-3">
        {m['mkt.configDesc']()}
      </p>

      <textarea
        class="textarea w-full font-mono text-sm h-48 {configError ? 'textarea-error' : ''}"
        bind:value={configJson}
        spellcheck={false}
      ></textarea>

      {#if configError}
        <p class="text-error text-sm mt-1">{configError}</p>
      {/if}

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => configuringExt = null}>{m['common.cancel']()}</button>
        <button class="btn btn-primary" onclick={saveConfig}>{m['mkt.saveConfig']()}</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label={m['common.close']()} onclick={() => configuringExt = null}></button>
  </div>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? m['common.confirm']()}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
