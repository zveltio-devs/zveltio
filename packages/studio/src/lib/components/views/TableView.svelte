<script lang="ts">
  import { ChevronUp, ChevronDown, ChevronsUpDown, Plus, Trash2, Eye } from '@lucide/svelte';
  import DataCell from './DataCell.svelte';
  import TablePagination from './TablePagination.svelte';

  interface Column {
    field: string;
    label: string;
    type?: string;
    width?: number;
    sortable?: boolean;
    visible?: boolean;
  }

  interface Props {
    collection?: string;
    config?: Record<string, any>;
    fields?: any[];
    data?: any[];
    total?: number;
    loading?: boolean;
    page?: number;
    sort?: string;
    sortDir?: 'asc' | 'desc';
    onPageChange?: (page: number) => void;
    onPageSizeChange?: (size: number) => void;
    onSort?: (field: string) => void;
    onRowClick?: (row: any) => void;
    onCreate?: () => void;
    onDelete?: (row: any) => void;
    onSelectionChange?: (ids: string[]) => void;
  }

  let {
    config = {},
    fields = [],
    data = [],
    total = 0,
    loading = false,
    page = 1,
    sort = '',
    sortDir = 'asc',
    onPageChange,
    onPageSizeChange,
    onSort,
    onRowClick,
    onCreate,
    onDelete,
    onSelectionChange,
  }: Props = $props();

  const pageSize = $derived(config.pageSize ?? 25);
  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  const actions = $derived(config.actions ?? ['create', 'edit', 'delete']);
  const selectable = $derived(config.selectable ?? false);

  const columns = $derived<Column[]>(
    (config.columns?.filter((c: Column) => c.visible !== false)) ??
    fields.filter((f: any) => !f.is_system).slice(0, 8).map((f: any) => ({
      field: f.name, label: f.display_name ?? f.name, type: f.type, sortable: true,
    }))
  );

  let selected = $state<Set<string>>(new Set());

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
    onSelectionChange?.([...next]);
  }

  function toggleAll() {
    selected = selected.size === data.length ? new Set() : new Set(data.map((r: any) => r.id));
    onSelectionChange?.([...selected]);
  }

  function getFieldType(field: string): string {
    return fields.find((f: any) => f.name === field)?.type ?? 'text';
  }
</script>

<div class="flex flex-col h-full gap-3">
  <!-- Toolbar -->
  <div class="flex items-center justify-between shrink-0">
    <span class="text-sm text-base-content/60">
      {#if loading}Loading…{:else}{total} record{total !== 1 ? 's' : ''}{/if}
    </span>
    {#if actions.includes('create') && onCreate}
      <button class="btn btn-primary btn-sm gap-1" onclick={onCreate}>
        <Plus size={14}/> New
      </button>
    {/if}
  </div>

  <!-- Table -->
  <div class="overflow-auto flex-1 rounded-lg border border-base-300">
    <table class="table table-sm w-full">
      <thead class="sticky top-0 bg-base-200 z-10">
        <tr>
          {#if selectable}
            <th class="w-8">
              <input type="checkbox" class="checkbox checkbox-sm"
                checked={data.length > 0 && selected.size === data.length}
                onchange={toggleAll}/>
            </th>
          {/if}
          {#each columns as col}
            <th style={col.width ? `width:${col.width}px` : ''}>
              {#if col.sortable !== false}
                <button class="flex items-center gap-1 hover:text-primary transition-colors"
                  onclick={() => onSort?.(col.field)}>
                  {col.label}
                  {#if sort === col.field}
                    {#if sortDir === 'asc'}<ChevronUp size={12}/>{:else}<ChevronDown size={12}/>{/if}
                  {:else}<ChevronsUpDown size={12} class="opacity-30"/>{/if}
                </button>
              {:else}{col.label}{/if}
            </th>
          {/each}
          {#if actions.includes('edit') || actions.includes('delete') || actions.includes('view')}
            <th class="w-20 text-right">Actions</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#if loading}
          {#each Array(5) as _}
            <tr>
              {#if selectable}<td><div class="skeleton h-4 w-4 rounded"/></td>{/if}
              {#each columns as _c}<td><div class="skeleton h-4 w-24 rounded"/></td>{/each}
              <td/>
            </tr>
          {/each}
        {:else if data.length === 0}
          <tr>
            <td colspan={columns.length + (selectable ? 2 : 1)} class="text-center py-12 text-base-content/40">
              No records found
            </td>
          </tr>
        {:else}
          {#each data as row (row.id)}
            <tr class="hover cursor-pointer" onclick={() => onRowClick?.(row)}>
              {#if selectable}
                <td onclick={(e) => { e.stopPropagation(); toggleSelect(row.id); }}>
                  <input type="checkbox" class="checkbox checkbox-sm" checked={selected.has(row.id)}
                    onchange={() => toggleSelect(row.id)}/>
                </td>
              {/if}
              {#each columns as col}
                <td class="max-w-xs truncate">
                  <DataCell value={row[col.field]} type={col.type ?? getFieldType(col.field)}/>
                </td>
              {/each}
              {#if actions.includes('edit') || actions.includes('delete') || actions.includes('view')}
                <td onclick={(e) => e.stopPropagation()}>
                  <div class="flex justify-end gap-1">
                    {#if actions.includes('view')}
                      <button class="btn btn-ghost btn-xs" onclick={() => onRowClick?.(row)} title="View">
                        <Eye size={12}/>
                      </button>
                    {/if}
                    {#if actions.includes('delete') && onDelete}
                      <button class="btn btn-ghost btn-xs text-error hover:bg-error/10"
                        onclick={() => onDelete?.(row)} title="Delete">
                        <Trash2 size={12}/>
                      </button>
                    {/if}
                  </div>
                </td>
              {/if}
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  {#if totalPages > 1 || total > pageSize}
    <div class="shrink-0">
      <TablePagination currentPage={page} {totalPages} totalRecords={total} {pageSize}
        onPageChange={(p) => onPageChange?.(p)}
        onPageSizeChange={(s) => onPageSizeChange?.(s)}/>
    </div>
  {/if}
</div>