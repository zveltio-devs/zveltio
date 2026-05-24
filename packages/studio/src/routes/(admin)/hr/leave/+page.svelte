<script lang="ts">
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { Plus, X, Check, LoaderCircle } from '@lucide/svelte';

  let requests = $state<any[]>([]);
  let employees = $state<any[]>([]);
  let leaveTypes = $state<any[]>([]);
  let loading = $state(true);
  let statusFilter = $state<'all' | 'pending' | 'approved' | 'rejected'>('all');
  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({ employee_id: '', leave_type_id: '', start_date: '', end_date: '', reason: '' });

  const dash = $derived(m['common.emptyDash']());
  const statusOptions = $derived([
    { value: 'all' as const, label: m['common.filter.all']() },
    { value: 'pending' as const, label: m['common.status.pending']() },
    { value: 'approved' as const, label: m['common.status.approved']() },
    { value: 'rejected' as const, label: m['common.status.rejected']() },
  ]);

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
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
  }

  async function createRequest() {
    saving = true;
    try {
      await api.post('/ext/hr/leave/requests', form);
      showForm = false;
      form = { employee_id: '', leave_type_id: '', start_date: '', end_date: '', reason: '' };
      await loadAll();
      toast.success(m['ext.submitted']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  async function decide(id: string, approved: boolean) {
    try {
      await api.post(`/ext/hr/leave/requests/${id}/${approved ? 'approve' : 'reject'}`, {});
      await loadAll();
      toast.success(approved ? m['ext.approved']() : m['ext.rejected']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    }
  }

  $effect(() => { statusFilter; loadAll(); });

  function statusBadge(s: string) {
    return ({
      pending: 'badge-warning', approved: 'badge-success', rejected: 'badge-error', cancelled: 'badge-ghost',
    } as Record<string, string>)[s] ?? 'badge-ghost';
  }
</script>

<ExtensionPageShell title={m['hr.leave.title']()} subtitle={m['hr.leave.subtitle']()}>
  {#snippet headerExtras()}
    <select bind:value={statusFilter} class="select select-sm max-w-xs">
      {#each statusOptions as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  {/snippet}

  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['hr.leave.new']()}
    </button>
  {/snippet}

  {#snippet children()}
    <ExtensionDataPanel {loading} empty={!loading && requests.length === 0} emptyTitle={m['hr.leave.emptyRequests']()}>
      {#snippet table()}
        <table class="table table-sm">
          <thead>
            <tr>
              <th>{m['common.col.employee']()}</th>
              <th>{m['common.col.type']()}</th>
              <th>{m['common.col.from']()}</th>
              <th>{m['common.col.to']()}</th>
              <th>{m['common.col.days']()}</th>
              <th>{m['common.col.status']()}</th>
              <th>{m['common.actions']()}</th>
            </tr>
          </thead>
          <tbody>
            {#each requests as r (r.id)}
              <tr class="hover">
                <td class="text-sm">{r.employee_name ?? r.employee_id}</td>
                <td class="text-sm">{r.leave_type_name ?? dash}</td>
                <td class="text-xs">{r.start_date}</td>
                <td class="text-xs">{r.end_date}</td>
                <td class="text-sm">{r.working_days ?? dash}</td>
                <td><span class="badge {statusBadge(r.status)} badge-sm">{r.status}</span></td>
                <td>
                  {#if r.status === 'pending'}
                    <div class="flex gap-1">
                      <button type="button" class="btn btn-ghost btn-xs" title={m['ext.approved']()} onclick={() => decide(r.id, true)}><Check size={13} /></button>
                      <button type="button" class="btn btn-ghost btn-xs text-error" title={m['ext.rejected']()} onclick={() => decide(r.id, false)}><X size={13} /></button>
                    </div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </ExtensionDataPanel>
  {/snippet}
</ExtensionPageShell>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['hr.leave.form.new']()}</h3>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.employee']()} *</span></label>
          <select class="select select-sm" bind:value={form.employee_id}>
            <option value="">{dash}</option>
            {#each employees as e (e.id)}<option value={e.id}>{e.first_name} {e.last_name}</option>{/each}
          </select>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.leaveType']()}</span></label>
          <select class="select select-sm" bind:value={form.leave_type_id}>
            <option value="">{dash}</option>
            {#each leaveTypes as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
          </select>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.from']()} *</span></label>
          <input type="date" class="input input-sm" bind:value={form.start_date} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.to']()} *</span></label>
          <input type="date" class="input input-sm" bind:value={form.end_date} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.reason']()}</span></label>
          <textarea class="textarea textarea-sm" bind:value={form.reason}></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button type="button" class="btn btn-primary btn-sm" disabled={saving || !form.employee_id || !form.start_date || !form.end_date} onclick={createRequest}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['hr.leave.form.submit']()}
        </button>
      </div>
    </div>
  </div>
{/if}
