<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { MessageSquare, Plus, X, AlertCircle, ChevronDown, ChevronUp } from '@lucide/svelte';

  let loading = $state(true);
  let items = $state<any[]>([]);
  let showForm = $state(false);
  let submitting = $state(false);
  let error = $state('');
  let expandedId = $state<string | null>(null);

  let form = $state({ request_type: '', subject: '', description: '' });

  const REQUEST_TYPES = [
    'Solicitare informații',
    'Clarificare procedură',
    'Contestație',
    'Prelungire termen',
    'Modificare date',
    'Altele',
  ];

  async function load() {
    loading = true;
    try {
      const res = await api.get<{ requests: any[] }>('/api/portal-client/requests');
      items = res.requests ?? [];
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function submit() {
    if (!form.request_type || !form.subject.trim()) {
      error = 'Tipul și subiectul cererii sunt obligatorii.'; return;
    }
    submitting = true; error = '';
    try {
      await api.post('/api/portal-client/requests', form);
      form = { request_type: '', subject: '', description: '' };
      showForm = false;
      await load();
    } catch (e: any) {
      error = e.message || 'Eroare la trimitere.';
    } finally {
      submitting = false;
    }
  }

  function statusLabel(s: string) {
    const m: Record<string, string> = {
      open: 'Deschisă', in_progress: 'În procesare', resolved: 'Rezolvată', closed: 'Închisă',
    };
    return m[s] ?? s;
  }

  function statusBadge(s: string) {
    const m: Record<string, string> = {
      open: 'badge-info', in_progress: 'badge-warning', resolved: 'badge-success', closed: 'badge-ghost',
    };
    return m[s] ?? 'badge-ghost';
  }

  function fmtDate(d: string) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
</script>

<div class="max-w-3xl">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-xl font-bold text-base-content flex items-center gap-2">
        <MessageSquare size={20} class="text-primary" /> Cereri
      </h1>
      <p class="text-sm text-base-content/50 mt-0.5">Cererile și solicitările transmise către instituție</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1.5" onclick={() => { showForm = true; error = ''; }}>
      <Plus size={15} /> Cerere nouă
    </button>
  </div>

  <!-- Form -->
  {#if showForm}
    <div class="card bg-base-200 border border-base-300 mb-6">
      <div class="card-body p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-semibold text-sm">Cerere nouă</h2>
          <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
        </div>

        {#if error}
          <div class="alert alert-error text-sm py-2 mb-3"><AlertCircle size={15} /><span>{error}</span></div>
        {/if}

        <div class="flex flex-col gap-4">
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Tip cerere *</span></label>
            <select class="select select-sm" bind:value={form.request_type}>
              <option value="">— Selectează tipul —</option>
              {#each REQUEST_TYPES as t}
                <option value={t}>{t}</option>
              {/each}
            </select>
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Subiect *</span></label>
            <input type="text" bind:value={form.subject}
              placeholder="Descrie pe scurt cererea ta"
              class="input input-sm" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Descriere detaliată</span></label>
            <textarea class="textarea textarea-sm h-28 resize-none" bind:value={form.description}
              placeholder="Detalii, documente relevante, termene etc."></textarea>
          </div>
        </div>

        <div class="flex gap-2 mt-4 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Anulează</button>
          <button class="btn btn-primary btn-sm" onclick={submit} disabled={submitting}>
            {#if submitting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Trimite cererea
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- List -->
  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md text-primary"></span></div>
  {:else if items.length === 0}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body items-center text-center py-16">
        <MessageSquare size={40} class="text-base-content/20 mb-3" />
        <p class="font-medium text-sm text-base-content/60">Nicio cerere transmisă</p>
        <p class="text-xs text-base-content/40 mt-1">Cererile adresate instituției vor apărea aici.</p>
      </div>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each items as item}
        <div class="card bg-base-200 border border-base-300">
          <button
            class="card-body p-4 flex-row items-start justify-between gap-3 text-left"
            onclick={() => expandedId = expandedId === item.id ? null : item.id}
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-sm truncate">{item.subject}</span>
                <span class="badge badge-sm {statusBadge(item.status)} shrink-0">{statusLabel(item.status)}</span>
              </div>
              <div class="flex items-center gap-3 mt-1">
                <span class="text-xs text-base-content/40">{item.request_type}</span>
                <span class="text-xs text-base-content/30">·</span>
                <span class="text-xs text-base-content/40">{item.reference_number ?? '—'}</span>
                <span class="text-xs text-base-content/30">·</span>
                <span class="text-xs text-base-content/40">{fmtDate(item.created_at)}</span>
              </div>
            </div>
            {#if expandedId === item.id}
              <ChevronUp size={15} class="text-base-content/40 shrink-0 mt-1" />
            {:else}
              <ChevronDown size={15} class="text-base-content/40 shrink-0 mt-1" />
            {/if}
          </button>

          {#if expandedId === item.id && item.description}
            <div class="px-4 pb-4 -mt-2">
              <div class="divider mt-0 mb-3"></div>
              <p class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-1.5">Descriere</p>
              <p class="text-sm text-base-content/70 leading-relaxed whitespace-pre-line">{item.description}</p>
              {#if item.resolution_notes}
                <div class="mt-3 p-3 rounded-lg bg-success/10 border border-success/20">
                  <p class="text-xs font-semibold text-success mb-1">Răspuns instituție</p>
                  <p class="text-sm text-base-content/80 leading-relaxed whitespace-pre-line">{item.resolution_notes}</p>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
