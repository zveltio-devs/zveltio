<script lang="ts">
import { page } from '$app/state';
import { goto } from '$app/navigation';
import { collectionsApi, api } from '$lib/api.js';
import {
  Plus,
  Trash2,
  X,
  Sparkles,
  Save,
  Code,
  Database,
  Layers,
  ArrowRight,
  GitFork,
  Settings,
  GripVertical,
  Columns,
} from '@lucide/svelte';
import { base } from '$app/paths';
import SnippetGenerator from '$lib/components/admin/SnippetGenerator.svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';
import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
import AddFieldDrawer from '$lib/components/fields/AddFieldDrawer.svelte';
import Slot from '$lib/components/common/Slot.svelte';
import RecordDrawer from '$lib/components/collections/RecordDrawer.svelte';
import CollectionDataTable from '$lib/components/collections/CollectionDataTable.svelte';
import { fieldBadgeColor } from '$lib/components/collections/field-helpers.js';
import { auth } from '$lib/auth.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';

const collectionName = $derived(page.params.name ?? '');

// ── Core data ──────────────────────────────────────────────────────────────
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let collection = $state<any>(null);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let relations = $state<any[]>([]);
let loading = $state(true);
// Data-table state (records, pagination, search/sort/selection, realtime) now
// lives in CollectionDataTable; the page holds a ref to call reload() after a
// RecordDrawer save.
let dataTable = $state<{ reload: () => void } | undefined>();
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let fieldTypes = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let allCollections = $state<any[]>([]);

// ── Tabs ──────────────────────────────────────────────────────────────────
type Tab = 'data' | 'schema' | 'api' | 'settings';
const TABS: Tab[] = ['data', 'schema', 'api', 'settings'];
const activeTab = $derived<Tab>(
  TABS.includes(page.url.searchParams.get('tab') as Tab)
    ? (page.url.searchParams.get('tab') as Tab)
    : 'data',
);
function setTab(t: Tab) {
  goto(
    t === 'data'
      ? `${base}/collections/${collectionName}`
      : `${base}/collections/${collectionName}?tab=${t}`,
    { noScroll: true, keepFocus: true },
  );
}

// ── Derived fields ────────────────────────────────────────────────────────
const customFields = $derived.by(() => {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  if (!collection) return [] as any[];
  const f = collection.fields;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (typeof f === 'string' ? JSON.parse(f) : (f ?? [])) as any[];
});

// Fields usable in the insert form: customFields + m2o relation FK fields merged
const insertableFields = $derived.by(() => {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const fields: any[] = customFields
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    .filter((f: any) => !f.is_system && f.type !== 'computed')
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    .map((f: any) => ({ ...f }));
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const seen = new Set(fields.map((f: any) => f.name as string));
  for (const rel of relations) {
    if ((rel.type === 'm2o' || rel.type === 'reference') && rel.source_field) {
      if (!seen.has(rel.source_field)) {
        fields.push({
          name: rel.source_field,
          label: rel.name.replace(/_/g, ' '),
          type: 'm2o',
          options: { related_collection: rel.target_collection },
        });
        seen.add(rel.source_field);
      } else {
        // Enhance existing field with relation dropdown capability
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const idx = fields.findIndex((f: any) => f.name === rel.source_field);
        if (idx >= 0 && !fields[idx].options?.related_collection) {
          fields[idx] = {
            ...fields[idx],
            type: 'm2o',
            options: { ...(fields[idx].options ?? {}), related_collection: rel.target_collection },
          };
        }
      }
    }
  }
  return fields;
});

// Table columns capped at 8 to avoid horizontal overflow
const tableColumns = $derived(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  customFields.filter((f: any) => f.type !== 'computed' && !f.is_system).slice(0, 8),
);

// ── Load ──────────────────────────────────────────────────────────────────
$effect(() => {
  const name = collectionName;
  if (name) loadAll(name);
});

async function loadAll(name: string) {
  loading = true;
  try {
    const [colRes, relsRes, typesRes, colsRes] = await Promise.all([
      collectionsApi.get(name),
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      api.get<{ relations: any[] }>(`/api/relations?collection=${name}`),
      collectionsApi.fieldTypes(),
      collectionsApi.list(),
    ]);
    collection = colRes.collection;
    relations = relsRes.relations ?? [];
    fieldTypes = typesRes.field_types ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    allCollections = (colsRes.collections ?? []).filter((c: any) => c.name !== name);
    aiSearchEnabled = collection?.ai_search_enabled ?? false;
    aiSearchField = collection?.ai_search_field ?? '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message || 'Failed to load collection');
  } finally {
    loading = false;
  }
}

// Display helpers (humanize, fieldLabel, fmtCell, labelFromRecord,
// fieldBadgeColor) live in $lib/components/collections/field-helpers.ts and are
// imported at the top — shared with RecordDrawer + future collection components.

async function reloadSchema() {
  try {
    const [colRes, relsRes] = await Promise.all([
      collectionsApi.get(collectionName),
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      api.get<{ relations: any[] }>(`/api/relations?collection=${collectionName}`),
    ]);
    collection = colRes.collection;
    relations = relsRes.relations ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message || 'Failed to reload schema');
  }
}

// ── Record drawer (create/edit) ────────────────────────────────────────────
// Extracted to $lib/components/collections/RecordDrawer.svelte. Held via
// bind:this so the header button + table rows can call openCreate()/openEdit().
let recordDrawer = $state<
  { openCreate: () => void; openEdit: (record: unknown) => void } | undefined
>();

// ── Schema: fields ────────────────────────────────────────────────────────
let addFieldOpen = $state(false);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function handleAddField(body: Record<string, any>) {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const exists = customFields.find((f: any) => f.name === body.name);
  if (exists) throw new Error(`Field '${body.name}' already exists`);
  await api.post(`/api/collections/${collectionName}/fields`, body);
  await reloadSchema();
}

async function deleteField(fieldName: string) {
  confirmState = {
    open: true,
    title: 'Delete Field',
    message: `Delete field '${fieldName}'? This will permanently DROP the column and all its data.`,
    confirmLabel: 'Drop Field',
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/collections/${collectionName}/fields/${fieldName}`);
        await reloadSchema();
        toast.success(`Field '${fieldName}' deleted`);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        toast.error(err.message);
      }
    },
  };
}

// ── Schema: relations ─────────────────────────────────────────────────────
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

function openRelForm() {
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
    await reloadSchema();
    showRelForm = false;
    toast.success('Relation created');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    relFormError = err.message || 'Failed to create relation';
  } finally {
    savingRel = false;
  }
}

async function deleteRelation(id: string, relName: string) {
  confirmState = {
    open: true,
    title: 'Delete Relation',
    message: `Delete relation '${relName}'? For M2M relations, the junction table will also be dropped.`,
    confirmLabel: 'Delete',
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/relations/${id}`);
        await reloadSchema();
        toast.success(`Relation deleted`);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        toast.error(err.message);
      }
    },
  };
}

// ── AI settings ───────────────────────────────────────────────────────────
let aiSearchEnabled = $state(false);
let aiSearchField = $state('');
let savingAI = $state(false);

async function saveAISettings() {
  savingAI = true;
  try {
    await api.patch(`/api/collections/${collectionName}`, {
      aiSearchEnabled,
      aiSearchField: aiSearchField || null,
    });
    toast.success('Settings saved');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message);
  } finally {
    savingAI = false;
  }
}

// ── Confirm modal ─────────────────────────────────────────────────────────
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

// M2O fields already live in customFields (FK column in this table).
// O2M / M2M / M2A are virtual — no FK column in this table → shown only in Relations section.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
const virtualRelations = $derived(relations.filter((r: any) => r.type !== 'm2o'));

// Lookup: field name → target collection name for M2O FK fields
const m2oTargetMap = $derived.by(() => {
  const map: Record<string, string> = {};
  for (const rel of relations) {
    if (rel.type === 'm2o' && rel.source_field) map[rel.source_field] = rel.target_collection;
  }
  for (const f of customFields) {
    if ((f.type === 'm2o' || f.type === 'reference') && f.options?.related_collection) {
      map[f.name] = f.options.related_collection;
    }
  }
  return map;
});

function relBadgeColor(type: string): string {
  const m: Record<string, string> = {
    o2m: 'badge-primary',
    m2o: 'badge-secondary',
    m2m: 'badge-accent',
    m2a: 'badge-warning',
  };
  return m[type] ?? 'badge-ghost';
}
</script>

<!-- ── Page shell ───────────────────────────────────────────────────────── -->
<div class="space-y-0 pb-16">

  <Breadcrumb crumbs={[
    { label: 'Collections', href: `${base}/collections` },
    { label: collection?.display_name || collectionName },
  ]} />

  <!-- Header -->
  <div class="flex items-start justify-between mt-4 mb-5">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">
        {collection?.display_name || collectionName}
      </h1>
      <p class="text-sm text-base-content/40 font-mono mt-0.5">zvd_{collectionName}</p>
      <!-- S3-03: collection-detail.header — extensions inject badges,
           status pills, sync indicators below the title.
           ctx carries the collection name so contributions can be
           per-collection (e.g. "show only for zvd_orders"). -->
      <Slot name="collection-detail.header" ctx={{ user: auth.user, collection: collectionName }} />
    </div>
    <!-- Extension actions slot — extensions inject contextual actions next
         to the header (e.g. "Generate schema with AI", "Sync to Stripe").
         Rendered before the built-in primary action. -->
    <Slot name="collection-detail.actions" ctx={{ user: auth.user, collection: collectionName, activeTab }} />
    <!-- Context-sensitive header actions -->
    {#if activeTab === 'data'}
      <button onclick={() => recordDrawer?.openCreate()} class="btn btn-primary btn-sm gap-1.5">
        <Plus size={14} /> New Record
      </button>
    {:else if activeTab === 'schema'}
      <div class="flex gap-2">
        <button onclick={() => (addFieldOpen = true)} class="btn btn-primary btn-sm gap-1.5">
          <Columns size={14} /> Add Field
        </button>
        <button onclick={openRelForm} class="btn btn-outline btn-sm gap-1.5">
          <GitFork size={14} /> Add Relation
        </button>
      </div>
    {/if}
  </div>

  <!-- Tabs -->
  <div class="border-b border-base-200 mb-6">
    <div class="flex gap-0">
      {#each [
        { id: 'data' as Tab,     label: 'Data',     Icon: Database  },
        { id: 'schema' as Tab,   label: 'Schema',   Icon: Layers    },
        { id: 'api' as Tab,      label: 'API',      Icon: Code      },
        { id: 'settings' as Tab, label: 'Settings', Icon: Settings  },
      ] as tab}
        <button
          onclick={() => setTab(tab.id)}
          class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors gap-1.5 flex items-center
                 {activeTab === tab.id
                   ? 'border-primary text-primary'
                   : 'border-transparent text-base-content/50 hover:text-base-content'}"
        >
          <tab.Icon size={13} />{tab.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- ── DATA TAB ─────────────────────────────────────────────────────────── -->
  {#if activeTab === 'data'}

    <CollectionDataTable
      bind:this={dataTable}
      {collectionName}
      {customFields}
      {tableColumns}
      {m2oTargetMap}
      onCreate={() => recordDrawer?.openCreate()}
      onEdit={(r) => recordDrawer?.openEdit(r)}
    />

  <!-- ── SCHEMA TAB ──────────────────────────────────────────────────────── -->
  {:else if activeTab === 'schema'}

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

  <!-- ── API TAB ─────────────────────────────────────────────────────────── -->
  {:else if activeTab === 'api'}
    <SnippetGenerator collectionName={collectionName} fields={customFields} />

  <!-- ── SETTINGS TAB ────────────────────────────────────────────────────── -->
  {:else if activeTab === 'settings'}
    <div class="space-y-5 max-w-lg">

      <!-- AI Search -->
      <div class="card bg-base-200/50 border border-base-200">
        <div class="card-body gap-4 p-5">
          <div class="flex items-center gap-2">
            <Sparkles size={16} class="text-primary" />
            <h2 class="font-semibold text-sm">AI Semantic Search</h2>
          </div>
          <p class="text-sm text-base-content/50 leading-relaxed">
            Automatically embed records on create/update for semantic search via
            <code class="text-primary text-xs">POST /ext/ai/search</code>.
            Requires an AI provider with embedding support.
          </p>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" class="toggle toggle-primary toggle-sm"
              bind:checked={aiSearchEnabled} />
            <span class="text-sm font-medium">Enable AI Search for this collection</span>
          </label>
          {#if aiSearchEnabled}
            <div class="form-control">
              <label class="label py-1" for="ai-field">
                <span class="label-text text-sm">Field to embed</span>
                <span class="label-text-alt text-xs opacity-50">blank = all text fields</span>
              </label>
              <select id="ai-field" class="select select-sm" bind:value={aiSearchField}>
                <option value="">— Auto (all text fields) —</option>
                {#each customFields.filter(f => ['text', 'textarea', 'richtext'].includes(f.type)) as f}
                  <option value={f.name}>{f.label || f.name} ({f.type})</option>
                {/each}
              </select>
            </div>
          {/if}
          <button class="btn btn-primary btn-sm w-fit gap-1.5" onclick={saveAISettings} disabled={savingAI}>
            {#if savingAI}
              <span class="loading loading-spinner loading-xs"></span>
            {:else}
              <Save size={13} />
            {/if}
            Save settings
          </button>
        </div>
      </div>

      <!-- Collection info -->
      {#if collection}
        <div class="card bg-base-100 border border-base-200">
          <div class="card-body gap-3 p-5">
            <h2 class="font-semibold text-sm">Collection Info</h2>
            <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm items-center">
              <span class="text-base-content/50">Table</span>
              <code class="font-mono text-xs">zvd_{collectionName}</code>
              <span class="text-base-content/50">Managed</span>
              <span>{collection.is_managed !== false ? 'Yes — DDL managed by Zveltio' : 'No — BYOD (external table)'}</span>
              {#if collection.description}
                <span class="text-base-content/50">Description</span>
                <span>{collection.description}</span>
              {/if}
              <span class="text-base-content/50">Fields</span>
              <span>{customFields.length} custom + 6 system</span>
              <span class="text-base-content/50">Relations</span>
              <span>{relations.length}</span>
            </div>
          </div>
        </div>
      {/if}

    </div>
  {/if}

</div>

<!-- Record create/edit drawer (extracted). Triggered via bind:this from the
     header "New Record" button, the empty state, and the table row actions. -->
<RecordDrawer
  bind:this={recordDrawer}
  {collectionName}
  {insertableFields}
  onSaved={() => dataTable?.reload()}
  onGoToSchema={() => setTab('schema')}
/>

<!-- AddFieldDrawer -->
<AddFieldDrawer
  bind:open={addFieldOpen}
  {fieldTypes}
  {allCollections}
  {collectionName}
  onsave={handleAddField}
/>

<!-- ConfirmModal -->
<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
