<script lang="ts">
import { Plus, Trash2, X, ArrowRight, GitFork, Columns, GripVertical } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import AddFieldDrawer from '$lib/components/fields/AddFieldDrawer.svelte';
import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
import { fieldBadgeColor } from '$lib/components/collections/field-helpers.js';

// Schema tab for a collection: custom fields (add/drop via AddFieldDrawer),
// virtual relations (add/delete via the inline builder), and the read-only
// system-fields list. Extracted from collections/[name]/+page.svelte (H-07
// studio split). The page owns the canonical collection/relations state and
// re-fetches it on `onSchemaChanged`; this component only issues the mutating
// API calls + drives the schema UI. The Add Field / Add Relation header buttons
// live in the page header and reach in via `openAddField()` / `openRelForm()`.
let {
  collectionName,
  customFields,
  relations,
  fieldTypes,
  allCollections,
  m2oTargetMap,
  loading,
  onSchemaChanged,
}: {
  collectionName: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  customFields: any[];
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  relations: any[];
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  fieldTypes: any[];
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  allCollections: any[];
  m2oTargetMap: Record<string, string>;
  loading: boolean;
  onSchemaChanged: () => Promise<void> | void;
} = $props();

// M2O fields already live in customFields (FK column in this table).
// O2M / M2M / M2A are virtual — no FK column here → shown only in Relations.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
const virtualRelations = $derived(relations.filter((r: any) => r.type !== 'm2o'));

// ── Fields ────────────────────────────────────────────────────────────────
let addFieldOpen = $state(false);
export function openAddField() {
  addFieldOpen = true;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function handleAddField(body: Record<string, any>) {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const exists = customFields.find((f: any) => f.name === body.name);
  if (exists) throw new Error(`Field '${body.name}' already exists`);
  await api.post(`/api/collections/${collectionName}/fields`, body);
  await onSchemaChanged();
}

function deleteField(fieldName: string) {
  confirmState = {
    open: true,
    title: 'Delete Field',
    message: `Delete field '${fieldName}'? This will permanently DROP the column and all its data.`,
    confirmLabel: 'Drop Field',
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/collections/${collectionName}/fields/${fieldName}`);
        await onSchemaChanged();
        toast.success(`Field '${fieldName}' deleted`);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        toast.error(err.message);
      }
    },
  };
}

// ── Relations ─────────────────────────────────────────────────────────────
let showRelForm = $state(false);
let savingRel = $state(false);
let relFormError = $state('');
let relForm = $state({
  name: '',
  type: 'o2m' as string,
  source_field: '', // m2o: FK col in this table; o2m/m2m: virtual alias
  target_collection: '',
  target_field: '', // o2m only: FK col in target table
  on_delete: 'SET NULL',
});
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let targetFields = $state<any[]>([]);

const relTypesMeta = [
  {
    value: 'm2o',
    symbol: '∞→1',
    label: 'Many-to-One',
    desc: 'Each record points to ONE other record',
    example: (src: string, tgt: string) => `each ${singular(src)} has ONE ${singular(tgt)}`,
  },
  {
    value: 'o2m',
    symbol: '1→∞',
    label: 'One-to-Many',
    desc: 'Each record can have MANY related records',
    example: (src: string, tgt: string) => `each ${singular(src)} has MANY ${tgt}`,
  },
  {
    value: 'm2m',
    symbol: '∞↔∞',
    label: 'Many-to-Many',
    desc: 'Records can be linked to many on both sides',
    example: (src: string, tgt: string) => `${src} and ${tgt} share many links`,
  },
];

function singular(name: string): string {
  return name.endsWith('ies')
    ? name.slice(0, -3) + 'y'
    : name.endsWith('s')
      ? name.slice(0, -1)
      : name;
}

// Auto-suggest the relation name + fields based on the chosen type+target.
// Saves the user from inventing names — they can still edit before submit.
function suggestRelDefaults() {
  if (!relForm.target_collection) return;
  const tgt = relForm.target_collection;
  if (!relForm.name) {
    relForm.name =
      relForm.type === 'm2o'
        ? `${collectionName}_${singular(tgt)}`
        : relForm.type === 'o2m'
          ? `${collectionName}_${tgt}`
          : `${collectionName}_${tgt}`;
  }
  if (!relForm.source_field) {
    relForm.source_field =
      relForm.type === 'm2o' ? `${singular(tgt)}_id` : relForm.type === 'o2m' ? tgt : tgt;
  }
  if (relForm.type === 'o2m' && !relForm.target_field) {
    relForm.target_field = `${singular(collectionName)}_id`;
  }
}

async function onRelTargetChange() {
  targetFields = [];
  if (!relForm.target_collection) return;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const tgt = allCollections.find((c: any) => c.name === relForm.target_collection);
  if (tgt) {
    const f = typeof tgt.fields === 'string' ? JSON.parse(tgt.fields) : tgt.fields;
    targetFields = f ?? [];
  }
  suggestRelDefaults();
}

function onRelTypeChange(newType: string) {
  relForm.type = newType;
  // Reset auto-generated fields so the suggestions match the new type.
  relForm.name = '';
  relForm.source_field = '';
  relForm.target_field = '';
  if (relForm.target_collection) suggestRelDefaults();
}

export function openRelForm() {
  relForm = {
    name: '',
    type: 'm2o',
    source_field: '',
    target_collection: '',
    target_field: '',
    on_delete: 'SET NULL',
  };
  targetFields = [];
  relFormError = '';
  showRelForm = true;
}

async function addRelation() {
  relFormError = '';
  if (!relForm.target_collection) {
    relFormError = 'Choose a target collection';
    return;
  }
  if (!relForm.source_field.trim()) {
    relFormError =
      relForm.type === 'm2o'
        ? 'Choose a name for the foreign-key column in this collection'
        : 'Choose a name for the relation alias';
    return;
  }
  if (relForm.type === 'o2m' && !relForm.target_field.trim()) {
    relFormError = `Choose the FK column name to add in "${relForm.target_collection}"`;
    return;
  }
  if (relForm.type === 'o2m' && relForm.source_field.trim() === relForm.target_field.trim()) {
    relFormError = 'Relation alias and FK column name must be different';
    return;
  }
  if (!relForm.name.trim()) {
    relForm.name = `${collectionName}_${relForm.source_field}`;
  }
  savingRel = true;
  try {
    const payload: Record<string, unknown> = {
      name: relForm.name,
      type: relForm.type,
      source_collection: collectionName,
      source_field: relForm.source_field,
      target_collection: relForm.target_collection,
      on_delete: relForm.on_delete,
    };
    if (relForm.type === 'o2m') payload.target_field = relForm.target_field;
    await api.post('/api/relations', payload);
    await onSchemaChanged();
    showRelForm = false;
    toast.success('Relation created');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    relFormError = err.message || 'Failed to create relation';
  } finally {
    savingRel = false;
  }
}

function deleteRelation(id: string, relName: string) {
  confirmState = {
    open: true,
    title: 'Delete Relation',
    message: `Delete relation '${relName}'? For M2M relations, the junction table will also be dropped.`,
    confirmLabel: 'Delete',
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/relations/${id}`);
        await onSchemaChanged();
        toast.success(`Relation deleted`);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        toast.error(err.message);
      }
    },
  };
}

function relBadgeColor(type: string): string {
  const m: Record<string, string> = {
    o2m: 'badge-primary',
    m2o: 'badge-secondary',
    m2m: 'badge-accent',
    m2a: 'badge-warning',
  };
  return m[type] ?? 'badge-ghost';
}

// ── Confirm modal (schema-local) ────────────────────────────────────────────
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });
</script>

<!-- Add Relation inline form -->
{#if showRelForm}
  <div class="card bg-base-200/60 border border-primary/20 mb-6">
    <div class="card-body gap-4 p-5">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="font-semibold">New Relation</h3>
          <p class="text-xs text-base-content/50 mt-0.5">
            How is <code class="font-mono">{collectionName}</code> connected to another collection?
          </p>
        </div>
        <button class="btn btn-ghost btn-xs btn-square" onclick={() => (showRelForm = false)} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <!-- Step 1: pick the target collection (drives the rest) -->
      <div class="form-control">
        <label class="label py-1" for="rel-target">
          <span class="label-text text-xs font-medium">1. Connect with…</span>
        </label>
        <select id="rel-target" bind:value={relForm.target_collection} onchange={onRelTargetChange} class="select select-sm">
          <option value="">Choose collection…</option>
          {#each allCollections as col}
            <option value={col.name}>{col.display_name || col.name}</option>
          {/each}
        </select>
      </div>

      <!-- Step 2: relationship shape, only after a target is picked -->
      {#if relForm.target_collection}
        <div>
          <p class="label-text text-xs font-medium mb-2">2. What's the shape?</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {#each relTypesMeta as rt}
              <button
                class="p-3 rounded-xl border-2 text-left transition-all
                       {relForm.type === rt.value
                         ? 'border-primary bg-primary/5'
                         : 'border-base-300 bg-base-100 hover:border-base-400'}"
                onclick={() => onRelTypeChange(rt.value)}
              >
                <div class="font-mono text-xl font-bold text-primary/60 mb-1 leading-none">{rt.symbol}</div>
                <div class="font-semibold text-xs">{rt.label}</div>
                <div class="text-[10px] text-base-content/50 mt-0.5 leading-tight">
                  {rt.example(collectionName, relForm.target_collection)}
                </div>
              </button>
            {/each}
          </div>
        </div>

        <!-- Step 3: column / alias names — auto-filled, editable -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {#if relForm.type === 'm2o'}
            <div class="form-control sm:col-span-2">
              <label class="label py-1" for="rel-source-field">
                <span class="label-text text-xs font-medium">
                  3. Foreign-key column to add in <code class="font-mono">{collectionName}</code>
                </span>
              </label>
              <input id="rel-source-field" type="text" bind:value={relForm.source_field}
                placeholder="e.g. {singular(relForm.target_collection)}_id"
                class="input input-sm font-mono" autocomplete="off" />
              <p class="text-[10px] text-base-content/40 mt-1">
                A new UUID column on <code class="font-mono">{collectionName}</code> that references the chosen {singular(relForm.target_collection)}.
              </p>
            </div>
            <div class="form-control">
              <label class="label py-1" for="rel-on-delete">
                <span class="label-text text-xs font-medium">When the {singular(relForm.target_collection)} is deleted…</span>
              </label>
              <select id="rel-on-delete" bind:value={relForm.on_delete} class="select select-sm">
                <option value="SET NULL">Keep this record but clear the link (SET NULL)</option>
                <option value="CASCADE">Delete this record too (CASCADE)</option>
                <option value="RESTRICT">Block the deletion (RESTRICT)</option>
                <option value="NO ACTION">Do nothing — let the DB decide (NO ACTION)</option>
              </select>
            </div>
          {:else if relForm.type === 'o2m'}
            <div class="form-control">
              <label class="label py-1" for="rel-source-field-o2m">
                <span class="label-text text-xs font-medium">
                  3. Alias on <code class="font-mono">{collectionName}</code>
                </span>
              </label>
              <input id="rel-source-field-o2m" type="text" bind:value={relForm.source_field}
                placeholder={relForm.target_collection || 'related'}
                class="input input-sm font-mono" autocomplete="off" />
              <p class="text-[10px] text-base-content/40 mt-1">
                Virtual name used to access the related list — no physical column is created here.
              </p>
            </div>
            <div class="form-control">
              <label class="label py-1" for="rel-target-field">
                <span class="label-text text-xs font-medium">
                  4. FK column to add in <code class="font-mono">{relForm.target_collection}</code>
                </span>
              </label>
              <input id="rel-target-field" type="text" bind:value={relForm.target_field}
                placeholder="e.g. {singular(collectionName)}_id"
                class="input input-sm font-mono" autocomplete="off" />
              <p class="text-[10px] text-base-content/40 mt-1">
                The actual column added to <code class="font-mono">{relForm.target_collection}</code> pointing back to {singular(collectionName)}.
              </p>
            </div>
            <div class="form-control sm:col-span-2">
              <label class="label py-1" for="rel-on-delete-o2m">
                <span class="label-text text-xs font-medium">When a {singular(collectionName)} is deleted…</span>
              </label>
              <select id="rel-on-delete-o2m" bind:value={relForm.on_delete} class="select select-sm">
                <option value="SET NULL">Orphan the related records (SET NULL)</option>
                <option value="CASCADE">Delete the related records too (CASCADE)</option>
                <option value="RESTRICT">Block the deletion (RESTRICT)</option>
                <option value="NO ACTION">Do nothing — let the DB decide (NO ACTION)</option>
              </select>
            </div>
          {:else}
            <!-- m2m -->
            <div class="form-control sm:col-span-2">
              <label class="label py-1" for="rel-source-field-m2m">
                <span class="label-text text-xs font-medium">
                  3. Alias on <code class="font-mono">{collectionName}</code>
                </span>
              </label>
              <input id="rel-source-field-m2m" type="text" bind:value={relForm.source_field}
                placeholder={relForm.target_collection}
                class="input input-sm font-mono" autocomplete="off" />
              <p class="text-[10px] text-base-content/40 mt-1">
                A junction table <code class="font-mono">zvd_jnc_{collectionName}_{relForm.target_collection}</code> will be created automatically.
              </p>
            </div>
          {/if}

          <div class="form-control sm:col-span-2">
            <label class="label py-1" for="rel-name">
              <span class="label-text text-xs font-medium opacity-60">Internal name (for the relations registry)</span>
            </label>
            <input id="rel-name" type="text" bind:value={relForm.name}
              placeholder="auto-generated" class="input input-sm" autocomplete="off" />
          </div>
        </div>
      {/if}

      {#if relFormError}
        <p class="text-error text-xs">{relFormError}</p>
      {/if}

      <div class="flex gap-2">
        <button class="btn btn-primary btn-sm" onclick={addRelation}
          disabled={savingRel || !relForm.target_collection}>
          {#if savingRel}<span class="loading loading-spinner loading-xs"></span>{/if}
          Create Relation
        </button>
        <button class="btn btn-ghost btn-sm"
          onclick={() => { showRelForm = false; relFormError = ''; }}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

{#if loading}
  <LoadingSkeleton type="list" rows={5} />
{:else}
  <div class="space-y-8">

    <!-- Section: Custom Fields -->
    <section>
      <h2 class="text-xs font-semibold text-base-content/40 uppercase tracking-widest mb-2.5">
        Fields ({customFields.length})
      </h2>
      {#if customFields.length === 0}
        <div class="flex flex-col items-center justify-center py-10 rounded-xl border-2 border-dashed border-base-300 text-base-content/40 gap-2">
          <Columns size={28} strokeWidth={1.4} />
          <p class="text-sm">No custom fields yet</p>
          <button class="btn btn-primary btn-sm btn-outline gap-1 mt-1"
            onclick={() => (addFieldOpen = true)}>
            <Plus size={13} /> Add first field
          </button>
        </div>
      {:else}
        <div class="space-y-1.5">
          {#each customFields as field (field.name)}
            <div class="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-base-100
                        border border-base-200 hover:border-base-300 group transition-colors">
              <GripVertical size={14} class="text-base-content/15 cursor-grab shrink-0" />
              <code class="font-mono text-sm font-semibold min-w-0 truncate flex-1">
                {field.name}
              </code>
              {#if field.label && field.label !== field.name}
                <span class="text-base-content/40 text-xs hidden lg:block">{field.label}</span>
              {/if}
              <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                <span class="badge badge-xs badge-outline font-mono {fieldBadgeColor(field.type)}">
                  {field.type}
                </span>
                {#if m2oTargetMap[field.name]}
                  <span class="badge badge-xs badge-secondary gap-0.5 font-mono">
                    <ArrowRight size={9} />
                    {m2oTargetMap[field.name]}
                  </span>
                {/if}
                {#if field.required}<span class="badge badge-xs badge-warning">required</span>{/if}
                {#if field.unique}<span class="badge badge-xs badge-info">unique</span>{/if}
                {#if field.indexed}<span class="badge badge-xs badge-ghost">indexed</span>{/if}
              </div>
              <button
                onclick={() => deleteField(field.name)}
                class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                title="Delete field"
              >
                <Trash2 size={13} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Section: Relations (O2M / M2M / M2A — virtual, no FK column in this table) -->
    <section>
      <h2 class="text-xs font-semibold text-base-content/40 uppercase tracking-widest mb-2.5">
        Relations ({virtualRelations.length})
      </h2>
      {#if virtualRelations.length === 0}
        <div class="flex flex-col items-center justify-center py-10 rounded-xl border-2 border-dashed border-base-300 text-base-content/40 gap-2">
          <GitFork size={28} strokeWidth={1.4} />
          <p class="text-sm">No virtual relations — add 1→∞ or ∞↔∞</p>
          <button class="btn btn-outline btn-sm gap-1 mt-1" onclick={openRelForm}>
            <Plus size={13} /> Add relation
          </button>
        </div>
      {:else}
        <div class="space-y-1.5">
          {#each virtualRelations as rel (rel.id)}
            <div class="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-base-100
                        border border-base-200 hover:border-base-300 group transition-colors">
              <span class="badge badge-sm {relBadgeColor(rel.type)} font-mono shrink-0">
                {rel.type.toUpperCase()}
              </span>
              <div class="flex-1 min-w-0">
                <span class="font-semibold text-sm">{rel.name}</span>
                <div class="flex items-center gap-1 text-xs text-base-content/40 font-mono mt-0.5 flex-wrap">
                  <span>{rel.source_collection}</span>
                  {#if rel.source_field}
                    <span class="text-base-content/25">.{rel.source_field}</span>
                  {/if}
                  <ArrowRight size={10} class="shrink-0" />
                  <span>{rel.target_collection}</span>
                  {#if rel.target_field}
                    <span class="text-base-content/25">.{rel.target_field}</span>
                  {/if}
                  {#if rel.junction_table}
                    <span class="text-base-content/25 ml-1">via {rel.junction_table}</span>
                  {/if}
                </div>
              </div>
              {#if rel.on_delete}
                <span class="badge badge-ghost badge-xs hidden sm:flex shrink-0">{rel.on_delete}</span>
              {/if}
              <button
                onclick={() => deleteRelation(rel.id, rel.name)}
                class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Section: System Fields -->
    <section class="pt-2 border-t border-base-200">
      <h2 class="text-xs font-semibold text-base-content/25 uppercase tracking-widest mb-2.5">
        System Fields (auto-managed)
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {#each [
          { name: 'id',         type: 'uuid',      note: 'Primary key'         },
          { name: 'created_at', type: 'timestamp', note: 'Auto-set on insert'  },
          { name: 'updated_at', type: 'timestamp', note: 'Auto-updated'        },
          { name: 'status',     type: 'text',      note: 'active/draft/archived'},
          { name: 'created_by', type: 'uuid',      note: 'User who created'    },
          { name: 'updated_by', type: 'uuid',      note: 'User who last updated'},
        ] as sf}
          <div class="flex items-center gap-2 px-3 py-2 rounded-lg opacity-35 bg-base-200">
            <code class="font-mono text-xs flex-1">{sf.name}</code>
            <span class="badge badge-ghost badge-xs font-mono">{sf.type}</span>
          </div>
        {/each}
      </div>
    </section>

  </div>
{/if}

<!-- AddFieldDrawer -->
<AddFieldDrawer
  bind:open={addFieldOpen}
  {fieldTypes}
  {allCollections}
  {collectionName}
  onsave={handleAddField}
/>

<!-- ConfirmModal (schema-local: field/relation deletes) -->
<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
