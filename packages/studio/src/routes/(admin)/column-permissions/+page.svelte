<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { TableProperties, Plus, Trash2, Info, X, Check } from '@lucide/svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  interface ColumnPermission {
    id: string;
    collection_name: string;
    column_name: string;
    role: string;
    can_read: boolean;
    can_write: boolean;
  }

  let permissions = $state<ColumnPermission[]>([]);
  let collections = $state<string[]>([]);
  let collectionFields = $state<Record<string, string[]>>({});
  let roles = $state<string[]>(['*', 'god', 'admin', 'member']);
  let loading = $state(true);

  let filterCollection = $state('');
  let showForm = $state(false);
  let editingId = $state<string | null>(null);
  let saving = $state(false);

  let form = $state({
    collection_name: '',
    column_name: '',
    role: 'member',
    can_read: true,
    can_write: false,
  });

  let confirmState = $state<{
    open: boolean; title: string; message: string; onconfirm: () => void;
  }>({ open: false, title: '', message: '', onconfirm: () => {} });

  const filtered = $derived(
    filterCollection
      ? permissions.filter(p => p.collection_name === filterCollection)
      : permissions,
  );

  const formFields = $derived(collectionFields[form.collection_name] ?? []);

  onMount(loadAll);

  async function loadAll() {
    loading = true;
    try {
      const [permRes, colRes, roleRes] = await Promise.all([
        api.get<{ column_permissions: ColumnPermission[] }>('/api/admin/column-permissions'),
        api.get<{ collections: any[] }>('/api/collections'),
        api.get<{ roles: any[] }>('/api/admin/roles'),
      ]);
      permissions = permRes.column_permissions ?? [];
      collections = (colRes.collections ?? []).map((c: any) => c.slug ?? c.name);
      const customRoles = (roleRes.roles ?? []).map((r: any) => r.name);
      roles = ['*', 'god', 'admin', 'member', ...customRoles];
    } catch {
      toast.error('Failed to load column permissions');
    } finally {
      loading = false;
    }
  }

  async function loadFields(collectionName: string) {
    if (!collectionName || collectionFields[collectionName]) return;
    try {
      const res = await api.get<{ collection: any }>(`/api/collections/${collectionName}`);
      const fields = res.collection?.fields ?? [];
      const names: string[] = (typeof fields === 'string' ? JSON.parse(fields) : fields)
        .map((f: any) => f.name);
      collectionFields = { ...collectionFields, [collectionName]: names };
    } catch {
      collectionFields = { ...collectionFields, [collectionName]: [] };
    }
  }

  function openNew() {
    editingId = null;
    form = {
      collection_name: filterCollection || (collections[0] ?? ''),
      column_name: '',
      role: 'member',
      can_read: true,
      can_write: false,
    };
    if (form.collection_name) loadFields(form.collection_name);
    showForm = true;
  }

  function openEdit(p: ColumnPermission) {
    editingId = p.id;
    form = {
      collection_name: p.collection_name,
      column_name: p.column_name,
      role: p.role,
      can_read: p.can_read,
      can_write: p.can_write,
    };
    loadFields(p.collection_name);
    showForm = true;
  }

  async function save() {
    if (!form.collection_name || !form.column_name || !form.role) return;
    saving = true;
    try {
      if (editingId) {
        await api.put(`/api/admin/column-permissions/${editingId}`, form);
        toast.success('Permission updated');
      } else {
        await api.post('/api/admin/column-permissions', form);
        toast.success('Permission created');
      }
      showForm = false;
      await loadAll();
    } catch {
      toast.error('Failed to save permission');
    } finally {
      saving = false;
    }
  }

  async function toggleField(p: ColumnPermission, field: 'can_read' | 'can_write') {
    const updated = { ...p, [field]: !p[field] };
    try {
      await api.put(`/api/admin/column-permissions/${p.id}`, {
        can_read: updated.can_read,
        can_write: updated.can_write,
      });
      permissions = permissions.map(x => x.id === p.id ? { ...x, [field]: !x[field] } : x);
    } catch {
      toast.error('Failed to update permission');
    }
  }

  function confirmDelete(p: ColumnPermission) {
    confirmState = {
      open: true,
      title: 'Delete Column Permission',
      message: `Remove the rule for "${p.collection_name}.${p.column_name}" / "${p.role}"?`,
      onconfirm: async () => {
        try {
          await api.delete(`/api/admin/column-permissions/${p.id}`);
          toast.success('Permission deleted');
          await loadAll();
        } catch {
          toast.error('Failed to delete permission');
        }
      },
    };
  }
</script>

<PageHeader title="Column Permissions" subtitle="Control which columns each role can read or write per collection.">
  {#snippet children()}
    <button onclick={openNew} class="btn btn-primary btn-sm gap-1">
      <Plus class="h-4 w-4" /> New Rule
    </button>
  {/snippet}
</PageHeader>

<!-- Info banner -->
<div class="mx-6 mb-4 flex items-start gap-3 rounded-lg border border-blue-800/40 bg-blue-950/30 p-3 text-sm text-blue-300">
  <Info class="mt-0.5 h-4 w-4 shrink-0" />
  <div>
    Rules are enforced <strong>after</strong> Casbin and RLS.
    <strong>can_read = off</strong> hides the column from GET responses.
    <strong>can_write = off</strong> blocks mutations on that column (the value is silently ignored).
    God users and API keys bypass column permissions.
  </div>
</div>

{#if loading}
  <div class="px-6"><LoadingSkeleton type="table" /></div>
{:else}
  <div class="px-6 space-y-4">

    <!-- Filter + form -->
    <div class="flex flex-wrap items-center gap-3">
      <select
        bind:value={filterCollection}
        class="select select-sm select-bordered"
      >
        <option value="">All collections</option>
        {#each collections as col}
          <option value={col}>{col}</option>
        {/each}
      </select>
      <span class="text-xs text-base-content/40">{filtered.length} rule{filtered.length !== 1 ? 's' : ''}</span>
    </div>

    <!-- Add/Edit form -->
    {#if showForm}
      <div class="rounded-xl border border-base-content/10 bg-base-200 p-5 space-y-4">
        <h3 class="font-semibold">{editingId ? 'Edit Rule' : 'New Rule'}</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">

          <div class="form-control">
            <label for="form-collection" class="label label-text text-xs">Collection</label>
            <select
              id="form-collection"
              bind:value={form.collection_name}
              onchange={() => { form.column_name = ''; loadFields(form.collection_name); }}
              class="select select-sm select-bordered w-full"
            >
              <option value="">Select…</option>
              {#each collections as col}
                <option value={col}>{col}</option>
              {/each}
            </select>
          </div>

          <div class="form-control">
            <label for="form-column" class="label label-text text-xs">Column</label>
            {#if formFields.length > 0}
              <select id="form-column" bind:value={form.column_name} class="select select-sm select-bordered w-full">
                <option value="">Select…</option>
                {#each formFields as f}
                  <option value={f}>{f}</option>
                {/each}
              </select>
            {:else}
              <input
                id="form-column"
                bind:value={form.column_name}
                type="text"
                placeholder="column_name"
                class="input input-sm input-bordered w-full"
              />
            {/if}
          </div>

          <div class="form-control">
            <label for="form-role" class="label label-text text-xs">Role</label>
            <select id="form-role" bind:value={form.role} class="select select-sm select-bordered w-full">
              {#each roles as r}
                <option value={r}>{r === '*' ? '* (all roles)' : r}</option>
              {/each}
            </select>
          </div>

          <div class="form-control justify-end pb-1">
            <span class="label label-text text-xs">Access</span>
            <div class="flex gap-4">
              <label class="flex items-center gap-1.5 cursor-pointer text-sm">
                <input type="checkbox" bind:checked={form.can_read} class="checkbox checkbox-sm checkbox-primary" />
                Read
              </label>
              <label class="flex items-center gap-1.5 cursor-pointer text-sm">
                <input type="checkbox" bind:checked={form.can_write} class="checkbox checkbox-sm checkbox-primary" />
                Write
              </label>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button onclick={() => (showForm = false)} class="btn btn-ghost btn-sm">
            <X class="h-4 w-4" />
          </button>
          <button
            onclick={save}
            disabled={saving || !form.collection_name || !form.column_name}
            class="btn btn-primary btn-sm gap-1"
          >
            {#if saving}
              <span class="loading loading-spinner loading-xs"></span>
            {:else}
              <Check class="h-4 w-4" />
            {/if}
            {editingId ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    {/if}

    <!-- Empty state -->
    {#if filtered.length === 0 && !showForm}
      <div class="flex flex-col items-center justify-center py-24 text-center">
        <div class="mb-4 rounded-full border border-base-content/10 bg-base-200 p-5">
          <TableProperties class="h-10 w-10 text-base-content/30" />
        </div>
        <h2 class="text-lg font-semibold">No column rules yet</h2>
        <p class="mt-1 text-sm text-base-content/50">
          By default all roles can read and write all columns.<br/>
          Add a rule to restrict access to a specific column.
        </p>
        <button onclick={openNew} class="btn btn-primary btn-sm mt-4 gap-1">
          <Plus class="h-4 w-4" /> New Rule
        </button>
      </div>

    {:else if filtered.length > 0}
      <div class="overflow-x-auto rounded-xl border border-base-content/10">
        <table class="table table-sm w-full">
          <thead>
            <tr class="text-xs text-base-content/50">
              <th>Collection</th>
              <th>Column</th>
              <th>Role</th>
              <th class="text-center">Can Read</th>
              <th class="text-center">Can Write</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as perm (perm.id)}
              <tr class="hover:bg-base-200/50">
                <td class="font-mono text-xs font-semibold">{perm.collection_name}</td>
                <td class="font-mono text-xs text-primary">{perm.column_name}</td>
                <td>
                  <span class="badge badge-ghost badge-sm">{perm.role}</span>
                </td>
                <td class="text-center">
                  <input
                    type="checkbox"
                    checked={perm.can_read}
                    onchange={() => toggleField(perm, 'can_read')}
                    class="checkbox checkbox-sm checkbox-primary"
                  />
                </td>
                <td class="text-center">
                  <input
                    type="checkbox"
                    checked={perm.can_write}
                    onchange={() => toggleField(perm, 'can_write')}
                    class="checkbox checkbox-sm checkbox-success"
                  />
                </td>
                <td class="text-right">
                  <div class="flex justify-end gap-1">
                    <button onclick={() => openEdit(perm)} class="btn btn-ghost btn-xs">
                      Edit
                    </button>
                    <button onclick={() => confirmDelete(perm)} class="btn btn-ghost btn-xs text-error">
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
