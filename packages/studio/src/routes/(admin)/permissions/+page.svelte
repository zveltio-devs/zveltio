<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Shield, Save, Plus, Trash2, LoaderCircle, GitBranch, ChevronRight, ArrowRight, Database, Globe } from '@lucide/svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  type Resource = { name: string; display_name: string; type: 'collection' | 'zone'; actions: string[] };

  let resources  = $state<Resource[]>([]);
  let roles      = $state<any[]>([]);
  let permissions = $state(new Map<string, Set<string>>());
  let loading    = $state(true);
  let saving     = $state(false);
  let saved      = $state(false);
  let tab        = $state<'matrix' | 'roles' | 'hierarchy'>('matrix');
  let selectedRoleId = $state<string>('');

  let newRoleName = $state('');
  let newRoleDesc = $state('');
  let creatingRole = $state(false);

  let hierarchy  = $state<Array<{ child: string; parent: string }>>([]);
  let hierChild  = $state('');
  let hierParent = $state('');
  let hierSaving = $state(false);
  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  const roleNames = $derived(['god', 'admin', 'member', ...roles.map((r) => r.name)]);

  const collections = $derived(resources.filter((r) => r.type === 'collection'));
  const zones       = $derived(resources.filter((r) => r.type === 'zone'));

  const ACTION_COLORS: Record<string, string> = {
    view:   'checkbox-info',
    create: 'checkbox-success',
    update: 'checkbox-warning',
    delete: 'checkbox-error',
    read:   'checkbox-info',
    write:  'checkbox-warning',
  };

  onMount(async () => { await loadAll(); await loadHierarchy(); });

  async function loadAll() {
    loading = true;
    try {
      const [resRes, rolRes, permRes] = await Promise.all([
        api.get<{ resources: Resource[] }>('/api/admin/resources'),
        api.get<{ roles: any[] }>('/api/admin/roles'),
        api.get<{ permissions: any[] }>('/api/admin/permissions'),
      ]);
      resources = resRes.resources || [];
      roles = rolRes.roles || [];
      if (!selectedRoleId && roles.length > 0) selectedRoleId = roles[0].id;

      const map = new Map<string, Set<string>>();
      for (const p of permRes.permissions || []) {
        const key = `${p.role_id}:${p.resource}`;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(p.action);
      }
      permissions = map;
    } finally { loading = false; }
  }

  async function loadHierarchy() {
    const res = await api.get<{ hierarchy: Array<{ child: string; parent: string }> }>('/api/admin/roles/hierarchy');
    hierarchy = res.hierarchy ?? [];
  }

  function has(roleId: string, resource: string, action: string) {
    return permissions.get(`${roleId}:${resource}`)?.has(action) ?? false;
  }

  function toggle(roleId: string, resource: string, action: string) {
    const key = `${roleId}:${resource}`;
    if (!permissions.has(key)) permissions.set(key, new Set());
    const s = permissions.get(key)!;
    s.has(action) ? s.delete(action) : s.add(action);
    permissions = new Map(permissions);
  }

  async function saveMatrix() {
    saving = true; saved = false;
    try {
      const list: any[] = [];
      for (const [key, acts] of permissions) {
        const [role_id, resource] = key.split(':');
        for (const action of acts) list.push({ role_id, resource, action, conditions: {} });
      }
      await api.post('/api/admin/permissions/bulk', { permissions: list });
      saved = true;
      toast.success('Permissions saved');
      setTimeout(() => (saved = false), 3000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally { saving = false; }
  }

  async function createRole() {
    if (!newRoleName.trim()) return;
    creatingRole = true;
    try {
      await api.post('/api/admin/roles', { name: newRoleName.trim(), description: newRoleDesc.trim() });
      newRoleName = ''; newRoleDesc = '';
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create role');
    } finally { creatingRole = false; }
  }

  async function deleteRole(id: string, name: string) {
    confirmState = {
      open: true,
      title: 'Delete Role',
      message: `Delete role "${name}"? All permissions for this role will be removed.`,
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await api.delete(`/api/admin/roles/${id}`);
          if (selectedRoleId === id) selectedRoleId = roles.find((r) => r.id !== id)?.id ?? '';
          await loadAll();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Failed to delete role');
        }
      },
    };
  }

  async function addInheritance() {
    if (!hierChild || !hierParent) return;
    hierSaving = true;
    try {
      await api.post('/api/admin/roles/hierarchy', { child: hierChild, parent: hierParent });
      hierChild = ''; hierParent = '';
      await loadHierarchy();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to add inheritance');
    } finally { hierSaving = false; }
  }

  async function removeInheritance(child: string, parent: string) {
    await api.delete('/api/admin/roles/hierarchy', { child, parent });
    await loadHierarchy();
  }

  const selectedRole = $derived(roles.find((r) => r.id === selectedRoleId));
</script>

<div class="space-y-6">
  <PageHeader title="Permissions" subtitle="Role-based access control">
    {#if tab === 'matrix'}
    <button class="btn {saved ? 'btn-success' : 'btn-primary'} btn-sm" onclick={saveMatrix} disabled={saving}>
      {#if saving}<LoaderCircle size={16} class="animate-spin" />{:else}<Save size={16} />{/if}
      {saved ? '✓ Saved' : 'Save'}
    </button>
    {/if}
  </PageHeader>

  <div class="tabs tabs-bordered">
    <button class="tab {tab === 'matrix' ? 'tab-active' : ''}" onclick={() => (tab = 'matrix')}>Permission Matrix</button>
    <button class="tab {tab === 'roles' ? 'tab-active' : ''}" onclick={() => (tab = 'roles')}>Roles ({roles.length})</button>
    <button class="tab {tab === 'hierarchy' ? 'tab-active' : ''}" onclick={() => (tab = 'hierarchy')}>Role Hierarchy</button>
  </div>

  {#if loading}
    <LoadingSkeleton type="table" rows={5} />
  {:else if tab === 'matrix'}

    {#if roles.length === 0}
      <div class="alert alert-info">
        <Shield size={20} />
        <span>Create at least one role to configure permissions.</span>
      </div>
    {:else}

      <!-- Role selector tabs -->
      <div class="flex gap-1 flex-wrap border-b border-base-300 pb-3">
        {#each roles as role}
        <button
          class="btn btn-sm {selectedRoleId === role.id ? 'btn-primary' : 'btn-ghost'}"
          onclick={() => (selectedRoleId = role.id)}
        >
          <Shield size={13} />
          {role.name}
        </button>
        {/each}
      </div>

      {#if selectedRole}
      <div class="space-y-6">

        <!-- Collections section -->
        {#if collections.length > 0}
        <div>
          <div class="flex items-center gap-2 mb-3">
            <Database size={15} class="text-base-content/50" />
            <span class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">
              Collections ({collections.length})
            </span>
          </div>

          <div class="border border-base-300 rounded-xl overflow-hidden">
            <table class="table table-sm w-full">
              <thead class="bg-base-200">
                <tr>
                  <th class="w-1/3">Collection</th>
                  <th class="text-center text-info">View</th>
                  <th class="text-center text-success">Create</th>
                  <th class="text-center text-warning">Update</th>
                  <th class="text-center text-error">Delete</th>
                </tr>
              </thead>
              <tbody>
                {#each collections as res}
                <tr class="hover">
                  <td class="font-medium">{res.display_name}</td>
                  {#each res.actions as action}
                  <td class="text-center">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm {ACTION_COLORS[action] ?? 'checkbox-primary'}"
                      checked={has(selectedRole.id, res.name, action)}
                      onchange={() => toggle(selectedRole.id, res.name, action)}
                    />
                  </td>
                  {/each}
                </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
        {/if}

        <!-- Zones section -->
        {#if zones.length > 0}
        <div>
          <div class="flex items-center gap-2 mb-3">
            <Globe size={15} class="text-base-content/50" />
            <span class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">
              Zones ({zones.length})
            </span>
          </div>

          <div class="border border-base-300 rounded-xl overflow-hidden">
            <table class="table table-sm w-full">
              <thead class="bg-base-200">
                <tr>
                  <th class="w-1/3">Zone</th>
                  <th class="text-center text-info">Read</th>
                  <th class="text-center text-warning">Write</th>
                </tr>
              </thead>
              <tbody>
                {#each zones as res}
                <tr class="hover">
                  <td class="font-medium">{res.display_name}</td>
                  {#each res.actions as action}
                  <td class="text-center">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm {ACTION_COLORS[action] ?? 'checkbox-primary'}"
                      checked={has(selectedRole.id, res.name, action)}
                      onchange={() => toggle(selectedRole.id, res.name, action)}
                    />
                  </td>
                  {/each}
                </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
        {/if}

        {#if resources.length === 0}
        <div class="text-center text-base-content/40 py-8 text-sm">
          No collections or zones yet. Create some to configure permissions.
        </div>
        {/if}

      </div>
      {/if}

    {/if}

  {:else if tab === 'roles'}
    <div class="space-y-4">
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h3 class="font-semibold mb-3">Create Role</h3>
          <div class="flex gap-2">
            <input class="input input-sm flex-1" bind:value={newRoleName} placeholder="Role name (e.g. editor)" />
            <input class="input input-sm flex-1" bind:value={newRoleDesc} placeholder="Description (optional)" />
            <button class="btn btn-primary btn-sm" onclick={createRole} disabled={!newRoleName.trim() || creatingRole}>
              {#if creatingRole}<LoaderCircle size={14} class="animate-spin" />{:else}<Plus size={14} />{/if}
              Create
            </button>
          </div>
        </div>
      </div>

      {#if roles.length === 0}
        <p class="text-center text-base-content/40 py-8 text-sm">No custom roles yet.</p>
      {:else}
        <div class="space-y-2">
          {#each roles as role}
          <div class="card bg-base-200">
            <div class="card-body p-3 flex-row items-center justify-between">
              <div class="flex items-center gap-2">
                <Shield size={16} class="opacity-40" />
                <span class="font-medium">{role.name}</span>
                {#if role.description}<span class="text-sm text-base-content/50">{role.description}</span>{/if}
              </div>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteRole(role.id, role.name)}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {/each}
        </div>
      {/if}
    </div>

  {:else}
    <!-- Role Hierarchy tab -->
    <div class="space-y-6">

      <div class="alert alert-info text-sm">
        <GitBranch size={16} class="shrink-0" />
        <div>
          <p class="font-semibold">Casbin Role Inheritance</p>
          <p class="text-xs mt-0.5 opacity-80">
            When role A inherits role B, every permission granted to B is automatically available to A.
            Example: <code class="bg-base-100/50 px-1 rounded">manager → employee</code> means managers get all employee permissions plus their own.
          </p>
        </div>
      </div>

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h3 class="font-semibold mb-3">Add Inheritance Rule</h3>
          <div class="flex items-center gap-3 flex-wrap">
            <select class="select select-sm flex-1 min-w-32" bind:value={hierChild}>
              <option value="">Child role (inheritor)</option>
              {#each roleNames as r}<option value={r}>{r}</option>{/each}
            </select>
            <ArrowRight size={16} class="text-base-content/40 shrink-0" />
            <select class="select select-sm flex-1 min-w-32" bind:value={hierParent}>
              <option value="">Parent role (inherited)</option>
              {#each roleNames as r}<option value={r}>{r}</option>{/each}
            </select>
            <button
              class="btn btn-primary btn-sm"
              onclick={addInheritance}
              disabled={!hierChild || !hierParent || hierChild === hierParent || hierSaving}
            >
              {#if hierSaving}<LoaderCircle size={14} class="animate-spin" />{:else}<Plus size={14} />{/if}
              Add
            </button>
          </div>
          <p class="text-xs text-base-content/40 mt-2">Reads as: <em>"[Child] inherits all permissions from [Parent]"</em></p>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-semibold text-base-content/60 uppercase tracking-wider mb-3">
          Active Inheritance Rules ({hierarchy.length})
        </h3>
        {#if hierarchy.length === 0}
          <div class="text-center py-10 text-base-content/35">
            <GitBranch size={32} class="mx-auto mb-2 opacity-40" />
            <p class="text-sm">No inheritance rules defined yet.</p>
            <p class="text-xs mt-1">Built-in: <code>admin → *</code>, <code>god → admin</code></p>
          </div>
        {:else}
          <div class="space-y-2">
            {#each hierarchy as edge}
            <div class="card bg-base-200 hover:bg-base-300 transition-colors">
              <div class="card-body p-3 flex-row items-center gap-3">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <span class="badge badge-outline badge-sm font-mono">{edge.child}</span>
                  <ChevronRight size={14} class="text-base-content/30 shrink-0" />
                  <span class="badge badge-primary badge-sm font-mono">{edge.parent}</span>
                  <span class="text-xs text-base-content/40 ml-1">inherits</span>
                </div>
                <button
                  class="btn btn-ghost btn-xs text-error shrink-0"
                  onclick={() => removeInheritance(edge.child, edge.parent)}
                  title="Remove inheritance"
                ><Trash2 size={13} /></button>
              </div>
            </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="text-xs text-base-content/40 border border-base-300 rounded-lg p-3">
        <p class="font-semibold mb-1">Built-in roles (always active, not editable here):</p>
        <ul class="space-y-0.5 ml-2">
          <li>• <code>god</code> — superadmin, bypasses all permission checks</li>
          <li>• <code>admin</code> — full access to everything</li>
          <li>• <code>member</code> — read access to all collections</li>
          <li>• <code>employee</code> — read/write on intranet zone</li>
          <li>• <code>manager</code> — inherits from employee</li>
          <li>• <code>client</code> — read/write on portal zone</li>
        </ul>
      </div>

    </div>
  {/if}
</div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
