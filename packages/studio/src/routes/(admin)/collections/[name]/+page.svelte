<script lang="ts">
import { page } from '$app/state';
import { goto } from '$app/navigation';
import { collectionsApi, api } from '$lib/api.js';
import {
  Plus,
  Sparkles,
  Save,
  Code,
  Database,
  Layers,
  Settings,
  GitFork,
  Columns,
} from '@lucide/svelte';
import { base } from '$app/paths';
import SnippetGenerator from '$lib/components/admin/SnippetGenerator.svelte';
import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';
import Slot from '$lib/components/common/Slot.svelte';
import RecordDrawer from '$lib/components/collections/RecordDrawer.svelte';
import CollectionDataTable from '$lib/components/collections/CollectionDataTable.svelte';
import type {
  CollectionField,
  CollectionSummary,
  CollectionRecord,
  Relation,
  FieldType,
} from '$lib/components/collections/types.js';
import CollectionSchemaPanel from '$lib/components/collections/CollectionSchemaPanel.svelte';
import { auth } from '$lib/auth.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';

const collectionName = $derived(page.params.name ?? '');

// ── Core data ──────────────────────────────────────────────────────────────
let collection = $state<CollectionSummary | null>(null);
let relations = $state<Relation[]>([]);
let loading = $state(true);
// Data-table state (records, pagination, search/sort/selection, realtime) now
// lives in CollectionDataTable; the page holds a ref to call reload() after a
// RecordDrawer save.
let dataTable = $state<{ reload: () => void } | undefined>();
let fieldTypes = $state<FieldType[]>([]);
let allCollections = $state<CollectionSummary[]>([]);

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
const customFields = $derived.by<CollectionField[]>(() => {
  if (!collection) return [];
  const f = collection.fields;
  return (typeof f === 'string' ? JSON.parse(f) : (f ?? [])) as CollectionField[];
});

// Fields usable in the insert form: customFields + m2o relation FK fields merged
const insertableFields = $derived.by<CollectionField[]>(() => {
  const fields: CollectionField[] = customFields
    .filter((f) => !f.is_system && f.type !== 'computed')
    .map((f) => ({ ...f }));
  const seen = new Set(fields.map((f) => f.name));
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
        const idx = fields.findIndex((f) => f.name === rel.source_field);
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
  customFields.filter((f) => f.type !== 'computed' && !f.is_system).slice(0, 8),
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
      api.get<{ relations: Relation[] }>(`/api/relations?collection=${name}`),
      collectionsApi.fieldTypes(),
      collectionsApi.list(),
    ]);
    collection = colRes.collection as CollectionSummary;
    relations = relsRes.relations ?? [];
    fieldTypes = (typesRes.field_types ?? []) as FieldType[];
    allCollections = ((colsRes.collections ?? []) as CollectionSummary[]).filter(
      (c) => c.name !== name,
    );
    aiSearchEnabled = Boolean(collection?.ai_search_enabled);
    aiSearchField = (collection?.ai_search_field as string) ?? '';
  } catch (e) {
    toast.error((e as Error).message || 'Failed to load collection');
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
      api.get<{ relations: Relation[] }>(`/api/relations?collection=${collectionName}`),
    ]);
    collection = colRes.collection as CollectionSummary;
    relations = relsRes.relations ?? [];
  } catch (e) {
    toast.error((e as Error).message || 'Failed to reload schema');
  }
}

// ── Record drawer (create/edit) ────────────────────────────────────────────
// Extracted to $lib/components/collections/RecordDrawer.svelte. Held via
// bind:this so the header button + table rows can call openCreate()/openEdit().
let recordDrawer = $state<
  { openCreate: () => void; openEdit: (record: CollectionRecord) => void } | undefined
>();

// ── Schema tab (fields + relations) ─────────────────────────────────────────
// Extracted to $lib/components/collections/CollectionSchemaPanel.svelte. Held via
// bind:this so the header "Add Field" / "Add Relation" buttons can open its
// drawers; schema mutations call back through onSchemaChanged → reloadSchema.
let schemaPanel = $state<{ openAddField: () => void; openRelForm: () => void } | undefined>();

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
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    savingAI = false;
  }
}

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
        <button onclick={() => schemaPanel?.openAddField()} class="btn btn-primary btn-sm gap-1.5">
          <Columns size={14} /> Add Field
        </button>
        <button onclick={() => schemaPanel?.openRelForm()} class="btn btn-outline btn-sm gap-1.5">
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

    <CollectionSchemaPanel
      bind:this={schemaPanel}
      {collectionName}
      {customFields}
      {relations}
      {fieldTypes}
      {allCollections}
      {m2oTargetMap}
      {loading}
      onSchemaChanged={reloadSchema}
    />

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

