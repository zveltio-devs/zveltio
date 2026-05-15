<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, X, Trash2, LoaderCircle, Package } from '@lucide/svelte';

  type Asset = {
    id: string; name: string; code: string | null; category: string | null;
    location: string | null; status: string; acquisition_cost: number;
    current_value: number | null; currency: string;
    acquisition_date: string | null; serial_number: string | null;
  };

  let assets = $state<Asset[]>([]);
  let loading = $state(true);
  let showModal = $state(false);
  let saving = $state(false);
  let deleting = $state<string | null>(null);

  let form = $state({
    name: '', code: '', category: '', location: '', status: 'active',
    acquisition_cost: '', currency: 'RON', acquisition_date: '', serial_number: '',
  });

  const CATEGORIES = ['IT Equipment', 'Furniture', 'Vehicles', 'Machinery', 'Buildings', 'Other'];
  const STATUSES = ['active', 'inactive', 'disposed', 'under_maintenance'];

  onMount(load);

  async function load() {
    loading = true;
    try {
      const r = await api.get<{ data: Asset[] }>('/ext/operations/assets');
      assets = r.data ?? [];
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load assets');
    } finally {
      loading = false;
    }
  }

  async function create() {
    if (!form.name.trim()) return;
    saving = true;
    try {
      const r = await api.post<{ data: Asset }>('/ext/operations/assets', {
        ...form,
        acquisition_cost: form.acquisition_cost ? parseFloat(form.acquisition_cost) : 0,
      });
      assets = [r.data, ...assets];
      form = { name: '', code: '', category: '', location: '', status: 'active', acquisition_cost: '', currency: 'RON', acquisition_date: '', serial_number: '' };
      showModal = false;
      toast.success('Asset created.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Error');
    } finally {
      saving = false;
    }
  }

  async function deleteAsset(id: string) {
    if (!confirm('Delete this asset?')) return;
    deleting = id;
    try {
      await api.delete(`/ext/operations/assets/${id}`);
      assets = assets.filter(a => a.id !== id);
      toast.success('Deleted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { deleting = null; }
  }

  const statusColor: Record<string, string> = {
    active: 'badge-success', inactive: 'badge-ghost', disposed: 'badge-error', under_maintenance: 'badge-warning',
  };
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Fixed Assets</h1>
      <p class="text-sm text-base-content/50">Manage company fixed assets and depreciation</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={14} /> New Asset
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if assets.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-16 gap-3">
        <Package size={36} class="text-base-content/20" />
        <p class="text-sm text-base-content/50">No assets registered yet.</p>
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr><th>Name</th><th>Code</th><th>Category</th><th>Location</th><th>Cost</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {#each assets as a (a.id)}
            <tr class="hover">
              <td class="font-medium">{a.name}</td>
              <td class="font-mono text-xs text-base-content/60">{a.code ?? '—'}</td>
              <td class="text-base-content/60">{a.category ?? '—'}</td>
              <td class="text-base-content/60">{a.location ?? '—'}</td>
              <td>{a.acquisition_cost.toLocaleString()} {a.currency}</td>
              <td><span class="badge badge-sm {statusColor[a.status] ?? 'badge-ghost'}">{a.status.replace('_', ' ')}</span></td>
              <td>
                <button class="btn btn-ghost btn-xs text-error" disabled={deleting === a.id}
                  onclick={() => deleteAsset(a.id)}>
                  {#if deleting === a.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New Asset</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Name *</span></label>
          <input class="input input-sm" bind:value={form.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Code / Tag</span></label>
          <input class="input input-sm" bind:value={form.code} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Serial Number</span></label>
          <input class="input input-sm" bind:value={form.serial_number} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Category</span></label>
          <select class="select select-sm" bind:value={form.category}>
            <option value="">— Select —</option>
            {#each CATEGORIES as c}<option>{c}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Status</span></label>
          <select class="select select-sm" bind:value={form.status}>
            {#each STATUSES as s}<option value={s}>{s.replace('_', ' ')}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Acquisition Cost</span></label>
          <input class="input input-sm" type="number" bind:value={form.acquisition_cost} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label>
          <input class="input input-sm" bind:value={form.currency} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Acquisition Date</span></label>
          <input class="input input-sm" type="date" bind:value={form.acquisition_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Location</span></label>
          <input class="input input-sm" bind:value={form.location} /></div>
      </div>
      <div class="modal-action mt-4">
        <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={create} disabled={!form.name.trim() || saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin mr-1" />{/if}Create
        </button>
      </div>
    </div>
  </div>
{/if}
