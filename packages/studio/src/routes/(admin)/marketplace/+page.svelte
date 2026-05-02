<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Package, CheckCircle, Power, PowerOff, Settings,
    Trash2, Download, RefreshCw, AlertTriangle, Puzzle,
    Workflow, Brain, FileText, Zap, Map, Shield, Code2, Star,
    Circle, LogIn, UserPlus, LogOut, User, Eye, EyeOff,
  } from '@lucide/svelte';
  import { ENGINE_URL } from '$lib/config.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { refreshExtensions } from '$lib/extensions.svelte.js';

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
    bundled: boolean;
    is_installed: boolean;
    is_enabled: boolean;
    is_running: boolean;
    needs_restart: boolean;
    files_on_disk: boolean;
    config: Record<string, any>;
  }

  // ── Auth state ─────────────────────────────────────────────────────────────
  let authChecking  = $state(true);
  let authenticated = $state(false);
  let authUser      = $state<{ email: string; name: string; image: string | null } | null>(null);
  let authMode      = $state<'login' | 'signup'>('login');
  let authEmail     = $state('');
  let authPassword  = $state('');
  let authName      = $state('');
  let authError     = $state('');
  let authSubmitting = $state(false);
  let showPassword  = $state(false);

  // ── Catalog state ──────────────────────────────────────────────────────────
  let extensions   = $state<Extension[]>([]);
  let loading      = $state(false);
  let error        = $state('');
  let processingId = $state<string | null>(null);
  let restartNeeded = $state(false);
  let searchQuery  = $state('');
  let selectedCategory = $state('all');
  let configuringExt = $state<Extension | null>(null);
  let confirmState = $state<{
    open: boolean; title: string; message: string;
    confirmLabel?: string; confirmClass?: string; onconfirm: () => void;
  }>({ open: false, title: '', message: '', onconfirm: () => {} });
  let configJson  = $state('{}');
  let configError = $state('');

  let cat = $state('all');

  const CATEGORIES = [
    'analytics', 'auth', 'business', 'communications', 'compliance',
    'content', 'data', 'developer', 'ecommerce', 'finance', 'geospatial',
    'hr', 'i18n', 'integrations', 'operations', 'projects', 'storage', 'workflow',
  ];

  const filtered = $derived(
    extensions.filter(e => {
      const q = searchQuery.toLowerCase();
      const matchSearch = !q ||
        e.displayName.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some(t => t.includes(q));
      const matchSideCat = cat === 'all' || e.category === cat;
      return matchSearch && matchSideCat;
    })
  );

  const stats = $derived({
    total: extensions.length,
    installed: extensions.filter(e => e.is_installed).length,
    running: extensions.filter(e => e.is_running).length,
  });

  // ── API helper ─────────────────────────────────────────────────────────────
  async function api(path: string, opts: RequestInit = {}) {
    const res = await fetch(`${ENGINE_URL}${path}`, {
      ...opts,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── Auth actions ───────────────────────────────────────────────────────────
  async function checkSession() {
    authChecking = true;
    try {
      const data = await api('/api/marketplace/auth/session');
      if (data.authenticated) {
        authenticated = true;
        authUser = data.user;
        await loadCatalog();
      }
    } catch {
      // Session check failed — show login form
    } finally {
      authChecking = false;
    }
  }

  async function login() {
    authError = '';
    authSubmitting = true;
    try {
      const data = await api('/api/marketplace/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      authenticated = true;
      authUser = data.user;
      await loadCatalog();
    } catch (e: any) {
      authError = e.message;
    } finally {
      authSubmitting = false;
    }
  }

  async function signup() {
    authError = '';
    authSubmitting = true;
    try {
      const data = await api('/api/marketplace/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email: authEmail, password: authPassword, name: authName }),
      });
      if (data.needsLogin) {
        authMode = 'login';
        toast.success('Account created! Please log in.');
        return;
      }
      authenticated = true;
      authUser = data.user;
      await loadCatalog();
    } catch (e: any) {
      authError = e.message;
    } finally {
      authSubmitting = false;
    }
  }

  function handleAuthSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (authMode === 'login') login();
    else signup();
  }

  async function logout() {
    await api('/api/marketplace/auth/logout', { method: 'POST' }).catch(() => {});
    authenticated = false;
    authUser = null;
    extensions = [];
    authEmail = '';
    authPassword = '';
    authName = '';
    authError = '';
  }

  // ── OAuth popup flow ───────────────────────────────────────────────────────
  let oauthPending = $state(false);

  function connectViaOAuth() {
    oauthPending = true;
    authError = '';
    const origin = encodeURIComponent(window.location.origin);
    const popup = window.open(
      `https://apps.zveltio.com/connect-marketplace?origin=${origin}`,
      'zveltio-oauth',
      'width=480,height=620,left=' + Math.round((screen.width - 480) / 2) + ',top=' + Math.round((screen.height - 620) / 2),
    );

    const onMessage = async (ev: MessageEvent) => {
      if (ev.data?.type !== 'zveltio-marketplace-token') return;
      window.removeEventListener('message', onMessage);
      oauthPending = false;
      const token = ev.data.token as string;
      if (!token) { authError = 'No token received from popup'; return; }
      try {
        const data = await api('/api/marketplace/auth/connect', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        authenticated = true;
        authUser = data.user;
        await loadCatalog();
      } catch (e: any) {
        authError = e.message;
      }
    };

    window.addEventListener('message', onMessage);

    // Clean up if popup is closed without completing auth
    const pollClosed = setInterval(() => {
      if (popup?.closed) {
        clearInterval(pollClosed);
        window.removeEventListener('message', onMessage);
        oauthPending = false;
      }
    }, 500);
  }

  // ── Catalog actions ────────────────────────────────────────────────────────
  async function loadCatalog() {
    loading = true;
    error = '';
    try {
      const data = await api('/api/marketplace');
      extensions = data.extensions || [];
      restartNeeded = extensions.some(e => e.needs_restart);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function install(ext: Extension) {
    processingId = ext.name;
    try {
      await api(`/api/marketplace/${encodeURIComponent(ext.name)}/install`, { method: 'POST' });
      await loadCatalog();
    } catch (e: any) {
      toast.error(`Install failed: ${e.message}`);
    } finally {
      processingId = null;
    }
  }

  async function enable(ext: Extension) {
    processingId = ext.name;
    try {
      const res = await api(`/api/marketplace/${encodeURIComponent(ext.name)}/enable`, { method: 'POST' });
      if (res.needs_restart) restartNeeded = true;
      await loadCatalog();
      await refreshExtensions();
      if (!res.needs_restart) toast.success(`${ext.displayName} is now active`);
      else toast.error(res.error_detail ?? `${ext.displayName} could not be loaded — check server logs`);
    } catch (e: any) {
      toast.error(`Enable failed: ${e.message}`);
    } finally {
      processingId = null;
    }
  }

  async function disable(ext: Extension) {
    confirmState = {
      open: true,
      title: 'Disable Extension',
      message: `Disable "${ext.displayName}"?`,
      confirmLabel: 'Disable',
      confirmClass: 'btn-warning',
      onconfirm: async () => {
        confirmState.open = false;
        processingId = ext.name;
        try {
          await api(`/api/marketplace/${encodeURIComponent(ext.name)}/disable`, { method: 'POST' });
          await loadCatalog();
          await refreshExtensions();
        } catch (e: any) {
          toast.error(`Disable failed: ${e.message}`);
        } finally {
          processingId = null;
        }
      },
    };
  }

  async function uninstall(ext: Extension) {
    confirmState = {
      open: true,
      title: 'Uninstall Extension',
      message: `Uninstall "${ext.displayName}"? Configuration will be lost.`,
      confirmLabel: 'Uninstall',
      onconfirm: async () => {
        confirmState.open = false;
        processingId = ext.name;
        try {
          await api(`/api/marketplace/${encodeURIComponent(ext.name)}/uninstall`, { method: 'POST' });
          await loadCatalog();
        } catch (e: any) {
          toast.error(`Uninstall failed: ${e.message}`);
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
    } catch (e: any) {
      configError = e instanceof SyntaxError ? 'Invalid JSON' : e.message;
    }
  }

  onMount(checkSession);
</script>

<!-- ── Session checking ───────────────────────────────────────────────────── -->
{#if authChecking}
  <div class="flex items-center justify-center min-h-[60vh]">
    <span class="loading loading-spinner loading-lg text-primary"></span>
  </div>

<!-- ── Not authenticated — login / signup ────────────────────────────────── -->
{:else if !authenticated}
  <div class="flex items-center justify-center min-h-[70vh]">
    <div class="card bg-base-100 shadow-lg border border-base-300 w-full max-w-sm">
      <div class="card-body gap-5">

        <!-- Header -->
        <div class="text-center">
          <div class="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Package size={24} class="text-primary" />
          </div>
          <h2 class="text-xl font-bold">Zveltio Marketplace</h2>
          <p class="text-sm text-base-content/50 mt-1">
            Sign in to browse and install extensions
          </p>
        </div>

        <!-- Tabs -->
        <div class="tabs tabs-boxed bg-base-200 p-1 rounded-lg">
          <button
            class="tab flex-1 text-sm {authMode === 'login' ? 'tab-active' : ''}"
            onclick={() => { authMode = 'login'; authError = ''; }}
          >
            Sign In
          </button>
          <button
            class="tab flex-1 text-sm {authMode === 'signup' ? 'tab-active' : ''}"
            onclick={() => { authMode = 'signup'; authError = ''; }}
          >
            Create Account
          </button>
        </div>

        <!-- Form -->
        <form onsubmit={handleAuthSubmit} class="space-y-3">

          {#if authMode === 'signup'}
            <div class="form-control">
              <label class="label py-0.5" for="auth-name">
                <span class="label-text text-sm">Full name</span>
              </label>
              <input
                id="auth-name"
                type="text"
                class="input input-sm input-bordered"
                placeholder="Your name"
                bind:value={authName}
                required
                autocomplete="name"
              />
            </div>
          {/if}

          <div class="form-control">
            <label class="label py-0.5" for="auth-email">
              <span class="label-text text-sm">Email</span>
            </label>
            <input
              id="auth-email"
              type="email"
              class="input input-sm input-bordered"
              placeholder="you@example.com"
              bind:value={authEmail}
              required
              autocomplete="email"
            />
          </div>

          <div class="form-control">
            <label class="label py-0.5" for="auth-password">
              <span class="label-text text-sm">Password</span>
            </label>
            <div class="relative">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                class="input input-sm input-bordered w-full pr-10"
                placeholder="••••••••"
                bind:value={authPassword}
                required
                minlength={authMode === 'signup' ? 8 : 1}
                autocomplete={authMode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content"
                onclick={() => showPassword = !showPassword}
                tabindex="-1"
              >
                {#if showPassword}
                  <EyeOff size={14} />
                {:else}
                  <Eye size={14} />
                {/if}
              </button>
            </div>
            {#if authMode === 'signup'}
              <label class="label py-0.5">
                <span class="label-text-alt text-base-content/40">Minimum 8 characters</span>
              </label>
            {/if}
          </div>

          {#if authError}
            <div class="alert alert-error py-2 text-sm">{authError}</div>
          {/if}

          <button
            type="submit"
            class="btn btn-primary btn-sm w-full gap-2 mt-1"
            disabled={authSubmitting}
          >
            {#if authSubmitting}
              <span class="loading loading-spinner loading-xs"></span>
            {:else if authMode === 'login'}
              <LogIn size={14} />
            {:else}
              <UserPlus size={14} />
            {/if}
            {authMode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div class="divider text-xs text-base-content/30 my-1">or continue with</div>

        <button
          type="button"
          class="btn btn-outline btn-sm w-full gap-2 mb-2"
          onclick={connectViaOAuth}
          disabled={oauthPending}
        >
          {#if oauthPending}
            <span class="loading loading-spinner loading-xs"></span>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
            </svg>
          {/if}
          Sign in with Google or GitHub
        </button>

        <p class="text-xs text-center text-base-content/40">
          Your account is managed on
          <a href="https://apps.zveltio.com" target="_blank" rel="noopener" class="link">apps.zveltio.com</a>
        </p>

      </div>
    </div>
  </div>

<!-- ── Authenticated — catalog ────────────────────────────────────────────── -->
{:else}
  <div class="space-y-6">

    <PageHeader title="Marketplace" subtitle="Browse and install extensions">
      <!-- User info + logout -->
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2 text-sm text-base-content/60">
          <div class="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
            <User size={12} class="text-primary" />
          </div>
          <span class="hidden sm:inline">{authUser?.email}</span>
        </div>
        <button class="btn btn-ghost btn-sm gap-1" onclick={logout} title="Sign out">
          <LogOut size={14} />
          <span class="hidden sm:inline">Sign out</span>
        </button>
        <button class="btn btn-ghost btn-sm gap-1" onclick={loadCatalog} disabled={loading}>
          <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
    </PageHeader>

    {#if restartNeeded}
      <div class="alert alert-warning py-2 mb-4 text-sm">
        <span>Some extensions require a server restart to take effect.</span>
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
        placeholder="Search extensions..."
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
          All ({extensions.length})
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
          <div class="flex justify-center py-20">
            <span class="loading loading-spinner loading-lg text-primary"></span>
          </div>
        {:else if filtered.length === 0}
          <div class="text-center py-20 opacity-50">
            <Puzzle size={48} class="mx-auto mb-3" />
            <p>No extensions found</p>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {#each filtered as ext}
              {@const Icon = CATEGORY_ICONS[ext.category] ?? Puzzle}
              {@const iconColor = CATEGORY_COLORS[ext.category] ?? 'text-gray-400'}
              {@const isProcessing = processingId === ext.name}

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
                    {#if ext.is_running}
                      <span class="badge badge-success badge-sm shrink-0 gap-1">
                        <CheckCircle size={10} /> Running
                      </span>
                    {:else if ext.is_enabled && !ext.files_on_disk}
                      <span class="badge badge-error badge-sm shrink-0 gap-1" title="Extension package not deployed on this server">
                        <AlertTriangle size={10} /> Files missing
                      </span>
                    {:else if ext.is_enabled && ext.needs_restart}
                      <span class="badge badge-warning badge-sm shrink-0 gap-1">
                        <AlertTriangle size={10} /> Restart
                      </span>
                    {:else if ext.is_installed}
                      <span class="badge badge-ghost badge-sm shrink-0">Installed</span>
                    {:else}
                      <span class="badge badge-ghost badge-sm shrink-0 opacity-50">
                        <Circle size={10} /> Available
                      </span>
                    {/if}
                  </div>

                  <!-- Description -->
                  <p class="text-sm opacity-60 line-clamp-2 mb-3">{ext.description}</p>

                  <!-- Tags -->
                  <div class="flex flex-wrap gap-1 mb-4">
                    {#each ext.tags.slice(0, 3) as tag}
                      <span class="badge badge-xs badge-ghost">{tag}</span>
                    {/each}
                    {#if ext.bundled}
                      <span class="badge badge-xs badge-primary gap-1">
                        <Star size={8} /> Official
                      </span>
                    {/if}
                  </div>

                  <!-- Actions -->
                  <div class="flex items-center gap-2 mt-auto">
                    {#if isProcessing}
                      <span class="loading loading-spinner loading-sm text-primary"></span>

                    {:else if !ext.is_installed}
                      <button class="btn btn-primary btn-sm flex-1 gap-1" onclick={() => install(ext)}>
                        <Download size={14} /> Install
                      </button>

                    {:else if !ext.is_enabled && !ext.is_running}
                      <button class="btn btn-success btn-sm flex-1 gap-1" onclick={() => enable(ext)}>
                        <Power size={14} /> Enable
                      </button>
                      <button class="btn btn-ghost btn-sm" onclick={() => openConfig(ext)} title="Configure">
                        <Settings size={14} />
                      </button>
                      <button class="btn btn-ghost btn-sm text-error" onclick={() => uninstall(ext)} title="Uninstall">
                        <Trash2 size={14} />
                      </button>

                    {:else}
                      <button class="btn btn-ghost btn-sm flex-1 gap-1 text-error" onclick={() => disable(ext)}>
                        <PowerOff size={14} /> Disable
                      </button>
                      <button class="btn btn-ghost btn-sm" onclick={() => openConfig(ext)} title="Configure">
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
{/if}

<!-- Config modal -->
{#if configuringExt}
  <div class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-1">Configure {configuringExt.displayName}</h3>
      <p class="text-sm opacity-60 mb-3">
        JSON configuration for this extension. Changes take effect on next restart.
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
        <button class="btn btn-ghost" onclick={() => configuringExt = null}>Cancel</button>
        <button class="btn btn-primary" onclick={saveConfig}>Save Config</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => configuringExt = null}></button>
  </div>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
