<script lang="ts">
/**
 * Kanban board over the extension's `tasks` collection, through the data API.
 */
import { api } from '#lib/api.js';
import { m } from '#lib/i18n.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';

const API = '/api/data';
const COLUMNS = [
  { id: 'todo', label: m['projects.management.status.todo'] },
  { id: 'in_progress', label: m['projects.management.status.in_progress'] },
  { id: 'in_review', label: m['projects.management.status.in_review'] },
  { id: 'blocked', label: m['projects.management.status.blocked'] },
  { id: 'done', label: m['projects.management.status.done'] },
] as const;
const PRIORITY: Record<string, () => string> = {
  low: m['projects.management.priority.low'],
  medium: m['projects.management.priority.medium'],
  high: m['projects.management.priority.high'],
  critical: m['projects.management.priority.critical'],
};

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
    const r = await api.get<{ records: Project[] }>(
      `${API}/projects?sort=created_at&order=desc&limit=500`,
    );
    projects = r.records;
    if (!projectId && projects[0]) projectId = projects[0].id;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['projects.management.kanban.loadFailed']());
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
    const r = await api.get<{ records: Task[] }>(
      `${API}/tasks?project_id[eq]=${projectId}&sort=sort_order&order=asc&limit=500`,
    );
    tasks = r.records;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['projects.management.kanban.loadFailed']());
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
    toast.error(err instanceof Error ? err.message : m['projects.management.kanban.saveFailed']());
  }
}

async function addTask(status: string): Promise<void> {
  if (!projectId) return;
  const title = prompt(m['projects.management.kanban.taskTitle']());
  if (!title?.trim()) return;
  try {
    await api.post(`${API}/tasks`, {
      project_id: projectId,
      title: title.trim(),
      status,
      priority: 'medium',
    });
    await loadTasks();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['projects.management.kanban.saveFailed']());
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
    <h1 class="font-semibold text-lg flex-1">{m['projects.management.kanban.title']()}</h1>
    {#if loading}
      <span class="loading loading-spinner loading-xs"></span>
    {:else if projects.length === 0}
      <span class="text-sm opacity-50">{m['projects.management.kanban.noProjects']()}</span>
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
          <span class="text-sm font-medium">{col.label()}</span>
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
                  <div class="text-xs opacity-50">{PRIORITY[task.priority]?.() ?? task.priority}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
        <button type="button" class="btn btn-ghost btn-xs m-2" onclick={() => void addTask(col.id)}>
          + {m['common.add']()}
        </button>
      </div>
    {/each}
  </div>
</div>
