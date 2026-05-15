<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Users, Plus, X, Search, LoaderCircle } from '@lucide/svelte';

  let employees = $state<any[]>([]);
  let departments = $state<any[]>([]);
  let positions = $state<any[]>([]);
  let loading = $state(true);
  let q = $state('');
  let statusFilter = $state<'all' | 'active' | 'on_leave' | 'terminated'>('active');
  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    first_name: '', last_name: '', email: '', work_email: '', phone: '',
    hire_date: new Date().toISOString().slice(0, 10),
    department_id: '', position_id: '', employment_type: 'full_time',
    salary: 0, salary_type: 'gross', currency: 'RON', address: '',
  });

  async function loadAll() {
    loading = true;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (q) params.set('q', q);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [emps, depts, posList] = await Promise.all([
        api.get<{ data: any[] }>(`/ext/hr/employees?${params}`),
        api.get<{ data: any[] }>('/ext/hr/employees/departments'),
        api.get<{ data: any[] }>('/ext/hr/employees/positions'),
      ]);
      employees = emps.data ?? [];
      departments = depts.data ?? [];
      positions = posList.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function createEmployee() {
    saving = true;
    try {
      await api.post('/ext/hr/employees', {
        ...form,
        department_id: form.department_id || undefined,
        position_id: form.position_id || undefined,
        salary: form.salary || undefined,
      });
      showForm = false;
      form = { first_name: '', last_name: '', email: '', work_email: '', phone: '',
               hire_date: new Date().toISOString().slice(0, 10),
               department_id: '', position_id: '', employment_type: 'full_time',
               salary: 0, salary_type: 'gross', currency: 'RON', address: '' };
      await loadAll();
      toast.success('Employee created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  $effect(() => { statusFilter; loadAll(); });

  function statusBadge(s: string) {
    return ({ active: 'badge-success', on_leave: 'badge-warning', terminated: 'badge-error', inactive: 'badge-ghost' } as any)[s] ?? 'badge-ghost';
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Users size={20} /> Employees</h1>
      <p class="text-sm text-base-content/50">Manage your workforce</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New employee</button>
  </div>

  <div class="flex gap-3 items-center flex-wrap">
    <div class="join">
      <input type="text" placeholder="Search name, email…" class="input input-sm join-item"
             bind:value={q} onkeydown={(e: any) => e.key === 'Enter' && loadAll()} />
      <button class="btn btn-sm join-item" onclick={loadAll}><Search size={14} /></button>
    </div>
    <select bind:value={statusFilter} class="select select-sm">
      <option value="all">All statuses</option>
      <option value="active">Active</option>
      <option value="on_leave">On leave</option>
      <option value="terminated">Terminated</option>
    </select>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Department</th><th>Position</th><th>Hire date</th><th>Status</th></tr></thead>
        <tbody>
          {#if employees.length === 0}
            <tr><td colspan="7" class="text-center py-6 text-base-content/50 text-sm">No employees yet.</td></tr>
          {:else}
            {#each employees as e (e.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{e.employee_number}</td>
                <td class="font-medium text-sm">{e.first_name} {e.last_name}</td>
                <td class="text-sm">{e.email}</td>
                <td class="text-sm">{e.department_name ?? '—'}</td>
                <td class="text-sm">{e.position_title ?? '—'}</td>
                <td class="text-xs">{e.hire_date}</td>
                <td><span class="badge {statusBadge(e.status)} badge-sm">{e.status}</span></td>
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
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New employee</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">First name *</span></label><input class="input input-sm" bind:value={form.first_name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Last name *</span></label><input class="input input-sm" bind:value={form.last_name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Email *</span></label><input type="email" class="input input-sm" bind:value={form.email} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Work email</span></label><input type="email" class="input input-sm" bind:value={form.work_email} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Phone</span></label><input class="input input-sm" bind:value={form.phone} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Hire date</span></label><input type="date" class="input input-sm" bind:value={form.hire_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Department</span></label>
          <select class="select select-sm" bind:value={form.department_id}>
            <option value="">— None —</option>
            {#each departments as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Position</span></label>
          <select class="select select-sm" bind:value={form.position_id}>
            <option value="">— None —</option>
            {#each positions as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Employment type</span></label>
          <select class="select select-sm" bind:value={form.employment_type}>
            <option value="full_time">Full time</option><option value="part_time">Part time</option>
            <option value="contractor">Contractor</option><option value="intern">Intern</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Salary</span></label><input type="number" step="0.01" class="input input-sm" bind:value={form.salary} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label><input class="input input-sm" bind:value={form.currency} maxlength={3} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Address</span></label><input class="input input-sm" bind:value={form.address} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.first_name || !form.last_name || !form.email} onclick={createEmployee}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create employee
        </button>
      </div>
    </div>
  </div>
{/if}
