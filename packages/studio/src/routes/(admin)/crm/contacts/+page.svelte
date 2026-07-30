<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let contacts = $state<any[]>([]);
  let total = $state(0);
  let page = $state(1);
  let search = $state('');
  let loading = $state(false);
  let showModal = $state(false);
  let editingContact = $state<any>(null);

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
        askConfirm(m['crm.contacts.confirmDelete'](), () => deleteContactConfirmed(id));
  }
  async function deleteContactConfirmed(id: string) {
    await api.delete(`/contacts/${id}`);
    await loadContacts();
  }


  onMount(loadContacts);
</script>

<ExtensionPageShell title={m['crm.tab.contacts']()} subtitle={m['crm.contacts.count']({ count: total })}>
  {#snippet actions()}
    <button class="btn btn-primary" onclick={openCreate}>{m['crm.ui.new_contact']()}</button>
  {/snippet}
    <div class="space-y-6">
      <div class="form-control w-full max-w-sm">
        <input
          type="search"
          placeholder={m['communications.mail.ui.search_contacts']()}
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
                <th>{m['common.col.name']()}</th>
                <th>{m['common.col.email']()}</th>
                <th>{m['common.col.phone']()}</th>
                <th>{m['crm.col.company']()}</th>
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
                    <button class="btn btn-ghost btn-xs" onclick={() => openEdit(contact)}>{m['common.edit']()}</button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteContact(contact.id)}>{m['common.delete']()}</button>
                  </td>
                </tr>
              {/each}
              {#if !contacts.length}
                <tr><td colspan="5" class="text-center text-base-content/40 py-8">{m['crm.ui.no_contacts_found']()}</td></tr>
              {/if}
            </tbody>
          </table>
        </div>

        <div class="flex justify-center gap-2 mt-4">
          <button class="btn btn-sm" disabled={page === 1} onclick={() => { page--; loadContacts(); }}>{m['common.prev']()}</button>
          <span class="btn btn-sm btn-disabled">{m['common.pageOf']({ page: String(page), total: String(Math.ceil(total / 20) || 1) })}</span>
          <button class="btn btn-sm" disabled={page * 20 >= total} onclick={() => { page++; loadContacts(); }}>{m['common.next']()}</button>
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
      <h3 class="font-bold text-lg mb-4">{editingContact ? m['crm.ui.editContact']() : m['crm.ui.newContactTitle']()}</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="contact-first-name"><span class="label-text">{m['crm.ui.first_name']()}</span></label>
            <input id="contact-first-name" class="input input-bordered" bind:value={form.first_name} required />
          </div>
          <div class="form-control">
            <label class="label" for="contact-last-name"><span class="label-text">{m['crm.ui.last_name']()}</span></label>
            <input id="contact-last-name" class="input input-bordered" bind:value={form.last_name} />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="contact-email"><span class="label-text">{m['common.col.email']()}</span></label>
          <input id="contact-email" type="email" class="input input-bordered" bind:value={form.email} />
        </div>
        <div class="form-control">
          <label class="label" for="contact-phone"><span class="label-text">{m['crm.col.phone']()}</span></label>
          <input id="contact-phone" class="input input-bordered" bind:value={form.phone} />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="contact-company"><span class="label-text">{m['crm.col.company']()}</span></label>
            <input id="contact-company" class="input input-bordered" bind:value={form.company} />
          </div>
          <div class="form-control">
            <label class="label" for="contact-job-title"><span class="label-text">{m['crm.ui.job_title']()}</span></label>
            <input id="contact-job-title" class="input input-bordered" bind:value={form.job_title} />
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
