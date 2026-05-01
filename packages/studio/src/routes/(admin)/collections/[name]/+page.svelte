<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { collectionsApi, dataApi, api } from '$lib/api.js';
  import {
    Plus, Trash2, RefreshCw, X, Sparkles, Save, Code, Database,
    Layers, ArrowRight, GitFork, Settings, GripVertical, Columns,
  } from '@lucide/svelte';
  import { base } from '$app/paths';
  import SnippetGenerator from '$lib/components/admin/SnippetGenerator.svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';
  import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
  import AddFieldDrawer from '$lib/components/fields/AddFieldDrawer.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  const collectionName = $derived(page.params.name ?? '');

  // ── Core data ──────────────────────────────────────────────────────────────
  let collection = $state<any>(null);
  let records    = $state<any[]>([]);
  let relations  = $state<any[]>([]);
  let pagination = $state<{ total: number; page: number; limit: number; pages?: number }>({ total: 0, page: 1, limit: 25 });
  let loading    = $state(true);
  let fieldTypes     = $state<any[]>([]);
  let allCollections = $state<any[]>([]);

  // ── Tabs ──────────────────────────────────────────────────────────────────
  type Tab = 'data' | 'schema' | 'api' | 'settings';
  const TABS: Tab[] = ['data', 'schema', 'api', 'settings'];
  const activeTab = $derived<Tab>(
    (TABS.includes(page.url.searchParams.get('tab') as Tab)
      ? (page.url.searchParams.get('tab') as Tab)
      : 'data')
  );
  function setTab(t: Tab) {
    goto(
      t === 'data'
        ? `${base}/collections/${collectionName}`
        : `${base}/collections/${collectionName}?tab=${t}`,
      { noScroll: true, keepFocus: true }
    );
  }

  // ── Derived fields ────────────────────────────────────────────────────────
  const customFields = $derived.by(() => {
    if (!collection) return [] as any[];
    const f = collection.fields;
    return (typeof f === 'string' ? JSON.parse(f) : f ?? []) as any[];
  });

  // Fields usable in the insert form: customFields + m2o relation FK fields merged
  const insertableFields = $derived.by(() => {
    const fields: any[] = customFields
      .filter((f: any) => !f.is_system && f.type !== 'computed')
      .map((f: any) => ({ ...f }));
    const seen = new Set(fields.map((f: any) => f.name as string));
    for (const rel of relations) {
      if ((rel.type === 'm2o' || rel.type === 'reference') && rel.source_field) {
        if (!seen.has(rel.source_field)) {
          fields.push({
            name:    rel.source_field,
            label:   rel.name.replace(/_/g, ' '),
            type:    'm2o',
            options: { related_collection: rel.target_collection },
          });
          seen.add(rel.source_field);
        } else {
          // Enhance existing field with relation dropdown capability
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
    customFields.filter((f: any) => f.type !== 'computed' && !f.is_system).slice(0, 8)
  );

  // ── Load ──────────────────────────────────────────────────────────────────
  $effect(() => {
    const name = collectionName;
    if (name) loadAll(name);
  });

  async function loadAll(name: string) {
    loading = true;
    try {
      const [colRes, dataRes, relsRes, typesRes, colsRes] = await Promise.all([
        collectionsApi.get(name),
        dataApi.list(name, { limit: '25' }),
        api.get<{ relations: any[] }>(`/api/relations?collection=${name}`),
        collectionsApi.fieldTypes(),
        collectionsApi.list(),
      ]);
      collection    = colRes.collection;
      records       = dataRes.records;
      pagination    = dataRes.pagination;
      relations     = relsRes.relations ?? [];
      fieldTypes    = typesRes.field_types ?? [];
      allCollections = (colsRes.collections ?? []).filter((c: any) => c.name !== name);
      aiSearchEnabled = collection?.ai_search_enabled ?? false;
      aiSearchField   = collection?.ai_search_field   ?? '';
    } catch (e: any) {
      toast.error(e.message || 'Failed to load collection');
    } finally {
      loading = false;
    }
  }

  /** Build URL params for the data list — includes ?expand= for every m2o
   *  field so the table can render link chips instead of raw UUIDs. */
  function buildDataParams(p: { page?: number; limit?: number } = {}) {
    const params: Record<string, string> = {
      page:  String(p.page  ?? pagination.page  ?? 1),
      limit: String(p.limit ?? pagination.limit ?? 25),
    };
    if (sortField) {
      params.sort = sortField;
      params.order = sortDir;
    }
    if (searchText.trim()) params.search = searchText.trim();
    // Auto-expand every m2o relation field so cells can show readable labels.
    const m2oFields = customFields
      .filter((f: any) => (f.type === 'm2o' || f.type === 'reference') && f.options?.related_collection)
      .map((f: any) => f.name);
    if (m2oFields.length > 0) params.expand = m2oFields.join(',');
    return params;
  }

  async function reloadData(p: { page?: number; limit?: number } = {}) {
    try {
      const res = await dataApi.list(collectionName, buildDataParams(p));
      records    = res.records;
      pagination = res.pagination;
      // Drop selection on data refresh — surviving ids may have been deleted
      selectedIds.clear();
      selectedIds = new Set(selectedIds);
    } catch (e: any) {
      toast.error(e.message || 'Failed to reload');
    }
  }

  // ── List controls (search, sort, selection) ─────────────────────────
  let searchText  = $state('');
  let sortField   = $state('');
  let sortDir     = $state<'asc' | 'desc'>('desc');
  let selectedIds = $state(new Set<string>());

  function toggleSort(name: string) {
    if (sortField === name) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortField = name;
      sortDir = 'asc';
    }
    reloadData({ page: 1 });
  }

  let searchTimer: any;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => reloadData({ page: 1 }), 250);
  }

  function toggleSelectAll() {
    if (selectedIds.size === records.length) {
      selectedIds = new Set();
    } else {
      selectedIds = new Set(records.map((r) => r.id));
    }
  }

  function toggleSelect(id: string) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    selectedIds = new Set(selectedIds);
  }

  async function bulkDeleteSelected() {
    if (selectedIds.size === 0) return;
    confirmState = {
      open: true,
      title: 'Delete selected records',
      message: `Delete ${selectedIds.size} record(s)? This cannot be undone.`,
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await dataApi.bulkDelete(collectionName, [...selectedIds]);
          selectedIds = new Set();
          await reloadData();
          toast.success('Records deleted');
        } catch (e: any) {
          toast.error(e.message || 'Bulk delete failed');
        }
      },
    };
  }

  // ── Pagination helpers ─────────────────────────────────────────────
  function goToPage(p: number) {
    if (p < 1 || (pagination.pages && p > pagination.pages)) return;
    reloadData({ page: p });
  }

  // ── Display helpers ─────────────────────────────────────────────────
  /** Convert "snake_case" field name into "Snake Case" — used as a fallback
   *  table header when a field has no explicit `label`. */
  function humanize(s: string): string {
    return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function fieldLabel(f: any): string {
    if (f.label) return f.label;
    return humanize(f.name);
  }

  async function reloadSchema() {
    try {
      const [colRes, relsRes] = await Promise.all([
        collectionsApi.get(collectionName),
        api.get<{ relations: any[] }>(`/api/relations?collection=${collectionName}`),
      ]);
      collection = colRes.collection;
      relations  = relsRes.relations ?? [];
    } catch (e: any) {
      toast.error(e.message || 'Failed to reload schema');
    }
  }

  // ── Record drawer (right slide-over) — used for both Insert and Edit ────
  let drawerOpen     = $state(false);
  let drawerMode     = $state<'create' | 'edit'>('create');
  let drawerRecordId = $state<string | null>(null);
  let insertForm     = $state<Record<string, any>>({});
  let inserting      = $state(false);
  let relOptions     = $state<Record<string, { id: string; label: string }[]>>({});
  let loadingRelOpts = $state(false);
  let formErrors     = $state<Record<string, string>>({});

  function labelFromRecord(record: any): string {
    for (const k of ['name', 'title', 'label', 'email', 'slug', 'full_name', 'display_name']) {
      if (record[k]) return String(record[k]);
    }
    const kv = Object.entries(record).find(
      ([k, v]) => k !== 'id' && !k.startsWith('created') && !k.startsWith('updated') && v != null
    );
    return kv ? String(kv[1]) : (record.id?.slice(0, 8) ?? '—');
  }

  async function loadRelOptions() {
    loadingRelOpts = true;
    const relFields = insertableFields.filter(
      (f: any) => (f.type === 'm2o' || f.type === 'reference') && f.options?.related_collection
    );
    const entries = await Promise.all(
      relFields.map(async (f: any) => {
        try {
          const res = await dataApi.list(f.options.related_collection, { limit: '200' });
          return [f.name, (res.records ?? []).map((r: any) => ({ id: r.id, label: labelFromRecord(r) }))] as const;
        } catch { return [f.name, [] as { id: string; label: string }[]] as const; }
      })
    );
    relOptions     = Object.fromEntries(entries);
    loadingRelOpts = false;
  }

  async function openCreateDrawer() {
    drawerMode = 'create';
    drawerRecordId = null;
    insertForm = {};
    formErrors = {};
    drawerOpen = true;
    loadRelOptions();
  }

  async function openEditDrawer(record: any) {
    drawerMode = 'edit';
    drawerRecordId = record.id;
    insertForm = {};
    formErrors = {};
    // Seed the form with current values for editable fields only
    for (const f of insertableFields) {
      const v = record[f.name];
      if (v !== undefined && v !== null) insertForm[f.name] = v;
    }
    drawerOpen = true;
    loadRelOptions();
  }

  /** Light client-side validation — required fields, basic email/url patterns,
   *  numeric range. Server-side validation still runs and is authoritative. */
  function validateForm(): boolean {
    formErrors = {};
    let ok = true;
    for (const f of insertableFields) {
      const v = insertForm[f.name];
      const present = v !== undefined && v !== null && v !== '';
      if (f.required && !present) {
        formErrors[f.name] = 'Required';
        ok = false;
        continue;
      }
      if (!present) continue;
      if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) {
        formErrors[f.name] = 'Invalid email';
        ok = false;
      }
      if (f.type === 'url' && !/^https?:\/\//i.test(String(v))) {
        formErrors[f.name] = 'Must start with http:// or https://';
        ok = false;
      }
      if ((f.type === 'number' || f.type === 'integer' || f.type === 'decimal') && Number.isNaN(Number(v))) {
        formErrors[f.name] = 'Must be a number';
        ok = false;
      }
      if (f.type === 'integer' && !Number.isInteger(Number(v))) {
        formErrors[f.name] = 'Must be a whole number';
        ok = false;
      }
    }
    formErrors = { ...formErrors };
    return ok;
  }

  async function saveRecord() {
    if (!validateForm()) return;
    inserting = true;
    try {
      // Strip empty strings so server uses defaults / NULL where applicable
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(insertForm)) {
        if (v === '' || v === undefined) continue;
        payload[k] = v;
      }
      if (drawerMode === 'create') {
        await dataApi.create(collectionName, payload);
        toast.success('Record created');
      } else if (drawerRecordId) {
        await dataApi.update(collectionName, drawerRecordId, payload);
        toast.success('Record updated');
      }
      drawerOpen = false;
      insertForm = {};
      drawerRecordId = null;
      await reloadData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save record');
    } finally {
      inserting = false;
    }
  }

  // Backwards-compat alias used by older onclick handlers in this file.
  const openDrawer = openCreateDrawer;
  const insertRecord = saveRecord;

  // ── Schema: fields ────────────────────────────────────────────────────────
  let addFieldOpen = $state(false);

  async function handleAddField(body: Record<string, any>) {
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
        } catch (err: any) {
          toast.error(err.message);
        }
      },
    };
  }

  // ── Schema: relations ─────────────────────────────────────────────────────
  let showRelForm   = $state(false);
  let savingRel     = $state(false);
  let relFormError  = $state('');
  let relForm = $state({
    name: '', type: 'o2m' as string,
    source_field: '',                  // m2o: FK col in this table; o2m/m2m: virtual alias
    target_collection: '',
    target_field: '',                  // o2m only: FK col in target table
    on_delete: 'SET NULL',
  });
  let targetFields = $state<any[]>([]);

  const relTypesMeta = [
    {
      value: 'm2o', symbol: '∞→1', label: 'Many-to-One',
      desc: 'Each record points to ONE other record',
      example: (src: string, tgt: string) => `each ${singular(src)} has ONE ${singular(tgt)}`,
    },
    {
      value: 'o2m', symbol: '1→∞', label: 'One-to-Many',
      desc: 'Each record can have MANY related records',
      example: (src: string, tgt: string) => `each ${singular(src)} has MANY ${tgt}`,
    },
    {
      value: 'm2m', symbol: '∞↔∞', label: 'Many-to-Many',
      desc: 'Records can be linked to many on both sides',
      example: (src: string, tgt: string) => `${src} and ${tgt} share many links`,
    },
  ];

  function singular(name: string): string {
    return name.endsWith('ies') ? name.slice(0, -3) + 'y'
         : name.endsWith('s')    ? name.slice(0, -1)
         : name;
  }

  // Auto-suggest the relation name + fields based on the chosen type+target.
  // Saves the user from inventing names — they can still edit before submit.
  function suggestRelDefaults() {
    if (!relForm.target_collection) return;
    const tgt = relForm.target_collection;
    if (!relForm.name) {
      relForm.name = relForm.type === 'm2o' ? `${collectionName}_${singular(tgt)}`
                   : relForm.type === 'o2m' ? `${collectionName}_${tgt}`
                   : `${collectionName}_${tgt}`;
    }
    if (!relForm.source_field) {
      relForm.source_field = relForm.type === 'm2o' ? `${singular(tgt)}_id`
                          : relForm.type === 'o2m' ? tgt
                          : tgt;
    }
    if (relForm.type === 'o2m' && !relForm.target_field) {
      relForm.target_field = `${singular(collectionName)}_id`;
    }
  }

  async function onRelTargetChange() {
    targetFields = [];
    if (!relForm.target_collection) return;
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
    relForm = { name: '', type: 'm2o', source_field: '', target_collection: '', target_field: '', on_delete: 'SET NULL' };
    targetFields  = [];
    relFormError  = '';
    showRelForm   = true;
  }

  async function addRelation() {
    relFormError = '';
    if (!relForm.target_collection) { relFormError = 'Choose a target collection'; return; }
    if (!relForm.source_field.trim()) {
      relFormError = relForm.type === 'm2o'
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
        } catch (err: any) {
          toast.error(err.message);
        }
      },
    };
  }

  // ── Delete record ─────────────────────────────────────────────────────────
  async function deleteRecord(id: string) {
    confirmState = {
      open: true,
      title: 'Delete Record',
      message: 'Delete this record? This cannot be undone.',
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await dataApi.delete(collectionName, id);
          await reloadData();
        } catch (err: any) {
          toast.error(err.message);
        }
      },
    };
  }

  // ── AI settings ───────────────────────────────────────────────────────────
  let aiSearchEnabled = $state(false);
  let aiSearchField   = $state('');
  let savingAI        = $state(false);

  async function saveAISettings() {
    savingAI = true;
    try {
      await api.patch(`/api/collections/${collectionName}`, {
        aiSearchEnabled, aiSearchField: aiSearchField || null,
      });
      toast.success('Settings saved');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      savingAI = false;
    }
  }

  // ── Confirm modal ─────────────────────────────────────────────────────────
  let confirmState = $state<{
    open: boolean; title: string; message: string;
    confirmLabel?: string; onconfirm: () => void;
  }>({ open: false, title: '', message: '', onconfirm: () => {} });

  // ── Formatting helpers ────────────────────────────────────────────────────
  function fmtCell(value: any, type?: string): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object')  return JSON.stringify(value).slice(0, 50) + '…';
    const s = String(value);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  // M2O fields already live in customFields (FK column in this table).
  // O2M / M2M / M2A are virtual — no FK column in this table → shown only in Relations section.
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
    const m: Record<string, string> = { o2m: 'badge-primary', m2o: 'badge-secondary', m2m: 'badge-accent', m2a: 'badge-warning' };
    return m[type] ?? 'badge-ghost';
  }

  function fieldBadgeColor(type: string): string {
    const m: Record<string, string> = {
      text: '', textarea: '', richtext: '',
      number: 'badge-info', integer: 'badge-info', decimal: 'badge-info',
      boolean: 'badge-success',
      date: 'badge-warning', datetime: 'badge-warning', timestamp: 'badge-warning',
      m2o: 'badge-secondary', reference: 'badge-secondary',
      uuid: 'badge-neutral', json: 'badge-neutral', jsonb: 'badge-neutral',
    };
    return m[type] ?? '';
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
    </div>
    <!-- Context-sensitive header actions -->
    {#if activeTab === 'data'}
      <button onclick={openDrawer} class="btn btn-primary btn-sm gap-1.5">
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

    <!-- Toolbar: search + count + selection actions -->
    <div class="flex flex-wrap items-center gap-3 mb-3">
      <div class="flex-1 min-w-50 relative">
        <input
          type="text"
          bind:value={searchText}
          oninput={onSearchInput}
          placeholder="Search records…"
          class="input input-sm w-full pl-8" />
        <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-base-content/30"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21 21-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"/>
        </svg>
      </div>
      <span class="text-xs text-base-content/40 whitespace-nowrap">
        {#if !loading}
          {pagination.total ?? 0} total
          {#if selectedIds.size > 0}· <span class="text-primary font-medium">{selectedIds.size} selected</span>{/if}
        {/if}
      </span>
      {#if selectedIds.size > 0}
        <button onclick={bulkDeleteSelected} class="btn btn-error btn-sm gap-1">
          <Trash2 size={14} /> Delete {selectedIds.size}
        </button>
      {/if}
      <button onclick={() => reloadData()} class="btn btn-ghost btn-sm btn-square" title="Refresh" aria-label="Refresh">
        <RefreshCw size={14} />
      </button>
    </div>

    {#if loading}
      <LoadingSkeleton type="table" rows={6} cols={5} />
    {:else if records.length === 0}
      <div class="flex flex-col items-center justify-center py-24 gap-4 text-base-content/30">
        <Database size={44} strokeWidth={1.2} />
        <div class="text-center">
          <p class="text-base font-semibold text-base-content/50">
            {searchText ? `No records match "${searchText}"` : 'No records yet'}
          </p>
          <p class="text-sm mt-0.5">
            {searchText ? 'Try a different query or clear the search.' : 'Create the first record in this collection'}
          </p>
        </div>
        {#if !searchText}
          <button onclick={openCreateDrawer} class="btn btn-primary btn-sm gap-1.5 mt-1">
            <Plus size={14} /> Add first record
          </button>
        {/if}
      </div>
    {:else}
      <!-- Desktop / wide table view -->
      <div class="overflow-x-auto rounded-xl border border-base-200 hidden md:block">
        <table class="table table-sm">
          <thead>
            <tr class="bg-base-200/60">
              <th class="w-10">
                <input type="checkbox"
                  class="checkbox checkbox-xs"
                  checked={selectedIds.size === records.length && records.length > 0}
                  onchange={toggleSelectAll}
                  aria-label="Select all" />
              </th>
              {#each tableColumns as col}
                <th class="text-xs font-semibold text-base-content/50 uppercase tracking-wide whitespace-nowrap">
                  <button class="inline-flex items-center gap-1 hover:text-base-content"
                    onclick={() => toggleSort(col.name)}>
                    {fieldLabel(col)}
                    {#if sortField === col.name}
                      <span class="text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    {/if}
                  </button>
                </th>
              {/each}
              <th class="text-xs font-semibold text-base-content/50 uppercase tracking-wide w-28">
                <button class="inline-flex items-center gap-1 hover:text-base-content"
                  onclick={() => toggleSort('created_at')}>
                  Created
                  {#if sortField === 'created_at'}
                    <span class="text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  {/if}
                </button>
              </th>
              <th class="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {#each records as record (record.id)}
              <tr class="hover group {selectedIds.has(record.id) ? 'bg-primary/5' : ''}">
                <td>
                  <input type="checkbox"
                    class="checkbox checkbox-xs"
                    checked={selectedIds.has(record.id)}
                    onchange={() => toggleSelect(record.id)}
                    aria-label="Select row" />
                </td>
                {#each tableColumns as col}
                  <td class="max-w-55">
                    {#if record[col.name] === null || record[col.name] === undefined}
                      <span class="text-base-content/20">—</span>
                    {:else if col.type === 'boolean'}
                      <span class="badge badge-xs {record[col.name] ? 'badge-success' : 'badge-ghost'}">
                        {record[col.name] ? 'Yes' : 'No'}
                      </span>
                    {:else if (col.type === 'm2o' || col.type === 'reference') && record[`${col.name}_expanded`]}
                      <a href="{base}/collections/{m2oTargetMap[col.name]}" class="badge badge-sm badge-secondary hover:badge-primary gap-1 font-normal">
                        <ArrowRight size={10} />
                        {record[`${col.name}_expanded`]._label}
                      </a>
                    {:else if col.type === 'm2o' || col.type === 'reference'}
                      <span class="badge badge-xs badge-ghost font-mono opacity-60">{String(record[col.name]).slice(0,8)}…</span>
                    {:else}
                      <span class="truncate block text-sm">{fmtCell(record[col.name], col.type)}</span>
                    {/if}
                  </td>
                {/each}
                <td class="text-xs text-base-content/40 whitespace-nowrap">
                  {new Date(record.created_at).toLocaleDateString()}
                </td>
                <td>
                  <div class="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onclick={() => openEditDrawer(record)}
                      class="btn btn-ghost btn-xs"
                      title="Edit record"
                      aria-label="Edit"
                    >
                      <Settings size={12} />
                    </button>
                    <button
                      onclick={() => deleteRecord(record.id)}
                      class="btn btn-ghost btn-xs text-error"
                      title="Delete record"
                      aria-label="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Mobile / narrow card view -->
      <div class="md:hidden space-y-2">
        {#each records as record (record.id)}
          <div class="rounded-xl border border-base-200 bg-base-100 p-3
                      {selectedIds.has(record.id) ? 'ring-2 ring-primary' : ''}">
            <div class="flex items-start justify-between gap-2 mb-2">
              <input type="checkbox"
                class="checkbox checkbox-sm mt-1"
                checked={selectedIds.has(record.id)}
                onchange={() => toggleSelect(record.id)}
                aria-label="Select row" />
              <div class="flex-1 min-w-0">
                <p class="font-semibold truncate">{labelFromRecord(record)}</p>
                <p class="text-xs text-base-content/40 font-mono mt-0.5">{record.id?.slice(0, 8)}…</p>
              </div>
              <div class="flex gap-1">
                <button onclick={() => openEditDrawer(record)} class="btn btn-ghost btn-xs btn-square" aria-label="Edit">
                  <Settings size={12} />
                </button>
                <button onclick={() => deleteRecord(record.id)} class="btn btn-ghost btn-xs btn-square text-error" aria-label="Delete">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <dl class="space-y-1 text-sm">
              {#each tableColumns as col}
                <div class="flex justify-between gap-3 leading-tight">
                  <dt class="text-base-content/40 text-xs uppercase tracking-wide pt-0.5">{fieldLabel(col)}</dt>
                  <dd class="text-right truncate max-w-[60%]">
                    {#if record[col.name] === null || record[col.name] === undefined}
                      <span class="text-base-content/20">—</span>
                    {:else if (col.type === 'm2o' || col.type === 'reference') && record[`${col.name}_expanded`]}
                      <a href="{base}/collections/{m2oTargetMap[col.name]}" class="badge badge-sm badge-secondary gap-1">
                        {record[`${col.name}_expanded`]._label}
                      </a>
                    {:else}
                      {fmtCell(record[col.name], col.type)}
                    {/if}
                  </dd>
                </div>
              {/each}
            </dl>
          </div>
        {/each}
      </div>

      <!-- Pagination footer -->
      {#if (pagination.pages ?? 0) > 1 || (pagination.total ?? 0) > (pagination.limit ?? 25)}
        <div class="flex items-center justify-between mt-4 text-sm">
          <span class="text-base-content/50">
            Page {pagination.page ?? 1} of {pagination.pages ?? 1}
          </span>
          <div class="join">
            <button class="join-item btn btn-sm" disabled={(pagination.page ?? 1) <= 1}
              onclick={() => goToPage((pagination.page ?? 1) - 1)}>← Prev</button>
            <button class="join-item btn btn-sm" disabled={(pagination.page ?? 1) >= (pagination.pages ?? 1)}
              onclick={() => goToPage((pagination.page ?? 1) + 1)}>Next →</button>
          </div>
        </div>
      {/if}
    {/if}

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
            <code class="text-primary text-xs">POST /api/ai/search</code>.
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

<!-- ── Insert Record Drawer (right slide-over) ──────────────────────────── -->
{#if drawerOpen}
  <div
    class="fixed inset-0 z-50 flex"
    role="dialog"
    aria-modal="true"
    aria-label="New Record"
  >
    <!-- Backdrop -->
    <div
      class="flex-1 bg-black/30 backdrop-blur-[1px]"
      role="button"
      tabindex="-1"
      onclick={() => (drawerOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (drawerOpen = false)}
    ></div>

    <!-- Panel -->
    <div class="w-120 max-w-[95vw] bg-base-100 shadow-2xl flex flex-col h-full border-l border-base-200">

      <!-- Panel header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-base-200 shrink-0">
        <div>
          <h2 class="font-bold text-lg">{drawerMode === 'edit' ? 'Edit Record' : 'New Record'}</h2>
          <p class="text-xs text-base-content/40 font-mono mt-0.5">
            {collectionName}{#if drawerMode === 'edit' && drawerRecordId} · {drawerRecordId.slice(0, 8)}…{/if}
          </p>
        </div>
        <button class="btn btn-ghost btn-sm btn-square" onclick={() => (drawerOpen = false)} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <!-- Panel body (scrollable) -->
      <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

        {#if insertableFields.length === 0}
          <div class="flex flex-col items-center justify-center h-full py-16 text-base-content/40 gap-3">
            <Layers size={36} strokeWidth={1.2} />
            <p class="text-sm text-center">
              No fields defined yet.
            </p>
            <button
              class="btn btn-link btn-sm"
              onclick={() => { drawerOpen = false; setTab('schema'); }}
            >
              Go to Schema to add fields →
            </button>
          </div>
        {:else}

          {#each insertableFields as field (field.name)}
            <div class="space-y-1.5">

              <!-- Field label row -->
              <div class="flex items-center gap-2">
                <label for="ins-{field.name}" class="text-sm font-semibold leading-none">
                  {fieldLabel(field)}
                </label>
                <span class="badge badge-xs badge-outline font-mono opacity-60 {fieldBadgeColor(field.type)}">
                  {field.type}
                </span>
                {#if field.required}
                  <span class="text-error text-xs font-bold ml-auto">required</span>
                {/if}
              </div>

              {#if field.description}
                <p class="text-xs text-base-content/40">{field.description}</p>
              {/if}

              <!-- Input control based on field type -->
              {#if field.type === 'boolean'}
                <label class="flex items-center gap-3 cursor-pointer py-1" for="ins-{field.name}">
                  <input
                    id="ins-{field.name}"
                    type="checkbox"
                    class="toggle toggle-primary toggle-sm"
                    bind:checked={insertForm[field.name]}
                  />
                  <span class="text-sm text-base-content/60">
                    {insertForm[field.name] ? 'Yes' : 'No'}
                  </span>
                </label>

              {:else if field.type === 'textarea' || field.type === 'richtext' || field.type === 'longtext'}
                <textarea
                  id="ins-{field.name}"
                  class="textarea textarea-bordered w-full min-h-28 text-sm resize-y"
                  placeholder="Enter {field.label || field.name}…"
                  bind:value={insertForm[field.name]}
                ></textarea>

              {:else if field.type === 'json' || field.type === 'jsonb'}
                <textarea
                  id="ins-{field.name}"
                  class="textarea textarea-bordered w-full min-h-20 font-mono text-xs resize-y"
                  placeholder={"{}"}
                  bind:value={insertForm[field.name]}
                ></textarea>

              {:else if field.type === 'number' || field.type === 'integer' || field.type === 'decimal'}
                <input
                  id="ins-{field.name}"
                  type="number"
                  class="input input-bordered w-full"
                  placeholder="0"
                  bind:value={insertForm[field.name]}
                />

              {:else if field.type === 'date'}
                <input
                  id="ins-{field.name}"
                  type="date"
                  class="input input-bordered w-full"
                  bind:value={insertForm[field.name]}
                />

              {:else if field.type === 'datetime' || field.type === 'timestamp'}
                <input
                  id="ins-{field.name}"
                  type="datetime-local"
                  class="input input-bordered w-full"
                  bind:value={insertForm[field.name]}
                />

              {:else if field.type === 'select' && (field.options?.choices?.length || field.options?.length)}
                <select
                  id="ins-{field.name}"
                  class="select select-bordered w-full"
                  bind:value={insertForm[field.name]}
                >
                  <option value="">— select —</option>
                  {#each (field.options?.choices ?? field.options ?? []) as opt}
                    <option value={opt.value ?? opt}>{opt.label ?? opt}</option>
                  {/each}
                </select>

              {:else if (field.type === 'm2o' || field.type === 'reference') && field.options?.related_collection}
                <select
                  id="ins-{field.name}"
                  class="select select-bordered w-full"
                  bind:value={insertForm[field.name]}
                >
                  <option value="">
                    {loadingRelOpts ? 'Loading…' : `— select from ${field.options.related_collection} —`}
                  </option>
                  {#if !loadingRelOpts}
                    {#each (relOptions[field.name] ?? []) as opt}
                      <option value={opt.id}>{opt.label}</option>
                    {/each}
                  {/if}
                </select>
                {#if !loadingRelOpts && !(relOptions[field.name]?.length)}
                  <p class="text-xs text-base-content/40 mt-0.5">
                    No records in <span class="font-mono">{field.options.related_collection}</span> yet
                  </p>
                {/if}

              {:else if field.type === 'color'}
                <div class="flex items-center gap-2">
                  <input
                    type="color"
                    class="h-10 w-12 rounded border border-base-300 cursor-pointer p-0.5 bg-transparent"
                    bind:value={insertForm[field.name]}
                  />
                  <input
                    id="ins-{field.name}"
                    type="text"
                    class="input input-bordered flex-1"
                    placeholder="#000000"
                    bind:value={insertForm[field.name]}
                  />
                </div>

              {:else}
                <input
                  id="ins-{field.name}"
                  type="text"
                  class="input input-bordered w-full {formErrors[field.name] ? 'input-error' : ''}"
                  placeholder="Enter {fieldLabel(field)}…"
                  bind:value={insertForm[field.name]}
                />
              {/if}

              {#if formErrors[field.name]}
                <p class="text-error text-xs">{formErrors[field.name]}</p>
              {/if}

            </div>
          {/each}

        {/if}
      </div>

      <!-- Panel footer -->
      <div class="px-6 py-4 border-t border-base-200 flex justify-end gap-2 shrink-0 bg-base-50">
        <button class="btn btn-ghost" onclick={() => (drawerOpen = false)}>Cancel</button>
        <button
          class="btn btn-primary gap-1.5"
          onclick={saveRecord}
          disabled={inserting}
        >
          {#if inserting}
            <span class="loading loading-spinner loading-xs"></span>
          {:else if drawerMode === 'edit'}
            <Save size={14} />
          {:else}
            <Plus size={14} />
          {/if}
          {drawerMode === 'edit' ? 'Update Record' : 'Save Record'}
        </button>
      </div>

    </div>
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

<!-- ConfirmModal -->
<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
