<script lang="ts">
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { Plus, X, LoaderCircle } from '@lucide/svelte';

  type Employee = {
    id: string;
    employee_number: string;
    first_name: string;
    last_name: string;
    email: string;
    department_name?: string | null;
    position_title?: string | null;
    hire_date: string;
    status: string;
  };

  let employees = $state<Employee[]>([]);
  let departments = $state<{ id: string; name: string }[]>([]);
  let positions = $state<{ id: string; title: string }[]>([]);
  let loading = $state(true);
  let search = $state('');
  let statusFilter = $state<'all' | 'active' | 'on_leave' | 'terminated'>('active');
  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    first_name: '', last_name: '', email: '', work_email: '', phone: '',
    hire_date: new Date().toISOString().slice(0, 10),
    department_id: '', position_id: '', employment_type: 'full_time',
    salary: 0, salary_type: 'gross', currency: 'RON', address: '',
  });

  const dash = $derived(m['common.emptyDash']());

  const statusOptions = $derived([
    { value: 'all' as const, label: m['hr.employees.filter.all']() },
    { value: 'active' as const, label: m['hr.employees.filter.active']() },
    { value: 'on_leave' as const, label: m['hr.employees.filter.onLeave']() },
    { value: 'terminated' as const, label: m['hr.employees.filter.terminated']() },
  ]);

  async function loadAll() {
    loading = true;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (search.trim()) params.set('q', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [emps, depts, posList] = await Promise.all([
        api.get<{ data: Employee[] }>(`/ext/hr/employees?${params}`),
        api.get<{ data: { id: string; name: string }[] }>('/ext/hr/employees/departments'),
        api.get<{ data: { id: string; title: string }[] }>('/ext/hr/employees/positions'),
      ]);
      employees = emps.data ?? [];
      departments = depts.data ?? [];
      positions = posList.data ?? [];
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
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
      form = {
        first_name: '', last_name: '', email: '', work_email: '', phone: '',
        hire_date: new Date().toISOString().slice(0, 10),
        department_id: '', position_id: '', employment_type: 'full_time',
        salary: 0, salary_type: 'gross', currency: 'RON', address: '',
      };
      await loadAll();
      toast.success(m['hr.employees.toast.created']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    statusFilter;
    loadAll();
  });

  function statusBadge(s: string) {
    return ({
      active: 'badge-success',
      on_leave: 'badge-warning',
      terminated: 'badge-error',
      inactive: 'badge-ghost',
    } as Record<string, string>)[s] ?? 'badge-ghost';
  }

  function statusLabel(s: string): string {
    const map: Record<string, string> = {
      active: 'hr.employees.status.active',
      on_leave: 'hr.employees.status.onLeave',
      terminated: 'hr.employees.status.terminated',
      inactive: 'hr.employees.status.inactive',
    };
    const key = map[s];
    if (!key) return s;
    return (m as Record<string, () => string>)[key]?.() ?? s;
  }

  function employmentLabel(type: string): string {
    const map: Record<string, string> = {
      full_time: 'hr.employees.employment.fullTime',
      part_time: 'hr.employees.employment.partTime',
      contractor: 'hr.employees.employment.contractor',
      intern: 'hr.employees.employment.intern',
    };
    const key = map[type];
    if (!key) return type;
    return (m as Record<string, () => string>)[key]?.() ?? type;
  }
</script>

<ExtensionPageShell
  title={m['hr.employees.title']()}
  subtitle={m['hr.employees.subtitle']()}
  {search}
  onSearchChange={(v) => { search = v; loadAll(); }}
  searchPlaceholder={m['hr.employees.searchPlaceholder']()}
>
  {#snippet headerExtras()}
    <div class="flex flex-wrap gap-3 items-center">
      <select bind:value={statusFilter} class="select select-sm w-auto">
        {#each statusOptions as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
  {/snippet}

  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['hr.employees.new']()}
    </button>
  {/snippet}

  {#snippet children()}
    <ExtensionDataPanel
      {loading}
      empty={!loading && employees.length === 0}
      emptyTitle={m['hr.employees.empty']()}
    >
      {#snippet table()}
        <table class="table table-sm">
          <thead>
            <tr>
              <th>{m['hr.employees.col.number']()}</th>
              <th>{m['hr.employees.col.name']()}</th>
              <th>{m['hr.employees.col.email']()}</th>
              <th>{m['hr.employees.col.department']()}</th>
              <th>{m['hr.employees.col.position']()}</th>
              <th>{m['hr.employees.col.hireDate']()}</th>
              <th>{m['hr.employees.col.status']()}</th>
            </tr>
          </thead>
          <tbody>
            {#each employees as e (e.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{e.employee_number}</td>
                <td class="font-medium text-sm">{e.first_name} {e.last_name}</td>
                <td class="text-sm">{e.email}</td>
                <td class="text-sm">{e.department_name ?? dash}</td>
                <td class="text-sm">{e.position_title ?? dash}</td>
                <td class="text-xs">{e.hire_date}</td>
                <td>
                  <span class="badge {statusBadge(e.status)} badge-sm">{statusLabel(e.status)}</span>
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
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['hr.employees.form.new']()}</h3>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.firstName']()} *</span></label>
          <input class="input input-sm" bind:value={form.first_name} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.lastName']()} *</span></label>
          <input class="input input-sm" bind:value={form.last_name} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.email']()} *</span></label>
          <input type="email" class="input input-sm" bind:value={form.email} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.workEmail']()}</span></label>
          <input type="email" class="input input-sm" bind:value={form.work_email} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.phone']()}</span></label>
          <input class="input input-sm" bind:value={form.phone} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.hireDate']()}</span></label>
          <input type="date" class="input input-sm" bind:value={form.hire_date} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.department']()}</span></label>
          <select class="select select-sm" bind:value={form.department_id}>
            <option value="">{m['hr.employees.form.none']()}</option>
            {#each departments as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
          </select>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.position']()}</span></label>
          <select class="select select-sm" bind:value={form.position_id}>
            <option value="">{m['hr.employees.form.none']()}</option>
            {#each positions as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
          </select>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.employmentType']()}</span></label>
          <select class="select select-sm" bind:value={form.employment_type}>
            <option value="full_time">{employmentLabel('full_time')}</option>
            <option value="part_time">{employmentLabel('part_time')}</option>
            <option value="contractor">{employmentLabel('contractor')}</option>
            <option value="intern">{employmentLabel('intern')}</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.salary']()}</span></label>
          <input type="number" step="0.01" class="input input-sm" bind:value={form.salary} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.currency']()}</span></label>
          <input class="input input-sm" bind:value={form.currency} maxlength={3} />
        </div>
        <div class="form-control col-span-2">
          <label class="label py-0"><span class="label-text text-xs">{m['hr.employees.form.address']()}</span></label>
          <input class="input input-sm" bind:value={form.address} />
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={saving || !form.first_name || !form.last_name || !form.email}
          onclick={createEmployee}
        >
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
