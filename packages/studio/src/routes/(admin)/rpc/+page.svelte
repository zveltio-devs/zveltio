<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { fmtDate } from '$lib/stores/format.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { Zap, Plus, Trash2, Info, X, Check } from '@lucide/svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

interface RpcFunction {
  id: string;
  function_name: string;
  description: string | null;
  required_role: string;
  is_enabled: boolean;
  created_at: string;
}

const ROLES = ['*', 'god', 'admin', 'member'];

let functions = $state<RpcFunction[]>([]);
let loading = $state(true);
let showForm = $state(false);
let saving = $state(false);

let form = $state({
  function_name: '',
  description: '',
  required_role: 'member',
  is_enabled: true,
});

let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

onMount(loadAll);

async function loadAll() {
  loading = true;
  try {
    const res = await api.get<{ functions: RpcFunction[] }>('/api/rpc/');
    functions = res.functions ?? [];
  } catch {
    toast.error('Failed to load RPC functions');
  } finally {
    loading = false;
  }
}

function openNew() {
  form = { function_name: '', description: '', required_role: 'member', is_enabled: true };
  showForm = true;
}

async function save() {
  if (!form.function_name) return;
  saving = true;
  try {
    await api.post('/api/rpc/', {
      function_name: form.function_name,
      description: form.description || null,
      required_role: form.required_role,
      is_enabled: form.is_enabled,
    });
    toast.success(m['rpc.fnRegistered']());
    showForm = false;
    await loadAll();
  } catch {
    toast.error('Failed to register function');
  } finally {
    saving = false;
  }
}

async function toggleEnabled(fn: RpcFunction) {
  try {
    await api.patch(`/api/rpc/${fn.id}`, { is_enabled: !fn.is_enabled });
    functions = functions.map((f) => (f.id === fn.id ? { ...f, is_enabled: !f.is_enabled } : f));
  } catch {
    toast.error('Failed to update function');
  }
}

function confirmDelete(fn: RpcFunction) {
  confirmState = {
    open: true,
    title: m['rpc.removeTitle'](),
    message: m['rpc.removeMsg']({ name: fn.function_name }),
    onconfirm: async () => {
      try {
        await api.delete(`/api/rpc/${fn.id}`);
        toast.success(m['rpc.fnRemoved']());
        await loadAll();
      } catch {
        toast.error('Failed to remove function');
      }
    },
  };
}
</script>

<PageHeader title={m['rpc.title']()} subtitle={m['rpc.subtitle']()}>
    <button onclick={openNew} class="btn btn-primary btn-sm gap-1">
      <Plus class="h-4 w-4" /> {m['rpc.registerFn']()}
    </button>
</PageHeader>

<!-- Info banner: DaisyUI alert adapts to light/dark themes. -->
<div role="status" class="mx-6 mb-4 alert alert-info alert-soft text-sm">
  <Info class="h-4 w-4 shrink-0" />
  <div>
    {m['rpc.banner1']()}
    <code class="font-mono bg-base-300 px-1 rounded">POST /api/rpc/:function</code>
    {m['rpc.banner2']()}
    <code class="font-mono bg-base-300 px-1 rounded">supabase.rpc()</code>.
  </div>
</div>

{#if loading}
  <div class="px-6"><LoadingSkeleton type="table" /></div>
{:else}
  <div class="px-6 space-y-4">

    <!-- Add form -->
    {#if showForm}
      <div class="rounded-xl border border-base-content/10 bg-base-200 p-5 space-y-4">
        <h3 class="font-semibold">{m['rpc.registerFn']()}</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">

          <div class="form-control">
            <label for="rpc-fn-name" class="label label-text text-xs">{m['rpc.fnName']()}</label>
            <input
              id="rpc-fn-name"
              bind:value={form.function_name}
              type="text"
              placeholder="my_function"
              class="input input-sm input-bordered w-full font-mono"
            />
          </div>

          <div class="form-control">
            <label for="rpc-fn-desc" class="label label-text text-xs">{m['common.col.description']()}</label>
            <input
              id="rpc-fn-desc"
              bind:value={form.description}
              type="text"
              placeholder={m['rpc.optionalDesc']()}
              class="input input-sm input-bordered w-full"
            />
          </div>

          <div class="form-control">
            <label for="rpc-fn-role" class="label label-text text-xs">{m['rpc.requiredRole']()}</label>
            <select id="rpc-fn-role" bind:value={form.required_role} class="select select-sm select-bordered w-full">
              {#each ROLES as r}
                <option value={r}>{r === '*' ? m['rls.allRolesOpt']() : r}</option>
              {/each}
            </select>
          </div>

          <div class="form-control justify-end pb-1">
            <span class="label label-text text-xs">{m['common.col.enabled']()}</span>
            <label class="flex items-center gap-2 cursor-pointer text-sm mt-1">
              <input type="checkbox" bind:checked={form.is_enabled} class="checkbox checkbox-sm checkbox-primary" />
              {m['common.col.active']()}
            </label>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button onclick={() => (showForm = false)} class="btn btn-ghost btn-sm">
            <X class="h-4 w-4" />
          </button>
          <button
            onclick={save}
            disabled={saving || !form.function_name}
            class="btn btn-primary btn-sm gap-1"
          >
            {#if saving}
              <span class="loading loading-spinner loading-xs"></span>
            {:else}
              <Check class="h-4 w-4" />
            {/if}
            {m['rpc.register']()}
          </button>
        </div>
      </div>
    {/if}

    <!-- Empty state -->
    {#if functions.length === 0 && !showForm}
      <div class="flex flex-col items-center justify-center py-24 text-center">
        <div class="mb-4 rounded-full border border-base-content/10 bg-base-200 p-5">
          <Zap class="h-10 w-10 text-base-content/55" />
        </div>
        <h2 class="text-lg font-semibold">{m['rpc.emptyTitle']()}</h2>
        <p class="mt-1 text-sm text-base-content/65">
          {m['rpc.emptyDesc']()}
        </p>
        <button onclick={openNew} class="btn btn-primary btn-sm mt-4 gap-1">
          <Plus class="h-4 w-4" /> {m['rpc.registerFn']()}
        </button>
      </div>

    {:else if functions.length > 0}
      <div class="overflow-x-auto rounded-xl border border-base-content/10">
        <table class="table table-sm w-full">
          <thead>
            <tr class="text-xs text-base-content/65">
              <th>{m['rpc.colFunction']()}</th>
              <th>{m['common.col.description']()}</th>
              <th>{m['rpc.requiredRole']()}</th>
              <th class="text-center">{m['common.col.enabled']()}</th>
              <th>{m['common.col.created']()}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each functions as fn (fn.id)}
              <tr class="hover:bg-base-200/50">
                <td class="font-mono text-xs font-semibold">{fn.function_name}</td>
                <td class="text-xs text-base-content/65 max-w-xs truncate">{fn.description ?? '—'}</td>
                <td>
                  <span class="badge badge-ghost badge-sm">{fn.required_role}</span>
                </td>
                <td class="text-center">
                  <input
                    type="checkbox"
                    checked={fn.is_enabled}
                    onchange={() => toggleEnabled(fn)}
                    class="checkbox checkbox-sm checkbox-primary"
                  />
                </td>
                <td class="text-xs text-base-content/65">
                  {fmtDate(fn.created_at)}
                </td>
                <td class="text-right">
                  <button onclick={() => confirmDelete(fn)} class="btn btn-ghost btn-xs text-error">
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  </div>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
