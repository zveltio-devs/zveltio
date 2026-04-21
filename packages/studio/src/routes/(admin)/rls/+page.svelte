<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Shield, Plus, Trash2, Pencil, Check, X, Info } from '@lucide/svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  interface RlsPolicy {
    id: string;
    collection: string;
    role: string;
    filter_field: string;
    filter_op: string;
    filter_value_source: string;
    is_enabled: boolean;
    description?: string | null;
  }

  const FILTER_OPS = ['eq', 'neq', 'in', 'not_in'];
  const VALUE_SOURCES = [
    { value: 'user_id',    label: 'Current user ID' },
    { value: 'user_email', label: 'Current user email' },
    { value: 'user_role',  label: 'Current user role' },
  ];

  let policies = $state<RlsPolicy[]>([]);
  let collections = $state<string[]>([]);
  let roles = $state<string[]>([]);
  let loading = $state(true);

  let showForm = $state(false);
  let editingId = $state<string | null>(null);

  let form = $state({
    collection: '',
    role: '*',
    filter_field: 'created_by',
    filter_op: 'eq',
    filter_value_source: 'user_id',
    is_enabled: true,
    description: '',
  });

  let saving = $state(false);

  let confirmState = $state<{
    open: boolean; title: string; message: string; onconfirm: () => void;
  }>({ open: false, title: '', message: '', onconfirm: () => {} });

  onMount(loadAll);

  async function loadAll() {
    loading = true;
    try {
      const [rlsRes, colRes, roleRes] = await Promise.all([
        api.get<{ policies: RlsPolicy[] }>('/api/admin/rls'),
        api.get<{ collections: any[] }>('/api/collections'),
        api.get<{ roles: any[] }>('/api/admin/roles'),
      ]);
      policies = rlsRes.policies ?? [];
      collections = (colRes.collections ?? []).map((c: any) => c.slug ?? c.name);
      const customRoles = (roleRes.roles ?? []).map((r: any) => r.name);
      roles = ['*', 'god', 'admin', 'member', ...customRoles];
    } catch (err) {
      toast.error('Failed to load RLS policies');
    } finally {
      loading = false;
    }
  }

  function openNew() {
    editingId = null;
    form = { collection: collections[0] ?? '', role: '*', filter_field: 'created_by', filter_op: 'eq', filter_value_source: 'user_id', is_enabled: true, description: '' };
    showForm = true;
  }

  function openEdit(p: RlsPolicy) {
    editingId = p.id;
    form = {
      collection: p.collection,
      role: p.role,
      filter_field: p.filter_field,
      filter_op: p.filter_op,
      filter_value_source: p.filter_value_source,
      is_enabled: p.is_enabled,
      description: p.description ?? '',
    };
    showForm = true;
  }

  async function save() {
    if (!form.collection || !form.filter_field) return;
    saving = true;
    try {
      const body = { ...form, description: form.description || undefined };
      if (editingId) {
        await api.patch(`/api/admin/rls/${editingId}`, body);
        toast.success('Policy updated');
      } else {
        await api.post('/api/admin/rls', body);
        toast.success('Policy created');
      }
      showForm = false;
      await loadAll();
    } catch (err) {
      toast.error('Failed to save policy');
    } finally {
      saving = false;
    }
  }

  function confirmDelete(p: RlsPolicy) {
    confirmState = {
      open: true,
      title: 'Delete RLS Policy',
      message: `Remove the policy for "${p.collection}" / "${p.role}"? Records will no longer be filtered by this rule.`,
      onconfirm: async () => {
        try {
          await api.delete(`/api/admin/rls/${p.id}`);
          toast.success('Policy deleted');
          await loadAll();
        } catch {
          toast.error('Failed to delete policy');
        }
      },
    };
  }

  async function toggleEnabled(p: RlsPolicy) {
    try {
      await api.patch(`/api/admin/rls/${p.id}`, { is_enabled: !p.is_enabled });
      p.is_enabled = !p.is_enabled;
    } catch {
      toast.error('Failed to update policy');
    }
  }

  function sourceLabel(src: string): string {
    const known = VALUE_SOURCES.find(v => v.value === src);
    if (known) return known.label;
    if (src.startsWith('static:')) return `"${src.slice(7)}"`;
    return src;
  }
</script>

<PageHeader title="Row-Level Security" subtitle="Control which records each role can see per collection.">
  {#snippet actions()}
    <button onclick={openNew} class="btn btn-primary btn-sm gap-1">
      <Plus class="h-4 w-4" /> New Policy
    </button>
  {/snippet}
</PageHeader>

<!-- Info banner -->
<div class="mx-6 mb-4 flex items-start gap-3 rounded-lg border border-blue-800/40 bg-blue-950/30 p-3 text-sm text-blue-300">
  <Info class="mt-0.5 h-4 w-4 shrink-0" />
  <div>
    Policies are evaluated <strong>after</strong> Casbin (collection access check).
    Each matching policy injects a <code class="rounded bg-blue-900/40 px-1">WHERE</code> clause into queries for that role.
    God users and API keys bypass RLS.
  </div>
</div>

{#if loading}
  <div class="px-6"><LoadingSkeleton type="table" /></div>
{:else if policies.length === 0 && !showForm}
  <!-- Empty state -->
  <div class="flex flex-col items-center justify-center py-24 text-center">
    <div class="mb-4 rounded-full border border-base-content/10 bg-base-200 p-5">
      <Shield class="h-10 w-10 text-base-content/30" />
    </div>
    <h2 class="text-lg font-semibold">No RLS policies yet</h2>
    <p class="mt-1 text-sm text-base-content/50">Add a policy to restrict which records each role can see.</p>
    <button onclick={openNew} class="btn btn-primary btn-sm mt-4 gap-1">
      <Plus class="h-4 w-4" /> New Policy
    </button>
  </div>
{:else}
  <div class="px-6 space-y-4">

    <!-- Policy form -->
    {#if showForm}
      <div class="rounded-xl border border-base-content/10 bg-base-200 p-5 space-y-4">
        <h3 class="font-semibold">{editingId ? 'Edit Policy' : 'New Policy'}</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div class="form-control">
            <label class="label label-text text-xs">Collection</label>
            <select bind:value={form.collection} class="select select-sm select-bordered w-full">
              <option value="*">* (all collections)</option>
              {#each collections as col}
                <option value={col}>{col}</option>
              {/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label label-text text-xs">Role</label>
            <select bind:value={form.role} class="select select-sm select-bordered w-full">
              {#each roles as r}
                <option value={r}>{r === '*' ? '* (all roles)' : r}</option>
              {/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label label-text text-xs">Filter field</label>
            <input bind:value={form.filter_field} type="text" placeholder="e.g. created_by" class="input input-sm input-bordered w-full" />
          </div>
          <div class="form-control">
            <label class="label label-text text-xs">Operator</label>
            <select bind:value={form.filter_op} class="select select-sm select-bordered w-full">
              {#each FILTER_OPS as op}
                <option value={op}>{op}</option>
              {/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label label-text text-xs">Value source</label>
            <select bind:value={form.filter_value_source} class="select select-sm select-bordered w-full">
              {#each VALUE_SOURCES as vs}
                <option value={vs.value}>{vs.label}</option>
              {/each}
              <option value="static:">Static value…</option>
            </select>
            {#if form.filter_value_source === 'static:' || form.filter_value_source.startsWith('static:')}
              <input
                value={form.filter_value_source.startsWith('static:') ? form.filter_value_source.slice(7) : ''}
                oninput={(e) => { form.filter_value_source = `static:${(e.target as HTMLInputElement).value}`; }}
                type="text" placeholder="literal value" class="input input-sm input-bordered w-full mt-1"
              />
            {/if}
          </div>
          <div class="form-control sm:col-span-2 lg:col-span-1">
            <label class="label label-text text-xs">Description (optional)</label>
            <input bind:value={form.description} type="text" placeholder="e.g. Users see only their records" class="input input-sm input-bordered w-full" />
          </div>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 cursor-pointer text-sm">
            <input type="checkbox" bind:checked={form.is_enabled} class="checkbox checkbox-sm" />
            Enabled
          </label>
          <div class="ml-auto flex gap-2">
            <button onclick={() => (showForm = false)} class="btn btn-ghost btn-sm"><X class="h-4 w-4" /></button>
            <button onclick={save} disabled={saving} class="btn btn-primary btn-sm gap-1">
              {#if saving}
                <span class="loading loading-spinner loading-xs"></span>
              {:else}
                <Check class="h-4 w-4" />
              {/if}
              {editingId ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Policies table -->
    {#if policies.length > 0}
      <div class="overflow-x-auto rounded-xl border border-base-content/10">
        <table class="table table-sm w-full">
          <thead>
            <tr class="text-xs text-base-content/50">
              <th>Collection</th>
              <th>Role</th>
              <th>Rule</th>
              <th>Description</th>
              <th class="text-center">Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each policies as policy (policy.id)}
              <tr class="hover:bg-base-200/50">
                <td class="font-mono text-xs font-semibold">{policy.collection}</td>
                <td>
                  <span class="badge badge-ghost badge-sm">{policy.role}</span>
                </td>
                <td class="font-mono text-xs text-base-content/70">
                  {policy.filter_field} {policy.filter_op} <span class="text-primary">{sourceLabel(policy.filter_value_source)}</span>
                </td>
                <td class="text-sm text-base-content/50">{policy.description ?? '—'}</td>
                <td class="text-center">
                  <input
                    type="checkbox"
                    checked={policy.is_enabled}
                    onchange={() => toggleEnabled(policy)}
                    class="checkbox checkbox-sm checkbox-primary"
                  />
                </td>
                <td class="text-right">
                  <div class="flex justify-end gap-1">
                    <button onclick={() => openEdit(policy)} class="btn btn-ghost btn-xs">
                      <Pencil class="h-3.5 w-3.5" />
                    </button>
                    <button onclick={() => confirmDelete(policy)} class="btn btn-ghost btn-xs text-error">
                      <Trash2 class="h-3.5 w-3.5" />
                    </button>
                  </div>
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
