<script lang="ts">
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { Plus, Trash2, X, LoaderCircle, Users, Building2, TrendingUp } from '@lucide/svelte';

type Contact = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
  source: string | null;
  tags: string[];
  created_at: string;
};
type Organization = {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  created_at: string;
};
type Deal = {
  id: string;
  title: string;
  stage: string;
  value: number | null;
  currency: string;
  contact_id: string | null;
  expected_close_date: string | null;
  created_at: string;
};

type TabId = 'contacts' | 'organizations' | 'deals';

let tab = $state<TabId>('contacts');
let contacts = $state<Contact[]>([]);
let orgs = $state<Organization[]>([]);
let deals = $state<Deal[]>([]);
let loading = $state(false);
let search = $state('');
let showModal = $state(false);
let saving = $state(false);
let deleting = $state<string | null>(null);

let contactForm = $state({
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  company: '',
  job_title: '',
});
let orgForm = $state({ name: '', industry: '', website: '', email: '', phone: '', city: '' });
let dealForm = $state({
  title: '',
  stage: 'prospecting',
  value: '',
  currency: 'RON',
  expected_close_date: '',
});

const DEAL_STAGES = [
  'prospecting',
  'qualification',
  'proposal',
  'negotiation',
  'closed_won',
  'closed_lost',
] as const;

const tabs = $derived([
  { id: 'contacts' as const, label: m['crm.tab.contacts'](), icon: Users },
  { id: 'organizations' as const, label: m['crm.tab.organizations'](), icon: Building2 },
  { id: 'deals' as const, label: m['crm.tab.deals'](), icon: TrendingUp },
]);

let confirmDelete = $state<{ open: boolean; id: string; endpoint: string }>({
  open: false,
  id: '',
  endpoint: '',
});

const dash = $derived(m['common.emptyDash']());

onMount(() => loadTab());

function stageLabel(stage: string): string {
  const key = `crm.stage.${stage}` as 'crm.stage.prospecting';
  const msg = (m as Record<string, (() => string) | undefined>)[key];
  return msg?.() ?? stage.replace(/_/g, ' ');
}

async function loadTab() {
  loading = true;
  try {
    if (tab === 'contacts') {
      const r = await api.get<{ data: Contact[] }>('/ext/crm/contacts');
      contacts = r.data ?? [];
    } else if (tab === 'organizations') {
      const r = await api.get<{ data: Organization[] }>('/ext/crm/organizations');
      orgs = r.data ?? [];
    } else {
      const r = await api.get<{ data: Deal[] }>('/ext/crm/transactions');
      deals = r.data ?? [];
    }
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

$effect(() => {
  tab;
  loadTab();
});

const filteredContacts = $derived(
  contacts.filter(
    (c) =>
      !search ||
      `${c.first_name} ${c.last_name} ${c.email ?? ''} ${c.company ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  ),
);
const filteredOrgs = $derived(
  orgs.filter((o) => !search || o.name.toLowerCase().includes(search.toLowerCase())),
);
const filteredDeals = $derived(
  deals.filter((d) => !search || d.title.toLowerCase().includes(search.toLowerCase())),
);

const listEmpty = $derived(
  tab === 'contacts'
    ? filteredContacts.length === 0
    : tab === 'organizations'
      ? filteredOrgs.length === 0
      : filteredDeals.length === 0,
);

const emptyCopy = $derived(
  tab === 'contacts'
    ? { title: m['crm.empty.contacts'](), description: '' }
    : tab === 'organizations'
      ? { title: m['crm.empty.organizations'](), description: '' }
      : { title: m['crm.empty.deals'](), description: '' },
);

const modalTitle = $derived(
  tab === 'contacts'
    ? m['crm.form.newContact']()
    : tab === 'organizations'
      ? m['crm.form.newOrganization']()
      : m['crm.form.newDeal'](),
);

async function createContact() {
  if (!contactForm.first_name.trim()) return;
  saving = true;
  try {
    const r = await api.post<{ data: Contact }>('/ext/crm/contacts', contactForm);
    contacts = [r.data, ...contacts];
    contactForm = {
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      company: '',
      job_title: '',
    };
    showModal = false;
    toast.success(m['crm.toast.contactCreated']());
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function createOrg() {
  if (!orgForm.name.trim()) return;
  saving = true;
  try {
    const r = await api.post<{ data: Organization }>('/ext/crm/organizations', orgForm);
    orgs = [r.data, ...orgs];
    orgForm = { name: '', industry: '', website: '', email: '', phone: '', city: '' };
    showModal = false;
    toast.success(m['crm.toast.orgCreated']());
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function createDeal() {
  if (!dealForm.title.trim()) return;
  saving = true;
  try {
    const r = await api.post<{ data: Deal }>('/ext/crm/transactions', {
      ...dealForm,
      value: dealForm.value ? parseFloat(dealForm.value) : null,
    });
    deals = [r.data, ...deals];
    dealForm = {
      title: '',
      stage: 'prospecting',
      value: '',
      currency: 'RON',
      expected_close_date: '',
    };
    showModal = false;
    toast.success(m['crm.toast.dealCreated']());
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

function requestDelete(id: string, endpoint: string) {
  confirmDelete = { open: true, id, endpoint };
}

async function confirmDeleteItem() {
  const { id, endpoint } = confirmDelete;
  confirmDelete = { open: false, id: '', endpoint: '' };
  deleting = id;
  try {
    await api.delete(`${endpoint}/${id}`);
    if (tab === 'contacts') contacts = contacts.filter((c) => c.id !== id);
    else if (tab === 'organizations') orgs = orgs.filter((o) => o.id !== id);
    else deals = deals.filter((d) => d.id !== id);
    toast.success(m['ext.deleted']());
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    deleting = null;
  }
}

const stageColor: Record<string, string> = {
  prospecting: 'badge-ghost',
  qualification: 'badge-info',
  proposal: 'badge-warning',
  negotiation: 'badge-warning',
  closed_won: 'badge-success',
  closed_lost: 'badge-error',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}
</script>

<ExtensionPageShell
  title={m['crm.title']()}
  subtitle={m['crm.subtitle']()}
  {tabs}
  activeTab={tab}
  onTabChange={(id) => (tab = id as TabId)}
  {search}
  onSearchChange={(v) => (search = v)}
  searchPlaceholder={m['common.search']()}
>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['common.new']()}
    </button>
  {/snippet}

    <ExtensionDataPanel
      {loading}
      empty={!loading && listEmpty}
      emptyTitle={emptyCopy.title}
      emptyDescription={emptyCopy.description}
    >
      {#snippet table()}
        {#if tab === 'contacts'}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['crm.col.name']()}</th>
                <th>{m['crm.col.email']()}</th>
                <th>{m['crm.col.phone']()}</th>
                <th>{m['crm.col.company']()}</th>
                <th>{m['common.added']()}</th>
                <th><span class="sr-only">{m['common.actions']()}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each filteredContacts as c (c.id)}
                <tr class="hover">
                  <td class="font-medium">{c.first_name} {c.last_name}</td>
                  <td class="text-base-content/60">{c.email ?? dash}</td>
                  <td class="text-base-content/60">{c.phone ?? dash}</td>
                  <td class="text-base-content/60">{c.company ?? dash}</td>
                  <td class="text-xs text-base-content/40">{formatDate(c.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs text-error"
                      disabled={deleting === c.id}
                      aria-label={m['common.delete']()}
                      onclick={() => requestDelete(c.id, '/ext/crm/contacts')}
                    >
                      {#if deleting === c.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'organizations'}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['crm.col.name']()}</th>
                <th>{m['crm.col.industry']()}</th>
                <th>{m['crm.col.email']()}</th>
                <th>{m['crm.col.city']()}</th>
                <th>{m['common.added']()}</th>
                <th><span class="sr-only">{m['common.actions']()}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each filteredOrgs as o (o.id)}
                <tr class="hover">
                  <td class="font-medium">{o.name}</td>
                  <td class="text-base-content/60">{o.industry ?? dash}</td>
                  <td class="text-base-content/60">{o.email ?? dash}</td>
                  <td class="text-base-content/60">{o.city ?? dash}</td>
                  <td class="text-xs text-base-content/40">{formatDate(o.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs text-error"
                      disabled={deleting === o.id}
                      aria-label={m['common.delete']()}
                      onclick={() => requestDelete(o.id, '/ext/crm/organizations')}
                    >
                      {#if deleting === o.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['crm.col.title']()}</th>
                <th>{m['crm.col.stage']()}</th>
                <th>{m['crm.col.value']()}</th>
                <th>{m['crm.col.closeDate']()}</th>
                <th>{m['common.added']()}</th>
                <th><span class="sr-only">{m['common.actions']()}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each filteredDeals as d (d.id)}
                <tr class="hover">
                  <td class="font-medium">{d.title}</td>
                  <td><span class="badge badge-sm {stageColor[d.stage] ?? 'badge-ghost'}">{stageLabel(d.stage)}</span></td>
                  <td class="text-base-content/70">{d.value != null ? `${d.value.toLocaleString()} ${d.currency}` : dash}</td>
                  <td class="text-xs text-base-content/50">{d.expected_close_date ? formatDate(d.expected_close_date) : dash}</td>
                  <td class="text-xs text-base-content/40">{formatDate(d.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs text-error"
                      disabled={deleting === d.id}
                      aria-label={m['common.delete']()}
                      onclick={() => requestDelete(d.id, '/ext/crm/transactions')}
                    >
                      {#if deleting === d.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/snippet}
    </ExtensionDataPanel>
</ExtensionPageShell>

<ConfirmModal
  open={confirmDelete.open}
  title={m['common.delete']()}
  message={m['ext.confirmDelete']()}
  confirmLabel={m['common.delete']()}
  onconfirm={confirmDeleteItem}
  oncancel={() => (confirmDelete = { open: false, id: '', endpoint: '' })}
/>

{#if showModal}
  <dialog class="modal modal-open" aria-labelledby="crm-create-title">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 id="crm-create-title" class="font-semibold">{modalTitle}</h3>
        <button type="button" class="btn btn-ghost btn-xs" aria-label={m['common.cancel']()} onclick={() => (showModal = false)}>
          <X size={14} />
        </button>
      </div>

      {#if tab === 'contacts'}
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.form.firstName']()} *</span></label>
            <input class="input input-sm" bind:value={contactForm.first_name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.form.lastName']()}</span></label>
            <input class="input input-sm" bind:value={contactForm.last_name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.email']()}</span></label>
            <input class="input input-sm" type="email" bind:value={contactForm.email} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.phone']()}</span></label>
            <input class="input input-sm" bind:value={contactForm.phone} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.company']()}</span></label>
            <input class="input input-sm" bind:value={contactForm.company} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.form.jobTitle']()}</span></label>
            <input class="input input-sm" bind:value={contactForm.job_title} />
          </div>
        </div>
        <div class="modal-action mt-4">
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
          <button type="button" class="btn btn-primary btn-sm gap-1" onclick={createContact} disabled={!contactForm.first_name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
            {m['common.create']()}
          </button>
        </div>

      {:else if tab === 'organizations'}
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control col-span-2">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.name']()} *</span></label>
            <input class="input input-sm" bind:value={orgForm.name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.industry']()}</span></label>
            <input class="input input-sm" bind:value={orgForm.industry} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.city']()}</span></label>
            <input class="input input-sm" bind:value={orgForm.city} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.email']()}</span></label>
            <input class="input input-sm" type="email" bind:value={orgForm.email} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.phone']()}</span></label>
            <input class="input input-sm" bind:value={orgForm.phone} />
          </div>
          <div class="form-control col-span-2">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.form.website']()}</span></label>
            <input class="input input-sm" bind:value={orgForm.website} />
          </div>
        </div>
        <div class="modal-action mt-4">
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
          <button type="button" class="btn btn-primary btn-sm gap-1" onclick={createOrg} disabled={!orgForm.name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
            {m['common.create']()}
          </button>
        </div>

      {:else}
        <div class="space-y-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.col.title']()} *</span></label>
            <input class="input input-sm" bind:value={dealForm.title} />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control">
              <label class="label py-0"><span class="label-text text-xs">{m['crm.form.stage']()}</span></label>
              <select class="select select-sm" bind:value={dealForm.stage}>
                {#each DEAL_STAGES as s}
                  <option value={s}>{stageLabel(s)}</option>
                {/each}
              </select>
            </div>
            <div class="form-control">
              <label class="label py-0"><span class="label-text text-xs">{m['crm.col.value']()}</span></label>
              <input class="input input-sm" type="number" bind:value={dealForm.value} />
            </div>
            <div class="form-control">
              <label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
              <input class="input input-sm" bind:value={dealForm.currency} />
            </div>
            <div class="form-control">
              <label class="label py-0"><span class="label-text text-xs">{m['crm.col.closeDate']()}</span></label>
              <input class="input input-sm" type="date" bind:value={dealForm.expected_close_date} />
            </div>
          </div>
        </div>
        <div class="modal-action mt-4">
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
          <button type="button" class="btn btn-primary btn-sm gap-1" onclick={createDeal} disabled={!dealForm.title.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
            {m['common.create']()}
          </button>
        </div>
      {/if}
    </div>
  </dialog>
{/if}
