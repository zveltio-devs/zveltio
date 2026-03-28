<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { FileCheck, Plus, X, ChevronRight, AlertCircle, Send, Clock } from '@lucide/svelte';

  let loading = $state(true);
  let items = $state<any[]>([]);
  let showForm = $state(false);
  let submitting = $state(false);
  let error = $state('');
  let selected = $state<any>(null);
  let operatorId = $state('');

  // Form state
  let form = $state({
    authorization_type: '',
    title: '',
    location_id: '',
    description: '',
  });
  let locations = $state<any[]>([]);

  async function load() {
    loading = true;
    try {
      const [aRes, lRes, meRes] = await Promise.all([
        api.get<{ authorizations: any[] }>('/api/portal-client/authorizations'),
        api.get<{ locations: any[] }>('/api/portal-client/locations'),
        api.get<any>('/api/portal-client/me'),
      ]);
      items = aRes.authorizations ?? [];
      locations = lRes.locations ?? [];
      operatorId = meRes.operators?.[0]?.id ?? '';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function submit() {
    if (!form.authorization_type.trim()) { error = 'Tipul autorizației este obligatoriu.'; return; }
    if (!operatorId) { error = 'Nu ești asociat cu niciun operator. Înregistrează firma din Profil.'; return; }
    submitting = true; error = '';
    try {
      await api.post('/api/portal-client/authorizations', {
        ...form,
        title: form.title || form.authorization_type,
        operator_id: operatorId,
        location_id: form.location_id || undefined,
      });
      form = { authorization_type: '', title: '', location_id: '', description: '' };
      showForm = false;
      await load();
    } catch (e: any) {
      error = e.message || 'Eroare la salvare.';
    } finally {
      submitting = false; }
  }

  async function submitForReview(id: string) {
    try {
      await api.post(`/api/portal-client/authorizations/${id}/submit`, {});
      await load();
    } catch (e: any) {
      alert(e.message || 'Eroare.');
    }
  }

  function statusLabel(s: string) {
    const m: Record<string, string> = {
      draft: 'Ciornă', submitted: 'Transmisă', under_review: 'În analiză',
      approved: 'Aprobată', rejected: 'Respinsă', needs_info: 'Info suplim.',
      expired: 'Expirată',
    };
    return m[s] ?? s;
  }

  function statusBadge(s: string) {
    const m: Record<string, string> = {
      draft: 'badge-ghost', submitted: 'badge-info', under_review: 'badge-warning',
      approved: 'badge-success', rejected: 'badge-error', needs_info: 'badge-warning', expired: 'badge-ghost',
    };
    return m[s] ?? 'badge-ghost';
  }

  function fmtDate(d: string) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
</script>

<div class="max-w-4xl">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-xl font-bold text-base-content flex items-center gap-2">
        <FileCheck size={20} class="text-primary" /> Autorizații
      </h1>
      <p class="text-sm text-base-content/50 mt-0.5">Gestionează cererile de autorizare</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1.5" onclick={() => { showForm = true; error = ''; }}>
      <Plus size={15} /> Cerere nouă
    </button>
  </div>

  <!-- New authorization form -->
  {#if showForm}
    <div class="card bg-base-200 border border-base-300 mb-6">
      <div class="card-body p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-semibold text-sm">Cerere nouă de autorizare</h2>
          <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
        </div>

        {#if error}
          <div class="alert alert-error text-sm py-2 mb-3"><AlertCircle size={15} /><span>{error}</span></div>
        {/if}

        <div class="grid sm:grid-cols-2 gap-4">
          <div class="form-control gap-1 sm:col-span-2">
            <label class="label py-0"><span class="label-text text-xs font-medium">Tip autorizație *</span></label>
            <input type="text" bind:value={form.authorization_type}
              placeholder="ex. Autorizație funcționare, Licență transport..."
              class="input input-sm" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Punct de lucru</span></label>
            <select class="select select-sm" bind:value={form.location_id}>
              <option value="">— Selectează —</option>
              {#each locations as loc}
                <option value={loc.id}>{loc.name} ({loc.address})</option>
              {/each}
            </select>
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Valabilitate de la</span></label>
            <input type="date" bind:value={form.valid_from} class="input input-sm" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Valabilitate până la</span></label>
            <input type="date" bind:value={form.valid_until} class="input input-sm" />
          </div>
          <div class="form-control gap-1 sm:col-span-2">
            <label class="label py-0"><span class="label-text text-xs font-medium">Descriere / mențiuni</span></label>
            <textarea class="textarea textarea-sm h-20 resize-none" bind:value={form.description}
              placeholder="Detalii suplimentare, documente anexate etc."></textarea>
          </div>
        </div>

        <div class="flex gap-2 mt-4 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Anulează</button>
          <button class="btn btn-primary btn-sm" onclick={submit} disabled={submitting}>
            {#if submitting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Salvează ca ciornă
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
        <FileCheck size={40} class="text-base-content/20 mb-3" />
        <p class="font-medium text-sm text-base-content/60">Nicio autorizație înregistrată</p>
        <p class="text-xs text-base-content/40 mt-1">Apasă „Cerere nouă" pentru a iniția o cerere de autorizare.</p>
      </div>
    </div>
  {:else}
    <div class="card bg-base-200 border border-base-300 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr class="border-base-300">
              <th class="text-xs font-semibold">Tip autorizație</th>
              <th class="text-xs font-semibold">Nr. referință</th>
              <th class="text-xs font-semibold">Punct de lucru</th>
              <th class="text-xs font-semibold">Data depunerii</th>
              <th class="text-xs font-semibold">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each items as item}
              <tr class="border-base-300 hover:bg-base-300/50 transition-colors">
                <td class="font-medium text-xs">{item.authorization_type}</td>
                <td class="text-xs text-base-content/60">{item.reference_number ?? '—'}</td>
                <td class="text-xs text-base-content/60">{item.location_name ?? '—'}</td>
                <td class="text-xs text-base-content/60">{fmtDate(item.submitted_at ?? item.created_at)}</td>
                <td>
                  <span class="badge badge-sm {statusBadge(item.status)}">{statusLabel(item.status)}</span>
                </td>
                <td class="text-right">
                  {#if item.status === 'draft'}
                    <button class="btn btn-xs btn-primary gap-1"
                      onclick={() => submitForReview(item.id)}>
                      <Send size={11} /> Transmite
                    </button>
                  {/if}
                </td>
              </tr>
              {#if item.rejection_reason}
                <tr class="bg-error/5 border-base-300">
                  <td colspan="6" class="text-xs text-error px-4 py-1.5 flex items-center gap-1.5">
                    <AlertCircle size={12} />
                    <span class="font-medium">Motiv respingere:</span> {item.rejection_reason}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
