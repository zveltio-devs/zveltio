<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import {
    Plus, Trash2, X, LoaderCircle, Users, Building2,
    TrendingUp, Phone, Mail, Search,
  } from '@lucide/svelte';

  type Contact = {
    id: string; first_name: string; last_name: string; email: string | null;
    phone: string | null; company: string | null; job_title: string | null;
    source: string | null; tags: string[]; created_at: string;
  };
  type Organization = {
    id: string; name: string; industry: string | null; website: string | null;
    email: string | null; phone: string | null; city: string | null; created_at: string;
  };
  type Deal = {
    id: string; title: string; stage: string; value: number | null;
    currency: string; contact_id: string | null; expected_close_date: string | null;
    created_at: string;
  };

  let tab = $state<'contacts' | 'organizations' | 'deals'>('contacts');
  let contacts = $state<Contact[]>([]);
  let orgs = $state<Organization[]>([]);
  let deals = $state<Deal[]>([]);
  let loading = $state(false);
  let search = $state('');
  let showModal = $state(false);
  let saving = $state(false);
  let deleting = $state<string | null>(null);

  let contactForm = $state({ first_name: '', last_name: '', email: '', phone: '', company: '', job_title: '' });
  let orgForm = $state({ name: '', industry: '', website: '', email: '', phone: '', city: '' });
  let dealForm = $state({ title: '', stage: 'prospecting', value: '', currency: 'RON', expected_close_date: '' });

  const DEAL_STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

  onMount(() => loadTab());

  async function loadTab() {
    loading = true;
    try {
      if (tab === 'contacts') {
        const r = await api.get<{ data: Contact[] }>('/api/contacts');
        contacts = r.data ?? [];
      } else if (tab === 'organizations') {
        const r = await api.get<{ data: Organization[] }>('/api/organizations');
        orgs = r.data ?? [];
      } else {
        const r = await api.get<{ data: Deal[] }>('/api/transactions');
        deals = r.data ?? [];
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load');
    } finally {
      loading = false;
    }
  }

  $effect(() => { tab; loadTab(); });

  const filteredContacts = $derived(
    contacts.filter(c =>
      !search || `${c.first_name} ${c.last_name} ${c.email ?? ''} ${c.company ?? ''}`.toLowerCase().includes(search.toLowerCase())
    )
  );
  const filteredOrgs = $derived(
    orgs.filter(o => !search || o.name.toLowerCase().includes(search.toLowerCase()))
  );
  const filteredDeals = $derived(
    deals.filter(d => !search || d.title.toLowerCase().includes(search.toLowerCase()))
  );

  async function createContact() {
    if (!contactForm.first_name.trim()) return;
    saving = true;
    try {
      const r = await api.post<{ data: Contact }>('/api/contacts', contactForm);
      contacts = [r.data, ...contacts];
      contactForm = { first_name: '', last_name: '', email: '', phone: '', company: '', job_title: '' };
      showModal = false;
      toast.success('Contact created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function createOrg() {
    if (!orgForm.name.trim()) return;
    saving = true;
    try {
      const r = await api.post<{ data: Organization }>('/api/organizations', orgForm);
      orgs = [r.data, ...orgs];
      orgForm = { name: '', industry: '', website: '', email: '', phone: '', city: '' };
      showModal = false;
      toast.success('Organization created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function createDeal() {
    if (!dealForm.title.trim()) return;
    saving = true;
    try {
      const r = await api.post<{ data: Deal }>('/api/transactions', {
        ...dealForm,
        value: dealForm.value ? parseFloat(dealForm.value) : null,
      });
      deals = [r.data, ...deals];
      dealForm = { title: '', stage: 'prospecting', value: '', currency: 'RON', expected_close_date: '' };
      showModal = false;
      toast.success('Deal created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function deleteItem(id: string, endpoint: string) {
    if (!confirm('Delete this item?')) return;
    deleting = id;
    try {
      await api.delete(`${endpoint}/${id}`);
      if (tab === 'contacts') contacts = contacts.filter(c => c.id !== id);
      else if (tab === 'organizations') orgs = orgs.filter(o => o.id !== id);
      else deals = deals.filter(d => d.id !== id);
      toast.success('Deleted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { deleting = null; }
  }

  const stageColor: Record<string, string> = {
    prospecting: 'badge-ghost', qualification: 'badge-info', proposal: 'badge-warning',
    negotiation: 'badge-warning', closed_won: 'badge-success', closed_lost: 'badge-error',
  };
</script>

<div class="space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">CRM</h1>
      <p class="text-sm text-base-content/50">Contacts, organizations and deals</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={14} /> New
    </button>
  </div>

  <!-- Tabs -->
  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'contacts' ? 'tab-active' : ''}" onclick={() => (tab = 'contacts')}>
      <Users size={13} class="mr-1.5" /> Contacts
    </button>
    <button class="tab {tab === 'organizations' ? 'tab-active' : ''}" onclick={() => (tab = 'organizations')}>
      <Building2 size={13} class="mr-1.5" /> Organizations
    </button>
    <button class="tab {tab === 'deals' ? 'tab-active' : ''}" onclick={() => (tab = 'deals')}>
      <TrendingUp size={13} class="mr-1.5" /> Deals
    </button>
  </div>

  <!-- Search -->
  <div class="relative max-w-xs">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/30" />
    <input class="input input-sm pl-8 w-full" placeholder="Search…" bind:value={search} />
  </div>

  <!-- Content -->
  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'contacts'}
    {#if filteredContacts.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No contacts found</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Company</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {#each filteredContacts as c (c.id)}
              <tr class="hover">
                <td class="font-medium">{c.first_name} {c.last_name}</td>
                <td class="text-base-content/60">{c.email ?? '—'}</td>
                <td class="text-base-content/60">{c.phone ?? '—'}</td>
                <td class="text-base-content/60">{c.company ?? '—'}</td>
                <td class="text-xs text-base-content/40">{new Date(c.created_at).toLocaleDateString()}</td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" disabled={deleting === c.id}
                    onclick={() => deleteItem(c.id, '/api/contacts')}>
                    {#if deleting === c.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if tab === 'organizations'}
    {#if filteredOrgs.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No organizations found</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Name</th><th>Industry</th><th>Email</th><th>City</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {#each filteredOrgs as o (o.id)}
              <tr class="hover">
                <td class="font-medium">{o.name}</td>
                <td class="text-base-content/60">{o.industry ?? '—'}</td>
                <td class="text-base-content/60">{o.email ?? '—'}</td>
                <td class="text-base-content/60">{o.city ?? '—'}</td>
                <td class="text-xs text-base-content/40">{new Date(o.created_at).toLocaleDateString()}</td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" disabled={deleting === o.id}
                    onclick={() => deleteItem(o.id, '/api/organizations')}>
                    {#if deleting === o.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else}
    {#if filteredDeals.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No deals found</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Title</th><th>Stage</th><th>Value</th><th>Close Date</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {#each filteredDeals as d (d.id)}
              <tr class="hover">
                <td class="font-medium">{d.title}</td>
                <td><span class="badge badge-sm {stageColor[d.stage] ?? 'badge-ghost'}">{d.stage.replace('_', ' ')}</span></td>
                <td class="text-base-content/70">{d.value != null ? `${d.value.toLocaleString()} ${d.currency}` : '—'}</td>
                <td class="text-xs text-base-content/50">{d.expected_close_date ? new Date(d.expected_close_date).toLocaleDateString() : '—'}</td>
                <td class="text-xs text-base-content/40">{new Date(d.created_at).toLocaleDateString()}</td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" disabled={deleting === d.id}
                    onclick={() => deleteItem(d.id, '/api/transactions')}>
                    {#if deleting === d.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<!-- Create Modal -->
{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">
          {tab === 'contacts' ? 'New Contact' : tab === 'organizations' ? 'New Organization' : 'New Deal'}
        </h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
      </div>

      {#if tab === 'contacts'}
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">First Name *</span></label>
            <input class="input input-sm" bind:value={contactForm.first_name} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Last Name</span></label>
            <input class="input input-sm" bind:value={contactForm.last_name} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Email</span></label>
            <input class="input input-sm" type="email" bind:value={contactForm.email} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Phone</span></label>
            <input class="input input-sm" bind:value={contactForm.phone} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Company</span></label>
            <input class="input input-sm" bind:value={contactForm.company} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Job Title</span></label>
            <input class="input input-sm" bind:value={contactForm.job_title} /></div>
        </div>
        <div class="modal-action mt-4">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm gap-1" onclick={createContact} disabled={!contactForm.first_name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
          </button>
        </div>

      {:else if tab === 'organizations'}
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Name *</span></label>
            <input class="input input-sm" bind:value={orgForm.name} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Industry</span></label>
            <input class="input input-sm" bind:value={orgForm.industry} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">City</span></label>
            <input class="input input-sm" bind:value={orgForm.city} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Email</span></label>
            <input class="input input-sm" type="email" bind:value={orgForm.email} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Phone</span></label>
            <input class="input input-sm" bind:value={orgForm.phone} /></div>
          <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Website</span></label>
            <input class="input input-sm" bind:value={orgForm.website} /></div>
        </div>
        <div class="modal-action mt-4">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm gap-1" onclick={createOrg} disabled={!orgForm.name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
          </button>
        </div>

      {:else}
        <div class="space-y-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Title *</span></label>
            <input class="input input-sm" bind:value={dealForm.title} /></div>
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Stage</span></label>
              <select class="select select-sm" bind:value={dealForm.stage}>
                {#each DEAL_STAGES as s}<option value={s}>{s.replace('_', ' ')}</option>{/each}
              </select>
            </div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Value</span></label>
              <input class="input input-sm" type="number" bind:value={dealForm.value} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label>
              <input class="input input-sm" bind:value={dealForm.currency} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Close Date</span></label>
              <input class="input input-sm" type="date" bind:value={dealForm.expected_close_date} /></div>
          </div>
        </div>
        <div class="modal-action mt-4">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm gap-1" onclick={createDeal} disabled={!dealForm.title.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
