<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { base } from '$app/paths';
  import {
    Settings, Save, AlertCircle, CheckCircle, Users,
    ShieldCheck, Eye, ExternalLink, ToggleLeft, ToggleRight,
  } from '@lucide/svelte';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state(false);
  let tab = $state<'config' | 'operators'>('config');

  let config = $state({
    is_enabled: false,
    template: 'generic',
    site_name: 'Client Portal',
    site_logo: '',
    primary_color: '#069494',
  });

  let operators = $state<any[]>([]);
  let opLoading = $state(false);

  const TEMPLATES = [
    { value: 'generic',    label: 'Generic',       desc: 'Simple portal with support tickets and profile' },
    { value: 'saas',       label: 'SaaS',           desc: 'Subscription management, support, account' },
    { value: 'services',   label: 'Services',       desc: 'Portal for professional services companies' },
    { value: 'regulatory', label: 'Regulatory',     desc: 'Authorizations, inspections, business locations' },
  ];

  function extractError(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object') {
      const obj = e as Record<string, unknown>;
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.error === 'string') return obj.error;
    }
    return 'An unexpected error occurred.';
  }

  onMount(async () => {
    try {
      const res = await api.get<{ config: any }>('/api/portal-client/admin/config');
      if (res?.config) config = { ...config, ...res.config };
    } catch {
      // config stays at defaults — portal not yet configured
    } finally {
      loading = false;
    }
  });

  async function save() {
    saving = true; error = ''; success = false;
    try {
      await api.patch('/api/portal-client/admin/config', config);
      success = true;
      setTimeout(() => (success = false), 3000);
    } catch (e) {
      error = extractError(e);
    } finally {
      saving = false;
    }
  }

  async function loadOperators() {
    opLoading = true;
    try {
      const res = await api.get<{ operators: any[] }>('/api/portal-client/admin/operators');
      operators = res?.operators ?? [];
    } catch {
      operators = [];
    } finally {
      opLoading = false;
    }
  }

  async function verifyUser(operatorId: string, userId: string) {
    try {
      await api.patch(`/api/portal-client/admin/operators/${operatorId}/verify-user/${userId}`, {});
      await loadOperators();
    } catch (e) {
      alert(extractError(e));
    }
  }

  $effect(() => {
    if (tab === 'operators') loadOperators();
  });
</script>

<div class="max-w-3xl">
  <div class="mb-6">
    <h1 class="text-xl font-bold text-base-content flex items-center gap-2">
      <Settings size={20} class="text-primary" /> Client Portal
    </h1>
    <p class="text-sm text-base-content/50 mt-0.5">Configure the client-facing portal for your organisation</p>
  </div>

  <!-- Tabs -->
  <div class="tabs tabs-bordered mb-6">
    <button class="tab {tab === 'config' ? 'tab-active' : ''}" onclick={() => (tab = 'config')}>Configuration</button>
    <button class="tab {tab === 'operators' ? 'tab-active' : ''}" onclick={() => (tab = 'operators')}>Operators</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md text-primary"></span></div>

  {:else if tab === 'config'}
    <!-- Status banner -->
    {#if config.is_enabled}
      <div class="alert bg-success/10 border border-success/20 text-sm mb-6">
        <Eye size={15} class="text-success" />
        <span class="text-base-content/70">Portal is active.</span>
        <a href="{base}/portal-client/login" target="_blank" class="btn btn-xs btn-success gap-1 ml-auto">
          <ExternalLink size={12} /> Open portal
        </a>
      </div>
    {:else}
      <div class="alert bg-base-200 border border-base-300 text-sm mb-6">
        <Eye size={15} class="text-base-content/30" />
        <span class="text-base-content/50">Portal is disabled. Enable it using the toggle below.</span>
      </div>
    {/if}

    {#if error}
      <div class="alert alert-error text-sm py-2 mb-4"><AlertCircle size={14} /><span>{error}</span></div>
    {/if}
    {#if success}
      <div class="alert alert-success text-sm py-2 mb-4"><CheckCircle size={14} /><span>Configuration saved.</span></div>
    {/if}

    <div class="space-y-5">
      <!-- Enable toggle -->
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 flex-row items-center justify-between">
          <div>
            <p class="font-semibold text-sm">Enable portal</p>
            <p class="text-xs text-base-content/50">
              Clients can access the portal at <code class="bg-base-300 px-1 rounded">/portal-client/login</code>
            </p>
          </div>
          <button onclick={() => (config.is_enabled = !config.is_enabled)} class="transition-colors">
            {#if config.is_enabled}
              <ToggleRight size={32} class="text-primary" />
            {:else}
              <ToggleLeft size={32} class="text-base-content/30" />
            {/if}
          </button>
        </div>
      </div>

      <!-- Template -->
      <div>
        <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-3">Portal template</p>
        <div class="grid sm:grid-cols-2 gap-3">
          {#each TEMPLATES as tmpl}
            <button
              class="card border-2 text-left transition-all {config.template === tmpl.value ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-200 hover:border-primary/40'}"
              onclick={() => (config.template = tmpl.value)}
            >
              <div class="card-body p-3.5 gap-1">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full {config.template === tmpl.value ? 'bg-primary' : 'bg-base-300'}"></span>
                  <span class="font-semibold text-sm">{tmpl.label}</span>
                </div>
                <p class="text-xs text-base-content/50 pl-4">{tmpl.desc}</p>
              </div>
            </button>
          {/each}
        </div>
      </div>

      <!-- Branding -->
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-5 gap-4">
          <p class="font-semibold text-sm">Branding</p>

          <div class="grid sm:grid-cols-2 gap-4">
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs font-medium">Portal name</span></label>
              <input type="text" bind:value={config.site_name} class="input input-sm" placeholder="Client Portal" />
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs font-medium">Primary colour</span></label>
              <div class="flex gap-2">
                <input type="color" bind:value={config.primary_color} class="w-10 h-8 rounded border border-base-300 cursor-pointer p-0.5" />
                <input type="text" bind:value={config.primary_color} class="input input-sm flex-1 font-mono text-xs" placeholder="#069494" />
              </div>
            </div>
            <div class="form-control gap-1 sm:col-span-2">
              <label class="label py-0"><span class="label-text text-xs font-medium">Logo URL <span class="text-base-content/40">(optional)</span></span></label>
              <input type="url" bind:value={config.site_logo} class="input input-sm" placeholder="https://…" />
            </div>
          </div>

          <!-- Live preview -->
          <div class="mt-1">
            <p class="text-xs text-base-content/40 mb-2">Portal header preview:</p>
            <div class="flex items-center gap-3 bg-base-100 rounded-xl px-4 py-3 border border-base-300">
              <div class="w-8 h-8 rounded-lg flex items-center justify-center" style="background-color: {config.primary_color}">
                <span class="text-white font-bold text-sm leading-none">
                  {config.site_name?.[0]?.toUpperCase() ?? 'P'}
                </span>
              </div>
              <div>
                <p class="font-semibold text-sm leading-none">{config.site_name || 'Client Portal'}</p>
                <p class="text-[11px] text-base-content/40 mt-0.5 capitalize">{config.template} template</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex justify-end mt-6">
      <button class="btn btn-primary gap-1.5" onclick={save} disabled={saving}>
        {#if saving}<span class="loading loading-spinner loading-sm"></span>
        {:else}<Save size={15} />{/if}
        Save configuration
      </button>
    </div>

  {:else if tab === 'operators'}
    {#if opLoading}
      <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md text-primary"></span></div>
    {:else if operators.length === 0}
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body items-center text-center py-16">
          <Users size={40} class="text-base-content/20 mb-3" />
          <p class="font-medium text-sm text-base-content/60">No operators registered</p>
          <p class="text-xs text-base-content/40 mt-1">Businesses that register through the portal will appear here.</p>
        </div>
      </div>
    {:else}
      <div class="flex flex-col gap-4">
        {#each operators as op}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="font-semibold text-sm">{op.name}</p>
                  <p class="text-xs text-base-content/50">
                    Tax ID: {op.fiscal_code}{op.legal_form ? ` · ${op.legal_form}` : ''}
                  </p>
                  {#if op.address}
                    <p class="text-xs text-base-content/50">{op.address}{op.county ? `, ${op.county}` : ''}</p>
                  {/if}
                </div>
              </div>

              {#if op.users?.length}
                <div>
                  <p class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-2">Associated users</p>
                  <div class="space-y-1.5">
                    {#each op.users as u}
                      <div class="flex items-center justify-between bg-base-100 rounded-lg px-3 py-2">
                        <div>
                          <p class="text-xs font-medium">{u.name}</p>
                          <p class="text-[11px] text-base-content/40">{u.email} · {u.role}</p>
                        </div>
                        {#if u.is_verified}
                          <span class="badge badge-success badge-xs gap-1">
                            <ShieldCheck size={10} /> Verified
                          </span>
                        {:else}
                          <button class="btn btn-xs btn-warning gap-1" onclick={() => verifyUser(op.id, u.user_id)}>
                            <ShieldCheck size={11} /> Verify
                          </button>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
