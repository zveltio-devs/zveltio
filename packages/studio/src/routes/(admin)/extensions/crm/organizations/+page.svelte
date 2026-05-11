<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let organizations = $state<any[]>([]);
  let total = $state(0);
  let page = $state(1);
  let search = $state('');
  let loading = $state(false);
  let showModal = $state(false);
  let editingOrg = $state<any>(null);

  let form = $state({
    name: '',
    legal_name: '',
    tax_id: '',
    type: 'company',
    industry: '',
    website: '',
    email: '',
    phone: '',
  });

  async function loadOrganizations() {
    loading = true;
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (search) params.set('search', search);
      const res = await api.get(`/organizations?${params}`);
      organizations = res.data;
      total = res.meta.total;
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editingOrg = null;
    form = { name: '', legal_name: '', tax_id: '', type: 'company', industry: '', website: '', email: '', phone: '' };
    showModal = true;
  }

  function openEdit(org: any) {
    editingOrg = org;
    form = {
      name: org.name ?? '',
      legal_name: org.legal_name ?? '',
      tax_id: org.tax_id ?? '',
      type: org.type ?? 'company',
      industry: org.industry ?? '',
      website: org.website ?? '',
      email: org.email ?? '',
      phone: org.phone ?? '',
    };
    showModal = true;
  }

  async function save() {
    if (editingOrg) {
      await api.patch(`/organizations/${editingOrg.id}`, form);
    } else {
      await api.post('/organizations', form);
    }
    showModal = false;
    await loadOrganizations();
  }

  async function deleteOrg(id: string) {
    if (!confirm('Delete this organization?')) return;
    await api.delete(`/organizations/${id}`);
    await loadOrganizations();
  }

  onMount(loadOrganizations);
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Organizations</h1>
      <p class="text-base-content/60">{total} organizations</p>
    </div>
    <button class="btn btn-primary" onclick={openCreate}>+ New Organization</button>
  </div>

  <input
    type="search"
    placeholder="Search organizations..."
    class="input input-bordered w-full max-w-sm"
    bind:value={search}
    oninput={() => { page = 1; loadOrganizations(); }}
  />

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th>Name</th>
            <th>Tax ID</th>
            <th>Type</th>
            <th>Industry</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each organizations as org}
            <tr>
              <td class="font-medium">{org.name}</td>
              <td class="font-mono text-sm">{org.tax_id ?? '—'}</td>
              <td><span class="badge badge-ghost">{org.type}</span></td>
              <td>{org.industry ?? '—'}</td>
              <td>
                <span class="badge {org.is_active ? 'badge-success' : 'badge-error'} badge-sm">
                  {org.is_active ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td class="text-right space-x-2">
                <button class="btn btn-ghost btn-xs" onclick={() => openEdit(org)}>Edit</button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteOrg(org.id)}>Delete</button>
              </td>
            </tr>
          {/each}
          {#if !organizations.length}
            <tr><td colspan="6" class="text-center text-base-content/40 py-8">No organizations found</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    <div class="flex justify-center gap-2 mt-4">
      <button class="btn btn-sm" disabled={page === 1} onclick={() => { page--; loadOrganizations(); }}>Prev</button>
      <span class="btn btn-sm btn-disabled">Page {page}</span>
      <button class="btn btn-sm" disabled={page * 20 >= total} onclick={() => { page++; loadOrganizations(); }}>Next</button>
    </div>
  {/if}
</div>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">{editingOrg ? 'Edit Organization' : 'New Organization'}</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label" for="org-name"><span class="label-text">Name *</span></label>
          <input id="org-name" class="input input-bordered" bind:value={form.name} required />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="org-legal-name"><span class="label-text">Legal Name</span></label>
            <input id="org-legal-name" class="input input-bordered" bind:value={form.legal_name} />
          </div>
          <div class="form-control">
            <label class="label" for="org-tax-id"><span class="label-text">Tax ID (CUI)</span></label>
            <input id="org-tax-id" class="input input-bordered" bind:value={form.tax_id} />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="org-type"><span class="label-text">Type</span></label>
            <select id="org-type" class="select select-bordered" bind:value={form.type}>
              <option value="company">Company</option>
              <option value="nonprofit">Nonprofit</option>
              <option value="government">Government</option>
              <option value="individual">Individual</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label" for="org-industry"><span class="label-text">Industry</span></label>
            <input id="org-industry" class="input input-bordered" bind:value={form.industry} />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="org-website"><span class="label-text">Website</span></label>
          <input id="org-website" type="url" class="input input-bordered" bind:value={form.website} placeholder="https://" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="org-email"><span class="label-text">Email</span></label>
            <input id="org-email" type="email" class="input input-bordered" bind:value={form.email} />
          </div>
          <div class="form-control">
            <label class="label" for="org-phone"><span class="label-text">Phone</span></label>
            <input id="org-phone" class="input input-bordered" bind:value={form.phone} />
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn" onclick={() => showModal = false}>Cancel</button>
        <button class="btn btn-primary" onclick={save}>Save</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => showModal = false}></button>
  </div>
{/if}
