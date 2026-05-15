<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { CalendarDays, Plus, X, Check, LoaderCircle } from '@lucide/svelte';

  let requests = $state<any[]>([]);
  let employees = $state<any[]>([]);
  let leaveTypes = $state<any[]>([]);
  let loading = $state(true);
  let statusFilter = $state<'all' | 'pending' | 'approved' | 'rejected'>('all');
  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({ employee_id: '', leave_type_id: '', start_date: '', end_date: '', reason: '' });

  async function loadAll() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [reqs, emps, types] = await Promise.all([
        api.get<{ data: any[] }>(`/ext/hr/leave/requests?${params}`),
        api.get<{ data: any[] }>('/ext/hr/employees?limit=200'),
        api.get<{ data: any[] }>('/ext/hr/leave/types'),
      ]);
      requests = reqs.data ?? [];
      employees = emps.data ?? [];
      leaveTypes = types.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function createRequest() {
    saving = true;
    try {
      await api.post('/ext/hr/leave/requests', form);
      showForm = false;
      form = { employee_id: '', leave_type_id: '', start_date: '', end_date: '', reason: '' };
      await loadAll();
      toast.success('Request submitted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function decide(id: string, approved: boolean) {
    try {
      await api.post(`/ext/hr/leave/requests/${id}/${approved ? 'approve' : 'reject'}`, {});
      await loadAll();
      toast.success(approved ? 'Approved.' : 'Rejected.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => { statusFilter; loadAll(); });

  function statusBadge(s: string) {
    return ({ pending: 'badge-warning', approved: 'badge-success', rejected: 'badge-error', cancelled: 'badge-ghost' } as any)[s] ?? 'badge-ghost';
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><CalendarDays size={20} /> Leave</h1>
      <p class="text-sm text-base-content/50">Manage leave requests and approvals</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New request</button>
  </div>

  <select bind:value={statusFilter} class="select select-sm max-w-xs">
    <option value="all">All</option>
    <option value="pending">Pending</option>
    <option value="approved">Approved</option>
    <option value="rejected">Rejected</option>
  </select>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#if requests.length === 0}
            <tr><td colspan="7" class="text-center py-6 text-base-content/50 text-sm">No requests.</td></tr>
          {:else}
            {#each requests as r (r.id)}
              <tr class="hover">
                <td class="text-sm">{r.employee_name ?? r.employee_id}</td>
                <td class="text-sm">{r.leave_type_name ?? '—'}</td>
                <td class="text-xs">{r.start_date}</td>
                <td class="text-xs">{r.end_date}</td>
                <td class="text-sm">{r.working_days ?? '—'}</td>
                <td><span class="badge {statusBadge(r.status)} badge-sm">{r.status}</span></td>
                <td>
                  {#if r.status === 'pending'}
                    <div class="flex gap-1">
                      <button class="btn btn-ghost btn-xs" title="Approve" onclick={() => decide(r.id, true)}><Check size={13} /></button>
                      <button class="btn btn-ghost btn-xs text-error" title="Reject" onclick={() => decide(r.id, false)}><X size={13} /></button>
                    </div>
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New leave request</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Employee *</span></label>
          <select class="select select-sm" bind:value={form.employee_id}>
            <option value="">—</option>
            {#each employees as e (e.id)}<option value={e.id}>{e.first_name} {e.last_name}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Leave type</span></label>
          <select class="select select-sm" bind:value={form.leave_type_id}>
            <option value="">—</option>
            {#each leaveTypes as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Start date *</span></label><input type="date" class="input input-sm" bind:value={form.start_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">End date *</span></label><input type="date" class="input input-sm" bind:value={form.end_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Reason</span></label><textarea class="textarea textarea-sm" bind:value={form.reason}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.employee_id || !form.start_date || !form.end_date} onclick={createRequest}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Submit request
        </button>
      </div>
    </div>
  </div>
{/if}
