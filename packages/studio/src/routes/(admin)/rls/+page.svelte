<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
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
  { value: 'user_id', label: m['rls.currentUserId'] },
  { value: 'user_email', label: m['rls.currentUserEmail'] },
  { value: 'user_role', label: m['rls.currentUserRole'] },
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
  open: boolean;
  title: string;
  message: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

onMount(loadAll);

async function loadAll() {
  loading = true;
  try {
    const [rlsRes, colRes, roleRes] = await Promise.all([
      api.get<{ policies: RlsPolicy[] }>('/api/admin/rls'),
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      api.get<{ collections: any[] }>('/api/collections'),
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      api.get<{ roles: any[] }>('/api/admin/roles'),
    ]);
    policies = rlsRes.policies ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    collections = (colRes.collections ?? []).map((c: any) => c.slug ?? c.name);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const customRoles = (roleRes.roles ?? []).map((r: any) => r.name);
    roles = ['*', 'god', 'admin', 'member', ...customRoles];
  } catch (err) {
    toast.error(m['rls.loadFailed']());
  } finally {
    loading = false;
  }
}

function openNew() {
  editingId = null;
  form = {
    collection: collections[0] ?? '',
    role: '*',
    filter_field: 'created_by',
    filter_op: 'eq',
    filter_value_source: 'user_id',
    is_enabled: true,
    description: '',
  };
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
      toast.success(m['rls.policyUpdated']());
    } else {
      await api.post('/api/admin/rls', body);
      toast.success(m['rls.policyCreated']());
    }
    showForm = false;
    await loadAll();
  } catch (err) {
    toast.error(m['rls.saveFailed']());
  } finally {
    saving = false;
  }
}

function confirmDelete(p: RlsPolicy) {
  confirmState = {
    open: true,
    title: m['rls.deleteTitle'](),
    message: m['rls.deleteMsg']({ collection: p.collection, role: p.role }),
    onconfirm: async () => {
      try {
        await api.delete(`/api/admin/rls/${p.id}`);
        toast.success(m['rls.policyDeleted']());
        await loadAll();
      } catch {
        toast.error(m['rls.deleteFailed']());
      }
    },
  };
}

async function toggleEnabled(p: RlsPolicy) {
  try {
    await api.patch(`/api/admin/rls/${p.id}`, { is_enabled: !p.is_enabled });
    p.is_enabled = !p.is_enabled;
  } catch {
    toast.error(m['rls.updateFailed']());
  }
}

function sourceLabel(src: string): string {
  const known = VALUE_SOURCES.find((v) => v.value === src);
  if (known) return known.label();
  if (src.startsWith('static:')) return `"${src.slice(7)}"`;
  return src;
}
</script>

<!--
  Passed as the default content, not as an `actions` snippet. `PageHeader` takes
  `children` and renders nothing else, so `{#snippet actions()}` put this button
  somewhere the component never looked and the "New policy" control simply did
  not appear on this page. Every other caller passes content directly; this was
  the only one that did not, and nothing said so until svelte-check ran.
-->
<PageHeader title={m['rls.title']()} subtitle={m['rls.subtitle']()}>
  <button onclick={openNew} class="btn btn-primary btn-sm gap-1">
    <Plus class="h-4 w-4" /> {m['rls.newPolicy']()}
  </button>
</PageHeader>

<!-- Info banner: DaisyUI alert auto-themes (light + dark) — the old
     hardcoded `bg-blue-950 text-blue-300` rendered as light-blue text
     on a light-blue background in light mode, invisible. -->
<div role="status" class="mx-6 mb-4 alert alert-info alert-soft text-sm">
  <Info class="h-4 w-4 shrink-0" />
  <div>
    {m['rls.banner1']()}
    {m['rls.banner2']()}
    {m['rls.banner3']()}
  </div>
</div>

{#if loading}
  <div class="px-6"><LoadingSkeleton type="table" /></div>
{:else if policies.length === 0 && !showForm}
  <!-- Empty state -->
  <div class="flex flex-col items-center justify-center py-24 text-center">
    <div class="mb-4 rounded-full border border-base-content/10 bg-base-200 p-5">
      <Shield class="h-10 w-10 text-base-content/55" />
    </div>
    <h2 class="text-lg font-semibold">{m['rls.emptyTitle']()}</h2>
    <p class="mt-1 text-sm text-base-content/65">{m['rls.emptyDesc']()}</p>
    <button onclick={openNew} class="btn btn-primary btn-sm mt-4 gap-1">
      <Plus class="h-4 w-4" /> {m['rls.newPolicy']()}
    </button>
  </div>
{:else}
  <div class="px-6 space-y-4">

    <!-- Policy form -->
    {#if showForm}
      <div class="rounded-xl border border-base-content/10 bg-base-200 p-5 space-y-4">
        <h3 class="font-semibold">{editingId ? m['rls.editPolicy']() : m['rls.newPolicy']()}</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div class="form-control">
            <label class="label label-text text-xs" for="rls-collection">{m['common.col.collection']()}</label>
            <select id="rls-collection" bind:value={form.collection} class="select select-sm select-bordered w-full">
              <option value="*">{m['rls.allCollectionsOpt']()}</option>
              {#each collections as col}
                <option value={col}>{col}</option>
              {/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label label-text text-xs" for="rls-role">{m['common.col.role']()}</label>
            <select id="rls-role" bind:value={form.role} class="select select-sm select-bordered w-full">
              {#each roles as r}
                <option value={r}>{r === '*' ? m['rls.allRolesOpt']() : r}</option>
              {/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label label-text text-xs" for="rls-filter-field">{m['rls.filterField']()}</label>
            <input id="rls-filter-field" bind:value={form.filter_field} type="text" placeholder={m['rls.egCreatedBy']()} class="input input-sm input-bordered w-full" />
          </div>
          <div class="form-control">
            <label class="label label-text text-xs" for="rls-operator">{m['rls.operator']()}</label>
            <select id="rls-operator" bind:value={form.filter_op} class="select select-sm select-bordered w-full">
              {#each FILTER_OPS as op}
                <option value={op}>{op}</option>
              {/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label label-text text-xs" for="rls-value-source">{m['rls.valueSource']()}</label>
            <select id="rls-value-source" bind:value={form.filter_value_source} class="select select-sm select-bordered w-full">
              {#each VALUE_SOURCES as vs}
                <option value={vs.value}>{vs.label()}</option>
              {/each}
              <option value="static:">{m['rls.staticValue']()}</option>
            </select>
            {#if form.filter_value_source === 'static:' || form.filter_value_source.startsWith('static:')}
              <input
                value={form.filter_value_source.startsWith('static:') ? form.filter_value_source.slice(7) : ''}
                oninput={(e) => { form.filter_value_source = `static:${(e.target as HTMLInputElement).value}`; }}
                type="text" placeholder={m['rls.literalValue']()} class="input input-sm input-bordered w-full mt-1"
              />
            {/if}
          </div>
          <div class="form-control sm:col-span-2 lg:col-span-1">
            <label class="label label-text text-xs" for="rls-description">{m['rls.descOptional']()}</label>
            <input id="rls-description" bind:value={form.description} type="text" placeholder={m['rls.egUsersOwnRecords']()} class="input input-sm input-bordered w-full" />
          </div>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 cursor-pointer text-sm">
            <input type="checkbox" bind:checked={form.is_enabled} class="checkbox checkbox-sm" />
            {m['common.col.enabled']()}
          </label>
          <div class="ml-auto flex gap-2">
            <button onclick={() => (showForm = false)} class="btn btn-ghost btn-sm"><X class="h-4 w-4" /></button>
            <button onclick={save} disabled={saving} class="btn btn-primary btn-sm gap-1">
              {#if saving}
                <span class="loading loading-spinner loading-xs"></span>
              {:else}
                <Check class="h-4 w-4" />
              {/if}
              {editingId ? m['rls.update']() : m['common.create']()}
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
            <tr class="text-xs text-base-content/65">
              <th>{m['common.col.collection']()}</th>
              <th>{m['common.col.role']()}</th>
              <th>{m['rls.rule']()}</th>
              <th>{m['common.col.description']()}</th>
              <th class="text-center">{m['common.col.enabled']()}</th>
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
                <td class="text-sm text-base-content/65">{policy.description ?? '—'}</td>
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
