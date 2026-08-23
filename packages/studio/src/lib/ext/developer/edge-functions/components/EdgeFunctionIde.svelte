<script lang="ts">
/**
 * Edge function IDE — list, edit source, save, invoke.
 */
import { Play, Save, Plus } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';

const API = '/ext/developer/edge-functions';

type FnMeta = { id: string; name: string; is_active?: boolean; description?: string | null };
type FnFull = FnMeta & { code?: string | null };

let list = $state<FnMeta[]>([]);
let activeId = $state<string | null>(null);
let code = $state('export default async function handler(ctx) {\n  return { ok: true };\n}\n');
let name = $state('');
let invokeBody = $state('{}');
let invokeOut = $state('');
let loading = $state(true);
let saving = $state(false);
let invoking = $state(false);

async function loadList(): Promise<void> {
  loading = true;
  try {
    const r = await api.get<{ functions?: FnMeta[]; data?: FnMeta[] }>(API);
    list = r.functions ?? r.data ?? (Array.isArray(r) ? (r as FnMeta[]) : []);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to load');
    list = [];
  } finally {
    loading = false;
  }
}

async function openFn(id: string): Promise<void> {
  activeId = id;
  try {
    const r = await api.get<{ function?: FnFull } | FnFull>(`${API}/${id}`);
    const fn = (r as { function?: FnFull }).function ?? (r as FnFull);
    name = fn.name ?? '';
    code = fn.code ?? '';
    invokeOut = '';
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to open');
  }
}

async function createFn(): Promise<void> {
  const n = prompt('Function name (slug)');
  if (!n?.trim()) return;
  try {
    const r = await api.post<{ function?: FnFull }>(API, {
      name: n.trim(),
      code: 'export default async function handler(ctx) {\n  return { ok: true };\n}\n',
    });
    await loadList();
    const id = r.function?.id;
    if (id) await openFn(id);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Create failed');
  }
}

async function save(): Promise<void> {
  if (!activeId || saving) return;
  saving = true;
  try {
    await api.patch(`${API}/${activeId}`, { code, name });
    toast.success('Saved');
    await loadList();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Save failed');
  } finally {
    saving = false;
  }
}

async function invoke(): Promise<void> {
  if (!activeId || invoking) return;
  invoking = true;
  try {
    let body: unknown = {};
    try {
      body = invokeBody.trim() ? JSON.parse(invokeBody) : {};
    } catch {
      toast.error('Invoke body must be JSON');
      return;
    }
    const res = await api.fetch(`${API}/${activeId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    invokeOut = JSON.stringify(json, null, 2);
    if (!res.ok) toast.error(`Invoke ${res.status}`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Invoke failed');
  } finally {
    invoking = false;
  }
}

$effect(() => {
  void loadList();
});
</script>

<div class="flex h-[calc(100vh-8rem)] min-h-[28rem] border border-base-300 rounded-xl overflow-hidden">
  <aside class="w-56 shrink-0 border-r border-base-300 flex flex-col bg-base-200/40">
    <div class="p-2 border-b border-base-300 flex items-center justify-between">
      <span class="text-sm font-semibold">Functions</span>
      <button type="button" class="btn btn-ghost btn-xs" onclick={() => void createFn()} aria-label="New">
        <Plus size={14} />
      </button>
    </div>
    <div class="flex-1 overflow-y-auto">
      {#if loading}
        <div class="p-3 text-xs opacity-50">…</div>
      {:else}
        <ul class="menu menu-sm p-1">
          {#each list as fn (fn.id)}
            <li>
              <button type="button" class={activeId === fn.id ? 'active' : ''} onclick={() => void openFn(fn.id)}>
                <span class="truncate font-mono text-xs">{fn.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>

  <section class="flex-1 flex flex-col min-w-0">
    {#if !activeId}
      <div class="flex-1 flex items-center justify-center text-sm opacity-50">Select or create a function</div>
    {:else}
      <header class="px-3 py-2 border-b border-base-300 flex gap-2 items-center">
        <input class="input input-bordered input-sm font-mono flex-1" bind:value={name} />
        <button type="button" class="btn btn-primary btn-sm gap-1" disabled={saving} onclick={() => void save()}>
          <Save size={14} /> Save
        </button>
        <button type="button" class="btn btn-secondary btn-sm gap-1" disabled={invoking} onclick={() => void invoke()}>
          <Play size={14} /> Invoke
        </button>
      </header>
      <textarea class="textarea rounded-none border-0 border-b border-base-300 font-mono text-xs flex-1 min-h-[12rem]" bind:value={code}></textarea>
      <div class="grid grid-cols-2 gap-0 min-h-[8rem] border-t border-base-300">
        <div class="p-2 border-r border-base-300 flex flex-col">
          <span class="text-xs opacity-50 mb-1">Invoke body (JSON)</span>
          <textarea class="textarea textarea-bordered textarea-xs font-mono flex-1" bind:value={invokeBody}></textarea>
        </div>
        <div class="p-2 flex flex-col">
          <span class="text-xs opacity-50 mb-1">Result</span>
          <pre class="text-xs font-mono flex-1 overflow-auto whitespace-pre-wrap">{invokeOut || '—'}</pre>
        </div>
      </div>
    {/if}
  </section>
</div>
