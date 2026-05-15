<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { FolderKanban, Plus, X, List, KanbanSquare, LoaderCircle } from '@lucide/svelte';

  let view = $state<'list' | 'board'>('board');
  let projects = $state<any[]>([]);
  let activeProject = $state<any | null>(null);
  let tasks = $state<any[]>([]);
  let loading = $state(true);

  let showProjectForm = $state(false);
  let showTaskForm = $state(false);
  let saving = $state(false);
  let projectForm = $state({ name: '', description: '', start_date: '', end_date: '' });
  let taskForm = $state({ title: '', description: '', status: 'todo', priority: 'medium', assignee_id: '', due_date: '' });

  const STATUSES = [
    { id: 'todo', label: 'To do' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
  ];

  async function loadProjects() {
    loading = true;
    try {
      const r = await api.get<{ data: any[] }>('/ext/projects/management');
      projects = r.data ?? [];
      if (!activeProject && projects[0]) activeProject = projects[0];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }
  async function loadTasks() {
    if (!activeProject) { tasks = []; return; }
    try { const r = await api.get<{ data: any[] }>(`/ext/projects/management/${activeProject.id}/tasks`); tasks = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }
  async function createProject() {
    saving = true;
    try {
      await api.post('/ext/projects/management', projectForm);
      showProjectForm = false;
      projectForm = { name: '', description: '', start_date: '', end_date: '' };
      await loadProjects();
      toast.success('Project created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }
  async function createTask() {
    if (!activeProject) return;
    saving = true;
    try {
      await api.post(`/ext/projects/management/${activeProject.id}/tasks`, taskForm);
      showTaskForm = false;
      taskForm = { title: '', description: '', status: 'todo', priority: 'medium', assignee_id: '', due_date: '' };
      await loadTasks();
      toast.success('Task created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }
  async function moveTask(taskId: string, status: string) {
    try {
      await api.patch(`/ext/projects/management/tasks/${taskId}`, { status });
      await loadTasks();
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  onMount(loadProjects);
  $effect(() => { activeProject; loadTasks(); });

  function tasksByStatus(s: string) { return tasks.filter((t) => t.status === s); }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><FolderKanban size={20} /> Projects</h1>
      <p class="text-sm text-base-content/50">Kanban board and task management</p>
    </div>
    <div class="flex gap-2">
      <div class="join">
        <button class="btn btn-sm join-item {view === 'board' ? 'btn-active' : ''}" onclick={() => (view = 'board')}><KanbanSquare size={14} /></button>
        <button class="btn btn-sm join-item {view === 'list' ? 'btn-active' : ''}" onclick={() => (view = 'list')}><List size={14} /></button>
      </div>
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showProjectForm = true)}><Plus size={14} /> New project</button>
    </div>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if projects.length === 0}
    <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">No projects yet.</div></div>
  {:else}
    <div class="flex gap-3 items-center">
      <select class="select select-sm" value={activeProject?.id ?? ''} onchange={(e) => { activeProject = projects.find((p) => p.id === (e.target as HTMLSelectElement).value) ?? null; }}>
        {#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
      {#if activeProject}<button class="btn btn-sm gap-1" onclick={() => (showTaskForm = true)}><Plus size={13} /> New task</button>{/if}
    </div>

    {#if view === 'board'}
      <div class="grid grid-cols-4 gap-3">
        {#each STATUSES as s (s.id)}
          <div class="bg-base-200 rounded-lg p-3">
            <div class="font-medium text-sm mb-3 flex items-center justify-between">
              <span>{s.label}</span>
              <span class="badge badge-sm badge-ghost">{tasksByStatus(s.id).length}</span>
            </div>
            <div class="space-y-2 min-h-24">
              {#each tasksByStatus(s.id) as t (t.id)}
                <div class="card bg-base-100 shadow-sm">
                  <div class="card-body p-3">
                    <div class="font-medium text-sm">{t.title}</div>
                    {#if t.description}<div class="text-xs text-base-content/60 mt-0.5 line-clamp-2">{t.description}</div>{/if}
                    <div class="flex flex-wrap gap-1 mt-1">
                      {#each STATUSES.filter((x) => x.id !== s.id) as target (target.id)}
                        <button class="btn btn-ghost btn-xs text-xs" onclick={() => moveTask(t.id, target.id)}>→ {target.label}</button>
                      {/each}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Due date</th><th>Assignee</th></tr></thead>
          <tbody>
            {#if tasks.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No tasks.</td></tr>
            {:else}{#each tasks as t (t.id)}
              <tr class="hover"><td class="text-sm">{t.title}</td><td><span class="badge badge-sm badge-ghost">{t.status}</span></td><td><span class="badge badge-sm">{t.priority}</span></td><td class="text-xs">{t.due_date ?? '—'}</td><td class="text-sm">{t.assignee_name ?? '—'}</td></tr>
            {/each}{/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

{#if showProjectForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New project</h3><button class="btn btn-ghost btn-xs" onclick={() => (showProjectForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Name *</span></label><input class="input input-sm" bind:value={projectForm.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Description</span></label><textarea class="textarea textarea-sm" bind:value={projectForm.description}></textarea></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Start date</span></label><input type="date" class="input input-sm" bind:value={projectForm.start_date} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">End date</span></label><input type="date" class="input input-sm" bind:value={projectForm.end_date} /></div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showProjectForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !projectForm.name} onclick={createProject}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showTaskForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New task</h3><button class="btn btn-ghost btn-xs" onclick={() => (showTaskForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Title *</span></label><input class="input input-sm" bind:value={taskForm.title} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Description</span></label><textarea class="textarea textarea-sm" bind:value={taskForm.description}></textarea></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Status</span></label>
            <select class="select select-sm" bind:value={taskForm.status}>{#each STATUSES as s (s.id)}<option value={s.id}>{s.label}</option>{/each}</select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Priority</span></label>
            <select class="select select-sm" bind:value={taskForm.priority}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
          </div>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Due date</span></label><input type="date" class="input input-sm" bind:value={taskForm.due_date} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showTaskForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !taskForm.title} onclick={createTask}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
