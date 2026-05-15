<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, X, Trash2, LoaderCircle, Play, Square, Clock, FolderOpen } from '@lucide/svelte';

  type Project = {
    id: string; name: string; client_name: string | null; hourly_rate: number | null;
    currency: string; is_billable: boolean; status: string;
    entry_count: number; total_minutes: number; billable_amount: number;
  };
  type Entry = {
    id: string; project_id: string; description: string | null;
    started_at: string; ended_at: string | null; minutes: number | null;
    is_billable: boolean; is_invoiced: boolean;
  };
  type Timer = { id: string; project_id: string; started_at: string; description: string | null } | null;

  let tab = $state<'projects' | 'entries'>('projects');
  let projects = $state<Project[]>([]);
  let entries = $state<Entry[]>([]);
  let timer = $state<Timer>(null);
  let loading = $state(false);
  let showModal = $state(false);
  let saving = $state(false);
  let deleting = $state<string | null>(null);

  let projectForm = $state({ name: '', client_name: '', hourly_rate: '', currency: 'RON', is_billable: true });
  let timerForm = $state({ project_id: '', description: '' });

  onMount(async () => {
    await Promise.all([loadProjects(), loadTimer()]);
    await loadEntries();
  });

  async function loadProjects() {
    const r = await api.get<{ data: Project[] }>('/ext/hr/time-tracking/projects').catch(() => ({ data: [] }));
    projects = r.data ?? [];
  }
  async function loadEntries() {
    loading = true;
    try {
      const r = await api.get<{ data: Entry[] }>('/ext/hr/time-tracking/entries');
      entries = r.data ?? [];
    } catch { /* ignore */ }
    finally { loading = false; }
  }
  async function loadTimer() {
    const r = await api.get<{ timer: Timer }>('/ext/hr/time-tracking/timer').catch(() => ({ timer: null }));
    timer = r.timer;
  }

  async function createProject() {
    saving = true;
    try {
      const r = await api.post<{ data: Project }>('/ext/hr/time-tracking/projects', {
        ...projectForm,
        hourly_rate: projectForm.hourly_rate ? parseFloat(projectForm.hourly_rate) : null,
      });
      projects = [r.data, ...projects];
      projectForm = { name: '', client_name: '', hourly_rate: '', currency: 'RON', is_billable: true };
      showModal = false;
      toast.success('Project created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function startTimer() {
    if (!timerForm.project_id) return;
    saving = true;
    try {
      const r = await api.post<{ timer: Timer }>('/ext/hr/time-tracking/timer/start', timerForm);
      timer = r.timer;
      timerForm = { project_id: '', description: '' };
      showModal = false;
      toast.success('Timer started.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function stopTimer() {
    saving = true;
    try {
      await api.post('/ext/hr/time-tracking/timer/stop', {});
      timer = null;
      await loadEntries();
      toast.success('Timer stopped.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function deleteEntry(id: string) {
    if (!confirm('Delete this time entry?')) return;
    deleting = id;
    try {
      await api.delete(`/ext/hr/time-tracking/entries/${id}`);
      entries = entries.filter(e => e.id !== id);
      toast.success('Deleted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { deleting = null; }
  }

  function fmtMinutes(m: number | null) {
    if (m == null) return '—';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return h > 0 ? `${h}h ${min}m` : `${min}m`;
  }

  const projectName = (id: string) => projects.find(p => p.id === id)?.name ?? id;
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Time Tracking</h1>
      <p class="text-sm text-base-content/50">Track time across projects and clients</p>
    </div>
    <div class="flex gap-2">
      {#if timer}
        <button class="btn btn-error btn-sm gap-1" onclick={stopTimer} disabled={saving}>
          <Square size={13} /> Stop Timer
        </button>
      {:else}
        <button class="btn btn-outline btn-sm gap-1" onclick={() => { tab = 'entries'; showModal = true; }}>
          <Play size={13} /> Start Timer
        </button>
      {/if}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => { tab = 'projects'; showModal = true; }}>
        <Plus size={14} /> New Project
      </button>
    </div>
  </div>

  {#if timer}
    <div class="alert alert-info">
      <Clock size={16} />
      <span class="text-sm">Timer running on <strong>{projectName(timer.project_id)}</strong>
        {#if timer.description} — {timer.description}{/if}
        (started {new Date(timer.started_at).toLocaleTimeString()})
      </span>
    </div>
  {/if}

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'projects' ? 'tab-active' : ''}" onclick={() => (tab = 'projects')}>
      <FolderOpen size={13} class="mr-1.5" /> Projects
    </button>
    <button class="tab {tab === 'entries' ? 'tab-active' : ''}" onclick={() => { tab = 'entries'; loadEntries(); }}>
      <Clock size={13} class="mr-1.5" /> Entries
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'projects'}
    {#if projects.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No projects yet</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Project</th><th>Client</th><th>Rate</th><th>Hours</th><th>Billable</th><th>Status</th></tr></thead>
          <tbody>
            {#each projects as p (p.id)}
              <tr class="hover">
                <td class="font-medium">{p.name}</td>
                <td class="text-base-content/60">{p.client_name ?? '—'}</td>
                <td class="text-base-content/60">{p.hourly_rate ? `${p.hourly_rate} ${p.currency}/h` : '—'}</td>
                <td>{fmtMinutes(p.total_minutes)}</td>
                <td class="text-success">{p.billable_amount > 0 ? `${p.billable_amount.toFixed(2)} ${p.currency}` : '—'}</td>
                <td><span class="badge badge-xs {p.status === 'active' ? 'badge-success' : 'badge-ghost'}">{p.status}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    {#if entries.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No time entries yet</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Project</th><th>Description</th><th>Duration</th><th>Date</th><th>Billable</th><th></th></tr></thead>
          <tbody>
            {#each entries as e (e.id)}
              <tr class="hover">
                <td class="text-sm">{projectName(e.project_id)}</td>
                <td class="text-base-content/60 text-sm">{e.description ?? '—'}</td>
                <td class="font-medium">{fmtMinutes(e.minutes)}</td>
                <td class="text-xs text-base-content/40">{new Date(e.started_at).toLocaleDateString()}</td>
                <td>{#if e.is_billable}<span class="badge badge-xs badge-success">Billable</span>{:else}<span class="badge badge-xs badge-ghost">Internal</span>{/if}</td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" disabled={deleting === e.id}
                    onclick={() => deleteEntry(e.id)}>
                    {#if deleting === e.id}<LoaderCircle size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if}
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

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-sm">
      {#if tab === 'projects'}
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold">New Project</h3>
          <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
        </div>
        <div class="space-y-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Project Name *</span></label>
            <input class="input input-sm" bind:value={projectForm.name} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Client</span></label>
            <input class="input input-sm" bind:value={projectForm.client_name} /></div>
          <div class="grid grid-cols-2 gap-2">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Hourly Rate</span></label>
              <input class="input input-sm" type="number" bind:value={projectForm.hourly_rate} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label>
              <input class="input input-sm" bind:value={projectForm.currency} /></div>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="checkbox checkbox-sm" bind:checked={projectForm.is_billable} />
            <span class="text-sm">Billable project</span>
          </label>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm" onclick={createProject} disabled={!projectForm.name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin mr-1" />{/if}Create
          </button>
        </div>
      {:else}
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold">Start Timer</h3>
          <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
        </div>
        <div class="space-y-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Project *</span></label>
            <select class="select select-sm" bind:value={timerForm.project_id}>
              <option value="">— Select project —</option>
              {#each projects as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Description</span></label>
            <input class="input input-sm" bind:value={timerForm.description} /></div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm gap-1" onclick={startTimer} disabled={!timerForm.project_id || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{:else}<Play size={13} />{/if}Start
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
