<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Plus, X, Trash2, LoaderCircle, Play, Square, Clock, FolderOpen } from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

type Project = {
  id: string;
  name: string;
  client_name: string | null;
  hourly_rate: number | null;
  currency: string;
  is_billable: boolean;
  status: string;
  entry_count: number;
  total_minutes: number;
  billable_amount: number;
};
type Entry = {
  id: string;
  project_id: string;
  description: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number | null;
  is_billable: boolean;
  is_invoiced: boolean;
};
type Timer = {
  id: string;
  project_id: string;
  started_at: string;
  description: string | null;
} | null;

let tab = $state<'projects' | 'entries'>('projects');
let projects = $state<Project[]>([]);
let entries = $state<Entry[]>([]);
let timer = $state<Timer>(null);
let loading = $state(false);
let showModal = $state(false);
let saving = $state(false);
let deleting = $state<string | null>(null);

let projectForm = $state({
  name: '',
  client_name: '',
  hourly_rate: '',
  currency: 'RON',
  is_billable: true,
});
let timerForm = $state({ project_id: '', description: '' });

onMount(async () => {
  await Promise.all([loadProjects(), loadTimer()]);
  await loadEntries();
});

async function loadProjects() {
  const r = await api
    .get<{ data: Project[] }>('/ext/hr/time-tracking/projects')
    .catch(() => ({ data: [] }));
  projects = r.data ?? [];
}
async function loadEntries() {
  loading = true;
  try {
    const r = await api.get<{ data: Entry[] }>('/ext/hr/time-tracking/entries');
    entries = r.data ?? [];
  } catch {
    /* ignore */
  } finally {
    loading = false;
  }
}
async function loadTimer() {
  const r = await api
    .get<{ timer: Timer }>('/ext/hr/time-tracking/timer')
    .catch(() => ({ timer: null }));
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
    projectForm = {
      name: '',
      client_name: '',
      hourly_rate: '',
      currency: 'RON',
      is_billable: true,
    };
    showModal = false;
    toast.success(m['ext.created']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function startTimer() {
  if (!timerForm.project_id) return;
  saving = true;
  try {
    const r = await api.post<{ timer: Timer }>('/ext/hr/time-tracking/timer/start', timerForm);
    timer = r.timer;
    timerForm = { project_id: '', description: '' };
    showModal = false;
    toast.success(m['hr.timeTracking.toast.started']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function stopTimer() {
  saving = true;
  try {
    await api.post('/ext/hr/time-tracking/timer/stop', {});
    timer = null;
    await loadEntries();
    toast.success(m['hr.timeTracking.toast.stopped']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function deleteEntry(id: string) {
  askConfirm(m['hr.timeTracking.confirmDelete'](), () => deleteEntryConfirmed(id));
}
async function deleteEntryConfirmed(id: string) {
  deleting = id;
  try {
    await api.delete(`/ext/hr/time-tracking/entries/${id}`);
    entries = entries.filter((e) => e.id !== id);
    toast.success(m['ext.deleted']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    deleting = null;
  }
}

function fmtMinutes(minutes: number | null) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}

const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
</script>

<ExtensionPageShell title={m['hr.time-tracking.title']()} subtitle={m['hr.time-tracking.subtitle']()}>
<div class="flex gap-2">
      {#if timer}
        <button type="button" class="btn btn-error btn-sm gap-1" onclick={stopTimer} disabled={saving}>
          <Square size={13} /> {m['hr.time-tracking.ui.stopTimer']()}
        </button>
      {:else}
        <button type="button" class="btn btn-outline btn-sm gap-1" onclick={() => { tab = 'entries'; showModal = true; }}>
          <Play size={13} /> {m['hr.time-tracking.ui.startTimerBtn']()}
        </button>
      {/if}
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => { tab = 'projects'; showModal = true; }}>
        <Plus size={14} /> {m['hr.time-tracking.ui.newProjectBtn']()}
      </button>
    </div>

{#if timer}
    <div class="alert alert-info">
      <Clock size={16} />
      <span class="text-sm">{m['hr.time-tracking.timer.running']()} <strong>{projectName(timer.project_id)}</strong>
        {#if timer.description} — {timer.description}{/if}
        ({m['hr.time-tracking.timer.started']()} {new Date(timer.started_at).toLocaleTimeString()})
      </span>
    </div>
  {/if}

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'projects' ? 'tab-active' : ''}" onclick={() => (tab = 'projects')}>
      <FolderOpen size={13} class="mr-1.5" /> {m['hr.time-tracking.tab.projects']()}
    </button>
    <button class="tab {tab === 'entries' ? 'tab-active' : ''}" onclick={() => { tab = 'entries'; loadEntries(); }}>
      <Clock size={13} class="mr-1.5" /> {m['hr.time-tracking.tab.entries']()}
    </button>
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'projects'}
    {#if projects.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">{m['hr.time-tracking.empty.projects']()}</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>{m['common.col.project']()}</th><th>{m['common.col.client']()}</th><th>{m['hr.time-tracking.col.rate']()}</th><th>{m['hr.time-tracking.col.hours']()}</th><th>{m['hr.time-tracking.col.billable']()}</th><th>{m['common.col.status']()}</th></tr></thead>
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
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">{m['hr.time-tracking.empty.entries']()}</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>{m['common.col.project']()}</th><th>{m['common.col.description']()}</th><th>{m['common.col.duration']()}</th><th>{m['common.col.date']()}</th><th>{m['hr.time-tracking.col.billable']()}</th><th></th></tr></thead>
          <tbody>
            {#each entries as e (e.id)}
              <tr class="hover">
                <td class="text-sm">{projectName(e.project_id)}</td>
                <td class="text-base-content/60 text-sm">{e.description ?? '—'}</td>
                <td class="font-medium">{fmtMinutes(e.minutes)}</td>
                <td class="text-xs text-base-content/40">{new Date(e.started_at).toLocaleDateString()}</td>
                <td>{#if e.is_billable}<span class="badge badge-xs badge-success">{m['hr.time-tracking.badge.billable']()}</span>{:else}<span class="badge badge-xs badge-ghost">{m['hr.time-tracking.badge.internal']()}</span>{/if}</td>
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
    <div class="modal-box max-w-sm">
      {#if tab === 'projects'}
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold">{m['hr.time-tracking.ui.new_project']()}</h3>
          <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
        </div>
        <div class="space-y-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['hr.time-tracking.ui.project_name']()}</span></label>
            <input class="input input-sm" bind:value={projectForm.name} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['invoicing.col.client']()}</span></label>
            <input class="input input-sm" bind:value={projectForm.client_name} /></div>
          <div class="grid grid-cols-2 gap-2">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['hr.time-tracking.ui.hourly_rate']()}</span></label>
              <input class="input input-sm" type="number" bind:value={projectForm.hourly_rate} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
              <input class="input input-sm" bind:value={projectForm.currency} /></div>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="checkbox checkbox-sm" bind:checked={projectForm.is_billable} />
            <span class="text-sm">{m['hr.time-tracking.form.billableProject']()}</span>
          </label>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
          <button class="btn btn-primary btn-sm" onclick={createProject} disabled={!projectForm.name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin mr-1" />{/if}{m['common.create']()}
          </button>
        </div>
      {:else}
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold">{m['hr.time-tracking.ui.start_timer']()}</h3>
          <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
        </div>
        <div class="space-y-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['hr.time-tracking.ui.project']()}</span></label>
            <select class="select select-sm" bind:value={timerForm.project_id}>
              <option value="">{m['hr.time-tracking.ui.select_project']()}</option>
              {#each projects as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['hr.time-tracking.ui.description']()}</span></label>
            <input class="input input-sm" bind:value={timerForm.description} /></div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
          <button class="btn btn-primary btn-sm gap-1" onclick={startTimer} disabled={!timerForm.project_id || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin" />{:else}<Play size={13} />{/if}{m['hr.time-tracking.ui.startTimerBtn']()}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
