<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Headphones, Plus, X, LoaderCircle } from '@lucide/svelte';

  let tickets = $state<any[]>([]);
  let categories = $state<any[]>([]);
  let loading = $state(true);
  let statusFilter = $state<'all' | 'open' | 'pending' | 'resolved' | 'closed'>('open');
  let activeTicket = $state<any | null>(null);
  let messages = $state<any[]>([]);
  let newMessage = $state('');

  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({ subject: '', description: '', category_id: '', priority: 'medium', requester_email: '' });

  async function loadTickets() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const r = await api.get<{ data: any[] }>(`/ext/projects/helpdesk/tickets?${params}`);
      tickets = r.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }
  async function loadCategories() {
    try { const r = await api.get<{ data: any[] }>('/ext/projects/helpdesk/categories'); categories = r.data ?? []; } catch {}
  }
  async function loadMessages(id: string) {
    try { const r = await api.get<{ data: any[] }>(`/ext/projects/helpdesk/tickets/${id}/messages`); messages = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function createTicket() {
    saving = true;
    try {
      await api.post('/ext/projects/helpdesk/tickets', form);
      showForm = false;
      form = { subject: '', description: '', category_id: '', priority: 'medium', requester_email: '' };
      await loadTickets();
      toast.success('Ticket created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function reply() {
    if (!activeTicket || !newMessage.trim()) return;
    try {
      await api.post(`/ext/projects/helpdesk/tickets/${activeTicket.id}/messages`, { body: newMessage });
      newMessage = '';
      await loadMessages(activeTicket.id);
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function resolve(id: string) {
    try {
      await api.post(`/ext/projects/helpdesk/tickets/${id}/resolve`, {});
      await loadTickets();
      if (activeTicket?.id === id) activeTicket = null;
      toast.success('Ticket resolved.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => { statusFilter; loadTickets(); });
  $effect(() => { if (activeTicket) loadMessages(activeTicket.id); });
  onMount(() => { loadTickets(); loadCategories(); });

  function priorityBadge(p: string) { return ({ low: 'badge-ghost', medium: 'badge-info', high: 'badge-warning', urgent: 'badge-error' } as any)[p] ?? 'badge-ghost'; }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Headphones size={20} /> Helpdesk</h1>
      <p class="text-sm text-base-content/50">Manage support tickets</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New ticket</button>
  </div>

  <select bind:value={statusFilter} class="select select-sm max-w-xs">
    <option value="all">All</option>
    <option value="open">Open</option>
    <option value="pending">Pending</option>
    <option value="resolved">Resolved</option>
    <option value="closed">Closed</option>
  </select>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-5 card bg-base-200 border border-base-300">
        <div class="card-body p-0 overflow-y-auto max-h-[70vh]">
          <table class="table table-sm">
            <thead><tr><th>Subject</th><th>Priority</th><th>Status</th></tr></thead>
            <tbody>
              {#if tickets.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">No tickets.</td></tr>
              {:else}{#each tickets as t (t.id)}
                <tr class="hover cursor-pointer {activeTicket?.id === t.id ? 'bg-primary/10' : ''}" onclick={() => (activeTicket = t)}>
                  <td class="text-sm">{t.subject}</td>
                  <td><span class="badge {priorityBadge(t.priority)} badge-sm">{t.priority}</span></td>
                  <td><span class="badge badge-ghost badge-sm">{t.status}</span></td>
                </tr>
              {/each}{/if}
            </tbody>
          </table>
        </div>
      </div>

      <div class="col-span-7 card bg-base-200 border border-base-300">
        <div class="card-body p-4">
          {#if !activeTicket}
            <div class="text-center py-12 text-base-content/50 text-sm">Select a ticket to view the conversation.</div>
          {:else}
            <div class="flex items-start justify-between mb-3 gap-4">
              <div>
                <div class="font-medium text-sm">{activeTicket.subject}</div>
                <div class="text-xs text-base-content/60">From: {activeTicket.requester_email ?? activeTicket.requester_id ?? '—'}</div>
              </div>
              {#if activeTicket.status !== 'resolved' && activeTicket.status !== 'closed'}
                <button class="btn btn-success btn-sm shrink-0" onclick={() => resolve(activeTicket.id)}>Mark resolved</button>
              {/if}
            </div>
            <div class="space-y-2 mb-3 max-h-[40vh] overflow-y-auto">
              <div class="bg-base-300 rounded-lg p-3 text-sm">{activeTicket.description}</div>
              {#each messages as m (m.id)}
                <div class="rounded-lg p-3 text-sm {m.is_internal ? 'bg-primary/10' : 'bg-base-100'}">
                  <div class="text-xs text-base-content/60 mb-1">{m.author_name ?? m.author_id} · {new Date(m.created_at).toLocaleString()}</div>
                  <div>{m.body}</div>
                </div>
              {/each}
            </div>
            <div class="flex gap-2">
              <textarea class="textarea textarea-sm flex-1" rows="2" placeholder="Reply…" bind:value={newMessage}></textarea>
              <button class="btn btn-primary btn-sm self-end" disabled={!newMessage.trim()} onclick={reply}>Send</button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New ticket</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Subject *</span></label><input class="input input-sm" bind:value={form.subject} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Requester email</span></label><input type="email" class="input input-sm" bind:value={form.requester_email} /></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Category</span></label>
            <select class="select select-sm" bind:value={form.category_id}>
              <option value="">—</option>
              {#each categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
            </select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Priority</span></label>
            <select class="select select-sm" bind:value={form.priority}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Description *</span></label><textarea class="textarea textarea-sm" rows="4" bind:value={form.description}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.subject || !form.description} onclick={createTicket}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
