<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Ticket, Plus, X, Send, AlertCircle, ChevronLeft, MessageSquare } from '@lucide/svelte';
  import { auth } from '$lib/auth.svelte.js';

  let loading = $state(true);
  let tickets = $state<any[]>([]);
  let selected = $state<any>(null);
  let messages = $state<any[]>([]);
  let msgLoading = $state(false);
  let showNew = $state(false);
  let submitting = $state(false);
  let sending = $state(false);
  let error = $state('');
  let reply = $state('');

  let form = $state({ subject: '', message: '', priority: 'normal' });

  async function loadTickets() {
    loading = true;
    try {
      const res = await api.get<{ tickets: any[] }>('/api/portal-client/tickets');
      tickets = res.tickets ?? [];
    } finally {
      loading = false;
    }
  }

  onMount(loadTickets);

  async function openTicket(t: any) {
    selected = t;
    msgLoading = true;
    try {
      const res = await api.get<{ messages: any[] }>(`/api/portal-client/tickets/${t.id}/messages`);
      messages = res.messages ?? [];
    } finally {
      msgLoading = false;
    }
  }

  async function createTicket() {
    if (!form.subject.trim() || !form.message.trim()) {
      error = 'Subiectul și mesajul sunt obligatorii.'; return;
    }
    submitting = true; error = '';
    try {
      const res = await api.post<{ ticket: any }>('/api/portal-client/tickets', form);
      showNew = false;
      form = { subject: '', message: '', priority: 'normal' };
      await loadTickets();
      if (res.ticket) openTicket(res.ticket);
    } catch (e: any) {
      error = e.message || 'Eroare.';
    } finally {
      submitting = false;
    }
  }

  async function sendReply() {
    if (!reply.trim() || !selected) return;
    sending = true;
    try {
      const res = await api.post<{ message: any }>(`/api/portal-client/tickets/${selected.id}/messages`, {
        content: reply,
      });
      if (res.message) messages = [...messages, res.message];
      reply = '';
    } catch (e: any) {
      alert(e.message || 'Eroare la trimitere.');
    } finally {
      sending = false;
    }
  }

  function statusBadge(s: string) {
    const m: Record<string, string> = {
      open: 'badge-warning', in_progress: 'badge-info', resolved: 'badge-success', closed: 'badge-ghost',
    };
    return m[s] ?? 'badge-ghost';
  }

  function statusLabel(s: string) {
    const m: Record<string, string> = {
      open: 'Deschis', in_progress: 'În procesare', resolved: 'Rezolvat', closed: 'Închis',
    };
    return m[s] ?? s;
  }

  function fmtTime(d: string) {
    if (!d) return '';
    const dt = new Date(d);
    return dt.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' }) + ' ' +
      dt.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="max-w-5xl h-full flex flex-col">

  {#if !selected && !showNew}
    <!-- ─── Ticket list ─── -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-xl font-bold text-base-content flex items-center gap-2">
          <Ticket size={20} class="text-primary" /> Suport
        </h1>
        <p class="text-sm text-base-content/50 mt-0.5">Cererile de asistență tehnică și suport</p>
      </div>
      <button class="btn btn-primary btn-sm gap-1.5" onclick={() => { showNew = true; error = ''; }}>
        <Plus size={15} /> Tichet nou
      </button>
    </div>

    {#if loading}
      <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md text-primary"></span></div>
    {:else if tickets.length === 0}
      <div class="card bg-base-200 border border-base-300 flex-1">
        <div class="card-body items-center text-center py-16">
          <Ticket size={40} class="text-base-content/20 mb-3" />
          <p class="font-medium text-sm text-base-content/60">Niciun tichet deschis</p>
          <p class="text-xs text-base-content/40 mt-1 mb-4">Ai o problemă sau o întrebare? Deschide un tichet de suport.</p>
          <button class="btn btn-primary btn-sm gap-1.5" onclick={() => (showNew = true)}>
            <Plus size={15} /> Tichet nou
          </button>
        </div>
      </div>
    {:else}
      <div class="card bg-base-200 border border-base-300 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr class="border-base-300">
                <th class="text-xs font-semibold">Subiect</th>
                <th class="text-xs font-semibold">Prioritate</th>
                <th class="text-xs font-semibold">Status</th>
                <th class="text-xs font-semibold">Creat</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each tickets as t}
                <tr class="border-base-300 hover:bg-base-300/50 transition-colors cursor-pointer" onclick={() => openTicket(t)}>
                  <td class="font-medium text-xs">{t.subject}</td>
                  <td>
                    <span class="badge badge-xs {t.priority === 'urgent' ? 'badge-error' : t.priority === 'high' ? 'badge-warning' : 'badge-ghost'}">
                      {t.priority ?? 'normal'}
                    </span>
                  </td>
                  <td><span class="badge badge-sm {statusBadge(t.status)}">{statusLabel(t.status)}</span></td>
                  <td class="text-xs text-base-content/50">{fmtTime(t.created_at)}</td>
                  <td class="text-right">
                    <button class="btn btn-ghost btn-xs text-primary">Deschide</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

  {:else if showNew}
    <!-- ─── New ticket form ─── -->
    <div class="mb-6 flex items-center gap-3">
      <button class="btn btn-ghost btn-sm gap-1.5" onclick={() => (showNew = false)}>
        <ChevronLeft size={15} /> Înapoi
      </button>
      <h1 class="text-xl font-bold text-base-content">Tichet nou</h1>
    </div>

    <div class="card bg-base-200 border border-base-300 max-w-xl">
      <div class="card-body p-5 gap-4">
        {#if error}
          <div class="alert alert-error text-sm py-2"><AlertCircle size={15} /><span>{error}</span></div>
        {/if}

        <div class="form-control gap-1">
          <label class="label py-0"><span class="label-text text-xs font-medium">Subiect *</span></label>
          <input type="text" bind:value={form.subject} placeholder="Descrie problema pe scurt" class="input input-sm" />
        </div>
        <div class="form-control gap-1">
          <label class="label py-0"><span class="label-text text-xs font-medium">Prioritate</span></label>
          <select class="select select-sm" bind:value={form.priority}>
            <option value="low">Scăzută</option>
            <option value="normal">Normală</option>
            <option value="high">Ridicată</option>
            <option value="urgent">Urgentă</option>
          </select>
        </div>
        <div class="form-control gap-1">
          <label class="label py-0"><span class="label-text text-xs font-medium">Mesaj *</span></label>
          <textarea class="textarea textarea-sm h-32 resize-none" bind:value={form.message}
            placeholder="Descrie în detaliu problema sau întrebarea ta"></textarea>
        </div>

        <div class="flex gap-2 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={() => (showNew = false)}>Anulează</button>
          <button class="btn btn-primary btn-sm" onclick={createTicket} disabled={submitting}>
            {#if submitting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Trimite
          </button>
        </div>
      </div>
    </div>

  {:else if selected}
    <!-- ─── Ticket thread ─── -->
    <div class="flex items-center gap-3 mb-4">
      <button class="btn btn-ghost btn-sm gap-1.5" onclick={() => { selected = null; messages = []; }}>
        <ChevronLeft size={15} /> Înapoi
      </button>
      <div class="flex-1 min-w-0">
        <h1 class="text-base font-bold text-base-content truncate">{selected.subject}</h1>
      </div>
      <span class="badge {statusBadge(selected.status)} badge-sm shrink-0">{statusLabel(selected.status)}</span>
    </div>

    <!-- Messages -->
    <div class="flex-1 overflow-y-auto space-y-3 mb-4 max-h-[calc(100vh-22rem)]">
      {#if msgLoading}
        <div class="flex justify-center py-8"><span class="loading loading-spinner loading-sm text-primary"></span></div>
      {:else if messages.length === 0}
        <p class="text-center text-xs text-base-content/40 py-8">Niciun mesaj.</p>
      {:else}
        {#each messages as msg}
          {@const isMe = msg.sender_id === auth.user?.id}
          <div class="flex {isMe ? 'justify-end' : 'justify-start'}">
            <div class="max-w-[75%] {isMe ? 'bg-primary text-primary-content' : 'bg-base-200 border border-base-300 text-base-content'} rounded-xl px-3.5 py-2.5">
              {#if !isMe}
                <p class="text-[11px] font-semibold opacity-60 mb-1">{msg.sender_name ?? 'Agent'}</p>
              {/if}
              <p class="text-sm leading-relaxed whitespace-pre-line">{msg.content}</p>
              <p class="text-[10px] opacity-50 mt-1 {isMe ? 'text-right' : ''}">{fmtTime(msg.created_at)}</p>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Reply box -->
    {#if selected.status !== 'closed'}
      <div class="flex gap-2 items-end">
        <textarea
          class="textarea textarea-sm flex-1 resize-none h-16"
          placeholder="Scrie un răspuns..."
          bind:value={reply}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
        ></textarea>
        <button class="btn btn-primary btn-sm h-16 px-4" onclick={sendReply} disabled={sending || !reply.trim()}>
          {#if sending}<span class="loading loading-spinner loading-xs"></span>
          {:else}<Send size={15} />{/if}
        </button>
      </div>
      <p class="text-[11px] text-base-content/30 mt-1">Enter pentru trimitere, Shift+Enter pentru linie nouă</p>
    {:else}
      <div class="alert bg-base-200 border border-base-300 text-sm">
        <MessageSquare size={15} />
        <span>Tichetul este închis. Deschide un tichet nou dacă problema persistă.</span>
      </div>
    {/if}
  {/if}
</div>
