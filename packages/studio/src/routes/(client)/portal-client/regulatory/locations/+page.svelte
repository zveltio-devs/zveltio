<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { MapPin, Plus, X, Edit2, Trash2, AlertCircle } from '@lucide/svelte';

  let loading = $state(true);
  let items = $state<any[]>([]);
  let showForm = $state(false);
  let editing = $state<any>(null);
  let submitting = $state(false);
  let error = $state('');

  let operatorId = $state('');

  const emptyForm = () => ({
    name: '', address: '', county: '', activity_code: '', location_type: 'sediu_secundar',
  });
  let form = $state(emptyForm());

  const LOCATION_TYPES: Record<string, string> = {
    sediu_secundar: 'Sediu secundar',
    punct_de_lucru: 'Punct de lucru',
    depozit: 'Depozit',
    showroom: 'Showroom',
    atelier: 'Atelier',
    alte: 'Altele',
  };

  async function load() {
    loading = true;
    try {
      const [lRes, meRes] = await Promise.all([
        api.get<{ locations: any[] }>('/api/portal-client/locations'),
        api.get<any>('/api/portal-client/me'),
      ]);
      items = lRes.locations ?? [];
      operatorId = meRes.operators?.[0]?.id ?? '';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openNew() {
    editing = null;
    form = emptyForm();
    error = '';
    showForm = true;
  }

  function openEdit(item: any) {
    editing = item;
    form = {
      name: item.name ?? '',
      address: item.address ?? '',
      county: item.county ?? '',
      activity_code: item.activity_code ?? '',
      location_type: item.location_type ?? 'sediu_secundar',
    };
    error = '';
    showForm = true;
  }

  async function save() {
    if (!form.name.trim() || !form.address.trim()) {
      error = 'Denumirea și adresa sunt obligatorii.'; return;
    }
    if (!editing && !operatorId) {
      error = 'Nu ești asociat cu niciun operator. Înregistrează firma din Profil.'; return;
    }
    submitting = true; error = '';
    try {
      if (editing) {
        await api.patch(`/api/portal-client/locations/${editing.id}`, form);
      } else {
        await api.post('/api/portal-client/locations', { ...form, operator_id: operatorId });
      }
      showForm = false;
      await load();
    } catch (e: any) {
      error = e.message || 'Eroare la salvare.';
    } finally {
      submitting = false;
    }
  }

  async function remove(id: string) {
    if (!confirm('Ștergi acest punct de lucru?')) return;
    try {
      await api.delete(`/api/portal-client/locations/${id}`);
      await load();
    } catch (e: any) {
      alert(e.message || 'Eroare la ștergere.');
    }
  }
</script>

<div class="max-w-3xl">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-xl font-bold text-base-content flex items-center gap-2">
        <MapPin size={20} class="text-primary" /> Puncte de lucru
      </h1>
      <p class="text-sm text-base-content/50 mt-0.5">Locațiile firmei înregistrate la instituție</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1.5" onclick={openNew}>
      <Plus size={15} /> Adaugă
    </button>
  </div>

  <!-- Form -->
  {#if showForm}
    <div class="card bg-base-200 border border-base-300 mb-6">
      <div class="card-body p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-semibold text-sm">{editing ? 'Editează punct de lucru' : 'Punct de lucru nou'}</h2>
          <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
        </div>

        {#if error}
          <div class="alert alert-error text-sm py-2 mb-3"><AlertCircle size={15} /><span>{error}</span></div>
        {/if}

        <div class="grid sm:grid-cols-2 gap-4">
          <div class="form-control gap-1 sm:col-span-2">
            <label class="label py-0"><span class="label-text text-xs font-medium">Denumire *</span></label>
            <input type="text" bind:value={form.name} placeholder="ex. Punct de lucru Cluj-Napoca" class="input input-sm" />
          </div>
          <div class="form-control gap-1 sm:col-span-2">
            <label class="label py-0"><span class="label-text text-xs font-medium">Adresă *</span></label>
            <input type="text" bind:value={form.address} placeholder="Str. Exemplu nr. 1" class="input input-sm" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Județ</span></label>
            <input type="text" bind:value={form.county} placeholder="Cluj" class="input input-sm" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Cod CAEN</span></label>
            <input type="text" bind:value={form.activity_code} placeholder="4711" class="input input-sm" maxlength="6" />
          </div>
          <div class="form-control gap-1">
            <label class="label py-0"><span class="label-text text-xs font-medium">Tip locație</span></label>
            <select class="select select-sm" bind:value={form.location_type}>
              {#each Object.entries(LOCATION_TYPES) as [v, l]}
                <option value={v}>{l}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="flex gap-2 mt-4 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Anulează</button>
          <button class="btn btn-primary btn-sm" onclick={save} disabled={submitting}>
            {#if submitting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Salvează
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
        <MapPin size={40} class="text-base-content/20 mb-3" />
        <p class="font-medium text-sm text-base-content/60">Niciun punct de lucru înregistrat</p>
        <p class="text-xs text-base-content/40 mt-1">Adaugă locațiile firmei tale pentru a le asocia la autorizații și controale.</p>
      </div>
    </div>
  {:else}
    <div class="grid gap-3">
      {#each items as item}
        <div class="card bg-base-200 border border-base-300 hover:border-primary/30 transition-colors">
          <div class="card-body p-4 flex-row items-start justify-between gap-3">
            <div class="flex items-start gap-3 min-w-0">
              <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <MapPin size={16} class="text-primary" />
              </div>
              <div class="min-w-0">
                <p class="font-semibold text-sm">{item.name}</p>
                <p class="text-xs text-base-content/60 mt-0.5">{item.address}{item.county ? `, ${item.county}` : ''}</p>
                <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                  {#if item.location_type}
                    <span class="badge badge-sm badge-ghost">{LOCATION_TYPES[item.location_type] ?? item.location_type}</span>
                  {/if}
                  {#if item.activity_code}
                    <span class="text-xs text-base-content/40">CAEN: {item.activity_code}</span>
                  {/if}
                </div>
              </div>
            </div>
            <div class="flex gap-1 shrink-0">
              <button class="btn btn-ghost btn-xs" onclick={() => openEdit(item)} title="Editează">
                <Edit2 size={13} />
              </button>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => remove(item.id)} title="Șterge">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
