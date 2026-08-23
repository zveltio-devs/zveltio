<script lang="ts">
/**
 * Kanban board over /ext/projects/management tasks (status columns + PATCH).
 */
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';

const API = '/ext/projects/management';
const COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'in_review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
] as const;

type Project = { id: string; name: string };
type Task = {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  sort_order?: number | null;
};

let projects = $state<Project[]>([]);
let projectId = $state<string | null>(null);
let tasks = $state<Task[]>([]);
let loading = $state(true);
let draggingId = $state<string | null>(null);

const byStatus = $derived(
  Object.fromEntries(COLUMNS.map((c) => [c.id, tasks.filter((t) => t.status === c.id)])) as Record<
    string,
    Task[]
  >,
);

async function loadProjects(): Promise<void> {
  loading = true;
  try {
    const r = await api.get<{ projects?: Project[]; data?: Project[] }>(API);
    projects = r.projects ?? r.data ?? [];
    if (!projectId && projects[0]) projectId = projects[0].id;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to load projects');
  } finally {
    loading = false;
  }
}

async function loadTasks(): Promise<void> {
  if (!projectId) {
    tasks = [];
    return;
  }
  try {
    const r = await api.get<{ tasks?: Task[]; data?: Task[] }>(`${API}/${projectId}/tasks`);
    tasks = r.tasks ?? r.data ?? [];
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to load tasks');
    tasks = [];
  }
}

async function moveTask(taskId: string, status: string): Promise<void> {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.status === status) return;
  const prev = task.status;
  tasks = tasks.map((t) => (t.id === taskId ? { ...t, status } : t));
  try {
    await api.patch(`${API}/tasks/${taskId}`, { status });
  } catch (err) {
    tasks = tasks.map((t) => (t.id === taskId ? { ...t, status: prev } : t));
    toast.error(err instanceof Error ? err.message : 'Move failed');
  }
}

async function addTask(status: string): Promise<void> {
  if (!projectId) return;
  const title = prompt('Task title');
  if (!title?.trim()) return;
  try {
    await api.post(`${API}/${projectId}/tasks`, { title: title.trim(), status });
    await loadTasks();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Create failed');
  }
}

function onDragStart(id: string) {
  draggingId = id;
}
function onDrop(status: string) {
  if (draggingId) void moveTask(draggingId, status);
  draggingId = null;
}

$effect(() => {
  void loadProjects();
});
$effect(() => {
  void projectId;
  void loadTasks();
});
</script>

<div class="space-y-3">
  <div class="flex items-center gap-2 flex-wrap">
    <h1 class="font-semibold text-lg flex-1">Kanban</h1>
    {#if loading}
      <span class="loading loading-spinner loading-xs"></span>
    {:else if projects.length === 0}
      <span class="text-sm opacity-50">No projects — create one in Projects first</span>
    {:else}
      <select class="select select-bordered select-sm" bind:value={projectId}>
        {#each projects as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    {/if}
  </div>

  <div class="flex gap-3 overflow-x-auto pb-2 min-h-[24rem]">
    {#each COLUMNS as col (col.id)}
      <div
        class="w-64 shrink-0 flex flex-col rounded-lg border border-base-300 bg-base-200/40"
        ondragover={(e) => e.preventDefault()}
        ondrop={() => onDrop(col.id)}
        role="list"
      >
        <div class="px-3 py-2 border-b border-base-300 flex items-center justify-between">
          <span class="text-sm font-medium">{col.label}</span>
          <span class="badge badge-ghost badge-xs">{byStatus[col.id]?.length ?? 0}</span>
        </div>
        <div class="flex-1 p-2 space-y-2 overflow-y-auto max-h-[70vh]">
          {#each byStatus[col.id] ?? [] as task (task.id)}
            <div
              class="card bg-base-100 shadow-sm cursor-grab active:cursor-grabbing"
              draggable="true"
              ondragstart={() => onDragStart(task.id)}
              role="listitem"
            >
              <div class="card-body p-3 gap-1">
                <div class="text-sm font-medium">{task.title}</div>
                {#if task.priority}
                  <div class="text-xs opacity-50">{task.priority}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
        <button type="button" class="btn btn-ghost btn-xs m-2" onclick={() => void addTask(col.id)}>
          + Add
        </button>
      </div>
    {/each}
  </div>
</div>
