<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Headphones, Plus, X, LoaderCircle } from '@lucide/svelte';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let tickets = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let categories = $state<any[]>([]);
let loading = $state(true);
let statusFilter = $state<'all' | 'open' | 'pending' | 'resolved' | 'closed'>('open');
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let activeTicket = $state<any | null>(null);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let messages = $state<any[]>([]);
let newMessage = $state('');

let showForm = $state(false);
let saving = $state(false);
let form = $state({
  subject: '',
  description: '',
  category_id: '',
  priority: 'medium',
  requester_email: '',
});

async function loadTickets() {
  loading = true;
  try {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const r = await api.get<{ data: any[] }>(`/ext/projects/helpdesk/tickets?${params}`);
    tickets = r.data ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}
async function loadCategories() {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const r = await api.get<{ data: any[] }>('/ext/projects/helpdesk/categories');
    categories = r.data ?? [];
  } catch {}
}
async function loadMessages(id: string) {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const r = await api.get<{ data: any[] }>(`/ext/projects/helpdesk/tickets/${id}/messages`);
    messages = r.data ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function createTicket() {
  saving = true;
  try {
    await api.post('/ext/projects/helpdesk/tickets', form);
    showForm = false;
    form = {
      subject: '',
      description: '',
      category_id: '',
      priority: 'medium',
      requester_email: '',
    };
    await loadTickets();
    toast.success(m['ext.created']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function reply() {
  if (!activeTicket || !newMessage.trim()) return;
  try {
    await api.post(`/ext/projects/helpdesk/tickets/${activeTicket.id}/messages`, {
      body: newMessage,
    });
    newMessage = '';
    await loadMessages(activeTicket.id);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function resolve(id: string) {
  try {
    await api.post(`/ext/projects/helpdesk/tickets/${id}/resolve`, {});
    await loadTickets();
    if (activeTicket?.id === id) activeTicket = null;
    toast.success(m['projects.helpdesk.toast.resolved']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

$effect(() => {
  statusFilter;
  loadTickets();
});
$effect(() => {
  if (activeTicket) loadMessages(activeTicket.id);
});
onMount(() => {
  loadTickets();
  loadCategories();
});

function priorityBadge(p: string) {
  return (
    (
      {
        low: 'badge-ghost',
        medium: 'badge-info',
        high: 'badge-warning',
        urgent: 'badge-error',
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } as any
    )[p] ?? 'badge-ghost'
  );
}
</script>

<ExtensionPageShell title={m['projects.helpdesk.title']()} subtitle={m['projects.helpdesk.subtitle']()}>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> {m['projects.helpdesk.btn.new']()}</button>
  {/snippet}

<div class="col-span-7 card bg-base-200 border border-base-300">
        <div class="card-body p-4">
          {#if !activeTicket}
            <div class="text-center py-12 text-base-content/50 text-sm">{m['projects.helpdesk.empty.select']()}</div>
          {:else}
            <div class="flex items-start justify-between mb-3 gap-4">
              <div>
                <div class="font-medium text-sm">{activeTicket.subject}</div>
                <div class="text-xs text-base-content/60">From: {activeTicket.requester_email ?? activeTicket.requester_id ?? '—'}</div>
</div>

{#if activeTicket.status !== 'resolved' && activeTicket.status !== 'closed'}
                <button class="btn btn-success btn-sm shrink-0" onclick={() => resolve(activeTicket!.id)}>{m['projects.helpdesk.btn.resolve']()}</button>
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
              <textarea class="textarea textarea-sm flex-1" rows="2" placeholder={m['projects.helpdesk.ui.reply']()} bind:value={newMessage}></textarea>
              <button class="btn btn-primary btn-sm self-end" disabled={!newMessage.trim()} onclick={reply}>{m['common.send']()}</button>
            </div>
          {/if}
        </div>
      </div>
</ExtensionPageShell>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">{m['projects.helpdesk.ui.new_ticket']()}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['projects.helpdesk.ui.subject']()}</span></label><input class="input input-sm" bind:value={form.subject} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['projects.helpdesk.ui.requester_email']()}</span></label><input type="email" class="input input-sm" bind:value={form.requester_email} /></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.col.category']()}</span></label>
            <select class="select select-sm" bind:value={form.category_id}>
              <option value="">—</option>
              {#each categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
            </select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['projects.helpdesk.ui.priority']()}</span></label>
            <select class="select select-sm" bind:value={form.priority}>
              <option value="low">{m['communications.mail.ui.low']()}</option><option value="medium">{m['projects.helpdesk.ui.medium']()}</option><option value="high">{m['communications.mail.ui.high']()}</option><option value="urgent">{m['projects.helpdesk.ui.urgent']()}</option>
            </select>
          </div>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['projects.helpdesk.ui.description']()}</span></label><textarea class="textarea textarea-sm" rows="4" bind:value={form.description}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.subject || !form.description} onclick={createTicket}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['projects.helpdesk.btn.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
