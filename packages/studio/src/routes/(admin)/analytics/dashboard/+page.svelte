<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Save, Eye, LoaderCircle } from '@lucide/svelte';

  // IT composes the default dashboard each role inherits. Users personalize on
  // top of it in the client app; a user never sees a widget their role's
  // permissions disallow, whatever is set here.

  type WidgetMeta = { id: string; removable: boolean; permission: { resource: string; action: string } | null };
  type Catalog = { catalog: WidgetMeta[]; roles: string[]; default: string[] };
  type RoleLayout = { role: string; widgets: string[]; configured: boolean };

  const LABELS: Record<string, string> = {
    welcome: 'Welcome', health: 'System health', people: 'People',
    data: 'Data & records', activity: 'Recent activity', trust: 'Data protection',
  };

  let cat = $state<Catalog | null>(null);
  let roles = $state<string[]>([]);
  let selectedRole = $state('');
  let draft = $state<Record<string, boolean>>({});
  let configured = $state(false);
  let loading = $state(true);
  let saving = $state(false);

  onMount(async () => {
    try {
      const c = await api.get<Catalog>('/ext/analytics/dashboard/admin/catalog');
      cat = c;
      roles = Array.from(new Set([...c.roles, 'god', 'admin', 'editor', 'viewer'])).sort();
      if (roles.length) await selectRole(roles.includes('editor') ? 'editor' : roles[0]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      loading = false;
    }
  });

  async function selectRole(role: string) {
    selectedRole = role;
    const layout = await api.get<RoleLayout>(`/ext/analytics/dashboard/admin/role/${encodeURIComponent(role)}`);
    configured = layout.configured;
    const shown = new Set(layout.widgets);
    draft = Object.fromEntries((cat?.catalog ?? []).map((w) => [w.id, shown.has(w.id)]));
  }

  async function save() {
    if (!cat) return;
    saving = true;
    try {
      const widgets = cat.catalog.filter((w) => draft[w.id]).map((w) => w.id);
      const res = await api.put<RoleLayout>(
        `/ext/analytics/dashboard/admin/role/${encodeURIComponent(selectedRole)}`,
        { widgets },
      );
      configured = res.configured;
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      saving = false;
    }
  }

  const selectedWidgets = $derived(cat ? cat.catalog.filter((w) => draft[w.id]).map((w) => w.id) : []);
</script>

<ExtensionPageShell title={m['analytics.dashboard.title']()} subtitle={m['analytics.dashboard.subtitle']()}>
  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if cat}
    <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
      <div class="space-y-4">
        <div class="form-control">
          <label class="label" for="role-select"><span class="label-text font-medium">Role</span></label>
          <select id="role-select" class="select select-bordered select-sm" value={selectedRole}
            onchange={(e) => selectRole((e.currentTarget as HTMLSelectElement).value)}>
            {#each roles as r (r)}<option value={r}>{r}</option>{/each}
          </select>
          <p class="text-xs text-base-content/50 mt-1">
            {configured ? 'Custom layout set for this role.' : 'Using the system default (not customized).'}
          </p>
        </div>

        <div class="card bg-base-200">
          <div class="card-body p-4 space-y-2">
            <h2 class="font-medium text-sm">Widgets for this role</h2>
            {#each cat.catalog as w (w.id)}
              <label class="flex items-center gap-3 p-1.5 rounded hover:bg-base-300/40 cursor-pointer">
                <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" bind:checked={draft[w.id]} disabled={!w.removable} />
                <span class="text-sm flex-1">{LABELS[w.id] ?? w.id}</span>
                {#if w.permission}
                  <span class="badge badge-ghost badge-xs" title="Requires this permission">{w.permission.resource}:{w.permission.action}</span>
                {:else}
                  <span class="badge badge-success badge-xs badge-outline">everyone</span>
                {/if}
              </label>
            {/each}
            <p class="text-xs text-base-content/50 pt-1">
              A widget only appears for a user if their role also holds the listed permission.
            </p>
          </div>
        </div>

        <button class="btn btn-primary btn-sm gap-2" onclick={save} disabled={saving}>
          <Save size={16} /> {saving ? 'Saving…' : 'Save layout'}
        </button>
      </div>

      <div class="space-y-2">
        <h2 class="font-medium text-sm flex items-center gap-2 text-base-content/60"><Eye size={16} /> Included widgets</h2>
        <div class="border border-base-300 rounded-lg p-4 bg-base-100">
          {#if selectedWidgets.length}
            <div class="flex flex-wrap gap-2">
              {#each selectedWidgets as id (id)}
                <span class="badge badge-lg badge-primary badge-outline">{LABELS[id] ?? id}</span>
              {/each}
            </div>
          {:else}
            <p class="text-sm text-base-content/50 py-8 text-center">No widgets selected.</p>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</ExtensionPageShell>
