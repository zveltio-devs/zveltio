<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

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
  form = {
    name: '',
    legal_name: '',
    tax_id: '',
    type: 'company',
    industry: '',
    website: '',
    email: '',
    phone: '',
  };
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
  askConfirm(m['crm.organizations.confirmDelete'](), () => deleteOrgConfirmed(id));
}
async function deleteOrgConfirmed(id: string) {
  await api.delete(`/organizations/${id}`);
  await loadOrganizations();
}

onMount(loadOrganizations);
</script>

<ExtensionPageShell title={m['crm.organizations.title']()} subtitle={m['crm.organizations.count']({ count: total })}>
  {#snippet actions()}
    <button class="btn btn-primary" onclick={openCreate}>{m['crm.ui.new_organization']()}</button>
  {/snippet}
    <div class="space-y-6">
      <input
        type="search"
        placeholder={m['crm.ui.search_organizations']()}
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
                <th>{m['common.col.name']()}</th>
                <th>{m['crm.col.taxId']()}</th>
                <th>{m['common.col.type']()}</th>
                <th>{m['crm.col.industry']()}</th>
                <th>{m['common.col.status']()}</th>
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
                      {org.is_active ? m['common.col.active']() : m['ecommerce.store.status.inactive']()}
                    </span>
                  </td>
                  <td class="text-right space-x-2">
                    <button class="btn btn-ghost btn-xs" onclick={() => openEdit(org)}>{m['common.edit']()}</button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteOrg(org.id)}>{m['common.delete']()}</button>
                  </td>
                </tr>
              {/each}
              {#if !organizations.length}
                <tr><td colspan="6" class="text-center text-base-content/40 py-8">{m['crm.ui.no_organizations_found']()}</td></tr>
              {/if}
            </tbody>
          </table>
        </div>

        <div class="flex justify-center gap-2 mt-4">
          <button class="btn btn-sm" disabled={page === 1} onclick={() => { page--; loadOrganizations(); }}>{m['common.prev']()}</button>
          <span class="btn btn-sm btn-disabled">{m['common.pageOf']({ page: String(page), total: String(Math.ceil(total / 20) || 1) })}</span>
          <button class="btn btn-sm" disabled={page * 20 >= total} onclick={() => { page++; loadOrganizations(); }}>{m['common.next']()}</button>
        </div>
      {/if}
    </div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">{editingOrg ? m['crm.ui.editOrganization']() : m['crm.ui.newOrganizationTitle']()}</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label" for="org-name"><span class="label-text">{m['content.document-templates.ui.name']()}</span></label>
          <input id="org-name" class="input input-bordered" bind:value={form.name} required />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="org-legal-name"><span class="label-text">{m['crm.ui.legal_name']()}</span></label>
            <input id="org-legal-name" class="input input-bordered" bind:value={form.legal_name} />
          </div>
          <div class="form-control">
            <label class="label" for="org-tax-id"><span class="label-text">{m['crm.ui.tax_id_cui']()}</span></label>
            <input id="org-tax-id" class="input input-bordered" bind:value={form.tax_id} />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="org-type"><span class="label-text">{m['common.col.type']()}</span></label>
            <select id="org-type" class="select select-bordered" bind:value={form.type}>
              <option value="company">{m['crm.col.company']()}</option>
              <option value="nonprofit">{m['crm.ui.nonprofit']()}</option>
              <option value="government">{m['crm.ui.government']()}</option>
              <option value="individual">{m['crm.ui.individual']()}</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label" for="org-industry"><span class="label-text">{m['crm.col.industry']()}</span></label>
            <input id="org-industry" class="input input-bordered" bind:value={form.industry} />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="org-website"><span class="label-text">{m['crm.form.website']()}</span></label>
          <input id="org-website" type="url" class="input input-bordered" bind:value={form.website} placeholder={m['crm.ui.https']()} />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="org-email"><span class="label-text">{m['common.col.email']()}</span></label>
            <input id="org-email" type="email" class="input input-bordered" bind:value={form.email} />
          </div>
          <div class="form-control">
            <label class="label" for="org-phone"><span class="label-text">{m['crm.col.phone']()}</span></label>
            <input id="org-phone" class="input input-bordered" bind:value={form.phone} />
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn" onclick={() => showModal = false}>{m['common.cancel']()}</button>
        <button class="btn btn-primary" onclick={save}>{m['common.save']()}</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label={m['common.close']()} onclick={() => showModal = false}></button>
  </div>
{/if}
