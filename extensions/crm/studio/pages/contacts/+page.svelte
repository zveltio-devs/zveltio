<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let contacts = $state<any[]>([]);
  let total = $state(0);
  let page = $state(1);
  let search = $state('');
  let loading = $state(false);
  let showModal = $state(false);
  let editingContact = $state<any>(null);

  // Form state
  let form = $state({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    company: '',
    job_title: '',
  });

  async function loadContacts() {
    loading = true;
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (search) params.set('search', search);
      const res = await api.get(`/contacts?${params}`);
      contacts = res.data;
      total = res.meta.total;
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editingContact = null;
    form = { first_name: '', last_name: '', email: '', phone: '', company: '', job_title: '' };
    showModal = true;
  }

  function openEdit(contact: any) {
    editingContact = contact;
    form = {
      first_name: contact.first_name ?? '',
      last_name: contact.last_name ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      company: contact.company ?? '',
      job_title: contact.job_title ?? '',
    };
    showModal = true;
  }

  async function save() {
    if (editingContact) {
      await api.patch(`/contacts/${editingContact.id}`, form);
    } else {
      await api.post('/contacts', form);
    }
    showModal = false;
    await loadContacts();
  }

  async function deleteContact(id: string) {
    if (!confirm('Delete this contact?')) return;
    await api.delete(`/contacts/${id}`);
    await loadContacts();
  }

  onMount(loadContacts);
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Contacts</h1>
      <p class="text-base-content/60">{total} contacts</p>
    </div>
    <button class="btn btn-primary" onclick={openCreate}>+ New Contact</button>
  </div>

  <div class="form-control w-full max-w-sm">
    <input
      type="search"
      placeholder="Search contacts..."
      class="input input-bordered"
      bind:value={search}
      oninput={() => { page = 1; loadContacts(); }}
    />
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Company</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each contacts as contact}
            <tr>
              <td class="font-medium">{contact.first_name} {contact.last_name ?? ''}</td>
              <td>{contact.email ?? '—'}</td>
              <td>{contact.phone ?? '—'}</td>
              <td>{contact.company ?? '—'}</td>
              <td class="text-right space-x-2">
                <button class="btn btn-ghost btn-xs" onclick={() => openEdit(contact)}>Edit</button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteContact(contact.id)}>Delete</button>
              </td>
            </tr>
          {/each}
          {#if !contacts.length}
            <tr><td colspan="5" class="text-center text-base-content/40 py-8">No contacts found</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="flex justify-center gap-2 mt-4">
      <button class="btn btn-sm" disabled={page === 1} onclick={() => { page--; loadContacts(); }}>Prev</button>
      <span class="btn btn-sm btn-disabled">Page {page} of {Math.ceil(total / 20) || 1}</span>
      <button class="btn btn-sm" disabled={page * 20 >= total} onclick={() => { page++; loadContacts(); }}>Next</button>
    </div>
  {/if}
</div>

<!-- Modal -->
{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">{editingContact ? 'Edit Contact' : 'New Contact'}</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label"><span class="label-text">First Name *</span></label>
            <input class="input input-bordered" bind:value={form.first_name} required />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Last Name</span></label>
            <input class="input input-bordered" bind:value={form.last_name} />
          </div>
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">Email</span></label>
          <input type="email" class="input input-bordered" bind:value={form.email} />
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">Phone</span></label>
          <input class="input input-bordered" bind:value={form.phone} />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label"><span class="label-text">Company</span></label>
            <input class="input input-bordered" bind:value={form.company} />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Job Title</span></label>
            <input class="input input-bordered" bind:value={form.job_title} />
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn" onclick={() => showModal = false}>Cancel</button>
        <button class="btn btn-primary" onclick={save}>Save</button>
      </div>
    </div>
    <div class="modal-backdrop" onclick={() => showModal = false}></div>
  </div>
{/if}
