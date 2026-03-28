<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import {
    Ticket, Bell, Building2, FileCheck, Search, MessageSquare,
    Clock, CheckCircle, AlertCircle, ChevronRight, Loader
  } from '@lucide/svelte';

  let loading = $state(true);
  let config = $state<any>({ template: 'generic' });
  let me = $state<any>(null);
  let tickets = $state<any[]>([]);
  let notifications = $state<any[]>([]);

  // Regulatory-specific
  let authorizations = $state<any[]>([]);
  let inspections = $state<any[]>([]);
  let requests = $state<any[]>([]);

  onMount(async () => {
    try {
      const [cfgRes, meRes] = await Promise.all([
        api.get<{ config: any }>('/api/portal-client/config'),
        api.get<any>('/api/portal-client/me'),
      ]);
      if (cfgRes.config) config = cfgRes.config;
      me = meRes;

      const [tRes, nRes] = await Promise.all([
        api.get<{ tickets: any[] }>('/api/portal-client/tickets?limit=5'),
        api.get<{ notifications: any[] }>('/api/notifications?limit=5&unread_only=true').catch(() => ({ notifications: [] })),
      ]);
      tickets = tRes.tickets ?? [];
      notifications = nRes.notifications ?? [];

      if (config.template === 'regulatory') {
        const [aRes, iRes, rRes] = await Promise.all([
          api.get<{ authorizations: any[] }>('/api/portal-client/authorizations?limit=5'),
          api.get<{ inspections: any[] }>('/api/portal-client/inspections?limit=5'),
          api.get<{ requests: any[] }>('/api/portal-client/requests?limit=5'),
        ]);
        authorizations = aRes.authorizations ?? [];
        inspections = iRes.inspections ?? [];
        requests = rRes.requests ?? [];
      }
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
    }
  });

  function statusBadge(status: string) {
    const map: Record<string, string> = {
      open: 'badge-warning',
      in_progress: 'badge-info',
      resolved: 'badge-success',
      closed: 'badge-ghost',
      submitted: 'badge-info',
      under_review: 'badge-warning',
      approved: 'badge-success',
      rejected: 'badge-error',
      needs_info: 'badge-warning',
      expired: 'badge-ghost',
      draft: 'badge-ghost',
      scheduled: 'badge-info',
      completed: 'badge-success',
    };
    return map[status] ?? 'badge-ghost';
  }

  function fmtDate(d: string) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
</script>

{#if loading}
  <div class="flex items-center justify-center h-48">
    <span class="loading loading-spinner loading-md text-primary"></span>
  </div>
{:else}
  <!-- Greeting -->
  <div class="mb-6">
    <h1 class="text-2xl font-bold text-base-content">
      Bună ziua, {me?.user?.name?.split(' ')[0] ?? 'utilizator'}
    </h1>
    <p class="text-sm text-base-content/50 mt-1">
      {new Date().toLocaleDateString('ro-RO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
    </p>
  </div>

  {#if config.template === 'regulatory'}
    <!-- ─── Regulatory Dashboard ──────────────────── -->

    <!-- Operator info -->
    {#if me?.operators?.length}
      <div class="alert bg-base-200 border border-base-300 mb-6">
        <Building2 size={18} class="text-primary shrink-0" />
        <div>
          <p class="font-semibold text-sm">{me.operators[0].name}</p>
          <p class="text-xs text-base-content/50">CUI: {me.operators[0].fiscal_code} · {me.operators[0].county ?? ''}</p>
        </div>
        {#if !me.operators[0].is_verified}
          <span class="badge badge-warning badge-sm ml-auto">Neconfirmat</span>
        {/if}
      </div>
    {:else}
      <div class="alert alert-warning mb-6 text-sm">
        <AlertCircle size={16} />
        <span>Nu ești asociat cu niciun operator economic. <a href="/portal-client/profile" class="link">Înregistrează-te</a></span>
      </div>
    {/if}

    <!-- Stats row -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-primary"><FileCheck size={22} /></div>
        <div class="stat-title text-xs">Autorizații</div>
        <div class="stat-value text-xl">{authorizations.length}</div>
      </div>
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-warning"><Search size={22} /></div>
        <div class="stat-title text-xs">Controale</div>
        <div class="stat-value text-xl">{inspections.length}</div>
      </div>
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-info"><MessageSquare size={22} /></div>
        <div class="stat-title text-xs">Cereri</div>
        <div class="stat-value text-xl">{requests.length}</div>
      </div>
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-secondary"><Ticket size={22} /></div>
        <div class="stat-title text-xs">Suport</div>
        <div class="stat-value text-xl">{tickets.length}</div>
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-6">

      <!-- Recent Authorizations -->
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-semibold text-sm flex items-center gap-2"><FileCheck size={15} />Autorizații recente</h2>
            <a href="/portal-client/regulatory/authorizations" class="text-xs text-primary hover:underline flex items-center gap-1">
              Vezi toate <ChevronRight size={12} />
            </a>
          </div>
          {#if authorizations.length === 0}
            <p class="text-xs text-base-content/40 text-center py-4">Nicio autorizație înregistrată</p>
          {:else}
            <div class="space-y-2">
              {#each authorizations.slice(0, 4) as a}
                <div class="flex items-center justify-between py-1.5 border-b border-base-300 last:border-0">
                  <div class="min-w-0">
                    <p class="text-xs font-medium truncate">{a.authorization_type ?? 'Autorizație'}</p>
                    <p class="text-[11px] text-base-content/40">{a.reference_number ?? '—'}</p>
                  </div>
                  <span class="badge badge-sm {statusBadge(a.status)} shrink-0 ml-2">{a.status}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <!-- Recent Inspections -->
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-semibold text-sm flex items-center gap-2"><Search size={15} />Controale recente</h2>
            <a href="/portal-client/regulatory/inspections" class="text-xs text-primary hover:underline flex items-center gap-1">
              Vezi toate <ChevronRight size={12} />
            </a>
          </div>
          {#if inspections.length === 0}
            <p class="text-xs text-base-content/40 text-center py-4">Niciun control înregistrat</p>
          {:else}
            <div class="space-y-2">
              {#each inspections.slice(0, 4) as i}
                <div class="flex items-center justify-between py-1.5 border-b border-base-300 last:border-0">
                  <div class="min-w-0">
                    <p class="text-xs font-medium truncate">{i.inspection_type ?? 'Control'}</p>
                    <p class="text-[11px] text-base-content/40">{fmtDate(i.scheduled_date)}</p>
                  </div>
                  <span class="badge badge-sm {statusBadge(i.status)} shrink-0 ml-2">{i.status}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>

    </div>

  {:else}
    <!-- ─── Generic / SaaS / Services Dashboard ──── -->
    <div class="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-primary"><Ticket size={22} /></div>
        <div class="stat-title text-xs">Tichete deschise</div>
        <div class="stat-value text-xl">{tickets.filter(t => t.status === 'open').length}</div>
      </div>
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-success"><CheckCircle size={22} /></div>
        <div class="stat-title text-xs">Rezolvate</div>
        <div class="stat-value text-xl">{tickets.filter(t => t.status === 'resolved' || t.status === 'closed').length}</div>
      </div>
      <div class="stat bg-base-200 border border-base-300 rounded-xl p-4">
        <div class="stat-figure text-warning"><Bell size={22} /></div>
        <div class="stat-title text-xs">Notificări</div>
        <div class="stat-value text-xl">{notifications.length}</div>
      </div>
    </div>

    <!-- Recent tickets -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-semibold text-sm flex items-center gap-2"><Ticket size={15} />Tichete recente</h2>
          <a href="/portal-client/tickets" class="text-xs text-primary hover:underline flex items-center gap-1">
            Vezi toate <ChevronRight size={12} />
          </a>
        </div>
        {#if tickets.length === 0}
          <p class="text-xs text-base-content/40 text-center py-6">Niciun tichet deschis</p>
        {:else}
          <div class="space-y-1">
            {#each tickets.slice(0, 6) as t}
              <a href="/portal-client/tickets"
                class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-base-300 transition-colors group">
                <div class="min-w-0">
                  <p class="text-xs font-medium truncate group-hover:text-primary transition-colors">{t.subject}</p>
                  <p class="text-[11px] text-base-content/40">{fmtDate(t.created_at)}</p>
                </div>
                <span class="badge badge-sm {statusBadge(t.status)} shrink-0 ml-2">{t.status}</span>
              </a>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}
