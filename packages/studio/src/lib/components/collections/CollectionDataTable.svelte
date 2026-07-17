<script lang="ts">
import { fmtDate } from '$lib/stores/format.svelte.js';
// The Data tab of the collections detail page: record browsing (search, sort,
// selection, pagination), realtime live-sync, row delete, and bulk delete.
// Extracted from collections/[name]/+page.svelte (H-07 studio split). It owns
// its own record data; the parent passes the collection's derived field lists
// and wires create/edit to the RecordDrawer via the onCreate/onEdit callbacks.
// `reload()` is exported so the parent can refresh after a drawer save.
import { onDestroy } from 'svelte';
import { base } from '$app/paths';
import { Plus, Trash2, RefreshCw, Database, ArrowRight, Settings } from '@lucide/svelte';
import { dataApi } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { withOptimistic } from '$lib/stores/optimistic.svelte.js';
import { realtime } from '$lib/stores/realtime.svelte.js';
import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { fieldLabel, fmtCell, labelFromRecord } from './field-helpers.js';
import type { CollectionField, CollectionRecord } from './types.js';

interface Props {
  collectionName: string;
  customFields: CollectionField[];
  tableColumns: CollectionField[];
  m2oTargetMap: Record<string, string>;
  onCreate: () => void;
  onEdit: (record: CollectionRecord) => void;
}
const { collectionName, customFields, tableColumns, m2oTargetMap, onCreate, onEdit }: Props =
  $props();

let records = $state<CollectionRecord[]>([]);
let pagination = $state<{ total: number; page: number; limit: number; pages?: number }>({
  total: 0,
  page: 1,
  limit: 25,
});
let loading = $state(true);
let searchText = $state('');
let sortField = $state('');
let sortDir = $state<'asc' | 'desc'>('desc');
let selectedIds = $state(new Set<string>());

/** Build URL params for the data list — includes ?expand= for every m2o field
 *  so the table can render link chips instead of raw UUIDs. */
function buildDataParams(p: { page?: number; limit?: number } = {}) {
  const params: Record<string, string> = {
    page: String(p.page ?? pagination.page ?? 1),
    limit: String(p.limit ?? pagination.limit ?? 25),
  };
  if (sortField) {
    params.sort = sortField;
    params.order = sortDir;
  }
  if (searchText.trim()) params.search = searchText.trim();
  const m2oFields = customFields
    .filter(
      (f: CollectionField) =>
        (f.type === 'm2o' || f.type === 'reference') && f.options?.related_collection,
    )
    .map((f: CollectionField) => f.name);
  if (m2oFields.length > 0) params.expand = m2oFields.join(',');
  return params;
}

async function reloadData(p: { page?: number; limit?: number } = {}) {
  try {
    const res = await dataApi.list(collectionName, buildDataParams(p));
    records = res.records;
    pagination = res.pagination;
    // Drop selection on data refresh — surviving ids may have been deleted
    selectedIds.clear();
    selectedIds = new Set(selectedIds);
  } catch (e) {
    toast.error((e as Error).message || 'Failed to reload');
  }
}

/** Public: refresh after an external mutation (e.g. RecordDrawer save). */
export async function reload() {
  await reloadData();
}

// Initial + on-collection-change load (shows the skeleton).
$effect(() => {
  const name = collectionName;
  if (!name) return;
  loading = true;
  reloadData().finally(() => {
    loading = false;
  });
});

// ── Realtime live sync ───────────────────────────────────────────────────
let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
let realtimeTeardown: (() => void) | null = null;

$effect(() => {
  const name = collectionName;
  if (!name) return;
  realtimeTeardown?.();
  realtimeTeardown = realtime.onCollection(name, () => {
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      // Skip the loading flicker for live sync — the user didn't ask for a
      // reload, so we shouldn't break their scroll position.
      reloadData().catch(() => {
        /* network blip — next event retries */
      });
    }, 250);
  });
  return () => {
    if (reloadDebounce) {
      clearTimeout(reloadDebounce);
      reloadDebounce = null;
    }
    realtimeTeardown?.();
    realtimeTeardown = null;
  };
});

onDestroy(() => {
  if (reloadDebounce) clearTimeout(reloadDebounce);
  realtimeTeardown?.();
});

// ── List controls (search, sort, selection) ─────────────────────────
function toggleSort(name: string) {
  if (sortField === name) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortField = name;
    sortDir = 'asc';
  }
  reloadData({ page: 1 });
}

let searchTimer: ReturnType<typeof setTimeout>;
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
      } catch (e) {
        toast.error((e as Error).message || 'Bulk delete failed');
      }
    },
  };
}

function goToPage(p: number) {
  if (p < 1 || (pagination.pages && p > pagination.pages)) return;
  reloadData({ page: p });
}

// ── Delete record (optimistic) ────────────────────────────────────────────
async function deleteRecord(id: string) {
  confirmState = {
    open: true,
    title: 'Delete Record',
    message: 'Delete this record? This cannot be undone.',
    confirmLabel: 'Delete',
    onconfirm: async () => {
      confirmState.open = false;
      const snapshot = records;
      await withOptimistic({
        apply: () => {
          records = records.filter((r) => r.id !== id);
        },
        rollback: (prev) => {
          records = prev;
        },
        snapshot,
        commit: () => dataApi.delete(collectionName, id),
        onError: (err) => toast.error(err.message),
      });
    },
  };
}

// ── Confirm modal ─────────────────────────────────────────────────────────
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });
</script>

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
      <button onclick={() => onCreate()} class="btn btn-primary btn-sm gap-1.5 mt-1">
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
                    {(record[`${col.name}_expanded`] as { _label?: unknown })?._label}
                  </a>
                {:else if col.type === 'm2o' || col.type === 'reference'}
                  <span class="badge badge-xs badge-ghost font-mono opacity-60">{String(record[col.name]).slice(0,8)}…</span>
                {:else}
                  <span class="truncate block text-sm">{fmtCell(record[col.name], col.type)}</span>
                {/if}
              </td>
            {/each}
            <td class="text-xs text-base-content/40 whitespace-nowrap">
              {fmtDate(record.created_at)}
            </td>
            <td>
              <div class="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onclick={() => onEdit(record)}
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
            <button onclick={() => onEdit(record)} class="btn btn-ghost btn-xs btn-square" aria-label="Edit">
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
                    {(record[`${col.name}_expanded`] as { _label?: unknown })?._label}
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

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
