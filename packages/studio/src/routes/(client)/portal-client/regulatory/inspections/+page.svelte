<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Search, Calendar, MapPin, ClipboardList, AlertTriangle, CheckCircle2, Clock } from '@lucide/svelte';

  let loading = $state(true);
  let items = $state<any[]>([]);
  let selected = $state<any>(null);

  onMount(async () => {
    try {
      const res = await api.get<{ inspections: any[] }>('/api/portal-client/inspections');
      items = res.inspections ?? [];
    } finally {
      loading = false;
    }
  });

  function statusLabel(s: string) {
    const m: Record<string, string> = {
      scheduled: 'Programat', in_progress: 'În desfășurare', completed: 'Finalizat', cancelled: 'Anulat',
    };
    return m[s] ?? s;
  }

  function statusBadge(s: string) {
    const m: Record<string, string> = {
      scheduled: 'badge-info', in_progress: 'badge-warning', completed: 'badge-success', cancelled: 'badge-ghost',
    };
    return m[s] ?? 'badge-ghost';
  }

  function resultBadge(r: string) {
    const m: Record<string, string> = {
      compliant: 'badge-success', non_compliant: 'badge-error', partially_compliant: 'badge-warning', na: 'badge-ghost',
    };
    return m[r] ?? 'badge-ghost';
  }

  function resultLabel(r: string) {
    const m: Record<string, string> = {
      compliant: 'Conform', non_compliant: 'Neconform', partially_compliant: 'Parțial conform', na: 'N/A',
    };
    return m[r] ?? r;
  }

  function fmtDate(d: string) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
</script>

<div class="max-w-5xl">
  <div class="mb-6">
    <h1 class="text-xl font-bold text-base-content flex items-center gap-2">
      <Search size={20} class="text-primary" /> Controale
    </h1>
    <p class="text-sm text-base-content/50 mt-0.5">Controalele efectuate la punctele de lucru ale firmei tale</p>
  </div>

  <div class="alert bg-base-200 border border-base-300 text-sm mb-6">
    <AlertTriangle size={16} class="text-warning shrink-0" />
    <span>Controalele sunt înregistrate de instituție și sunt doar în citire. Contactează-ne pentru clarificări.</span>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md text-primary"></span></div>
  {:else if items.length === 0}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body items-center text-center py-16">
        <Search size={40} class="text-base-content/20 mb-3" />
        <p class="font-medium text-sm text-base-content/60">Niciun control înregistrat</p>
        <p class="text-xs text-base-content/40 mt-1">Controalele efectuate de instituție vor apărea aici.</p>
      </div>
    </div>
  {:else}
    <div class="grid gap-4">
      {#each items as item}
        <div class="card bg-base-200 border border-base-300 hover:border-primary/30 transition-colors">
          <div class="card-body p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-semibold text-sm">{item.inspection_type ?? 'Control'}</span>
                  <span class="badge badge-sm {statusBadge(item.status)}">{statusLabel(item.status)}</span>
                  {#if item.result}
                    <span class="badge badge-sm {resultBadge(item.result)}">{resultLabel(item.result)}</span>
                  {/if}
                </div>

                <div class="flex items-center gap-4 mt-2 flex-wrap">
                  {#if item.scheduled_date}
                    <span class="flex items-center gap-1 text-xs text-base-content/50">
                      <Calendar size={12} /> {fmtDate(item.scheduled_date)}
                    </span>
                  {/if}
                  {#if item.location_name}
                    <span class="flex items-center gap-1 text-xs text-base-content/50">
                      <MapPin size={12} /> {item.location_name}
                    </span>
                  {/if}
                  {#if item.inspector_name}
                    <span class="flex items-center gap-1 text-xs text-base-content/50">
                      <ClipboardList size={12} /> {item.inspector_name}
                    </span>
                  {/if}
                </div>
              </div>

              <button
                class="btn btn-ghost btn-xs text-primary"
                onclick={() => selected = selected?.id === item.id ? null : item}
              >
                {selected?.id === item.id ? 'Închide' : 'Detalii'}
              </button>
            </div>

            {#if selected?.id === item.id}
              <div class="divider my-2"></div>
              <div class="grid sm:grid-cols-2 gap-4 text-sm">
                {#if item.findings}
                  <div class="sm:col-span-2">
                    <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-1">Constatări</p>
                    <p class="text-sm text-base-content/80 leading-relaxed">{item.findings}</p>
                  </div>
                {/if}
                {#if item.remediation_deadline}
                  <div>
                    <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-1">Termen remediere</p>
                    <p class="text-sm flex items-center gap-1.5">
                      <Clock size={13} class="text-warning" />
                      {fmtDate(item.remediation_deadline)}
                    </p>
                  </div>
                {/if}
                {#if item.notes}
                  <div class="sm:col-span-2">
                    <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-1">Note</p>
                    <p class="text-sm text-base-content/70">{item.notes}</p>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
