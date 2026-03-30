<script lang="ts">
  import { untrack } from 'svelte';
  import { Table2, LayoutGrid, Calendar, Kanban, BarChart2, List, SlidersHorizontal, Columns3, Search, X } from '@lucide/svelte';
  import TableView from './TableView.svelte';
  import FilterBar from './FilterBar.svelte';
  import ColumnManager from './ColumnManager.svelte';
  import DetailView from './DetailView.svelte';
  import StatsView from './StatsView.svelte';

  type ViewType = 'table' | 'gallery' | 'kanban' | 'calendar' | 'chart' | 'detail';

  interface Props {
    collection?: string;
    fields?: any[];
    data?: any[];
    total?: number;
    loading?: boolean;
    config?: Record<string, any>;
    allowedViews?: ViewType[];
    onConfigChange?: (config: Record<string, any>) => void;
    onFetch?: (params: FetchParams) => void;
    onCreate?: () => void;
    onEdit?: (row: any) => void;
    onDelete?: (row: any) => void;
    onRowClick?: (row: any) => void;
  }

  interface FetchParams {
    page: number;
    pageSize: number;
    sort: string;
    sortDir: 'asc' | 'desc';
    filters: any[];
    search: string;
  }

  let {
    collection = '',
    fields = [],
    data = [],
    total = 0,
    loading = false,
    config = {},
    allowedViews = ['table', 'gallery', 'kanban', 'calendar', 'chart'],
    onConfigChange,
    onFetch,
    onCreate,
    onEdit,
    onDelete,
    onRowClick,
  }: Props = $props();

  // ── Active view type ───────────────────────────────────────────────────────
  let activeView = $state<ViewType>(untrack(() => (config.default_view as ViewType) ?? 'table'));

  // ── Toolbar panels ─────────────────────────────────────────────────────────
  let showFilters = $state(false);
  let showColumns = $state(false);
  let showStats = $state(false);
  let search = $state('');

  // ── Pagination / sort ──────────────────────────────────────────────────────
  let page = $state(1);
  let sort = $state(untrack(() => config.default_sort ?? ''));
  let sortDir = $state<'asc' | 'desc'>(untrack(() => config.default_sort_dir ?? 'asc'));
  let filters = $state<any[]>(untrack(() => config.default_filters ?? []));
  let columns = $state<any[]>(untrack(() => config.columns ?? []));

  // ── Selected detail record ─────────────────────────────────────────────────
  let detailRecord = $state<any | null>(null);

  const pageSize = $derived(config.pageSize ?? 25);

  // ── View type meta ─────────────────────────────────────────────────────────
  const VIEW_DEFS: { type: ViewType; label: string; icon: any }[] = [
    { type: 'table',    label: 'Table',    icon: Table2 },
    { type: 'gallery',  label: 'Gallery',  icon: LayoutGrid },
    { type: 'kanban',   label: 'Kanban',   icon: Kanban },
    { type: 'calendar', label: 'Calendar', icon: Calendar },
    { type: 'chart',    label: 'Chart',    icon: BarChart2 },
  ];

  const visibleViews = $derived(VIEW_DEFS.filter(v => allowedViews.includes(v.type)));

  // ── Fetch trigger ──────────────────────────────────────────────────────────
  function fetch() {
    onFetch?.({ page, pageSize, sort, sortDir, filters, search });
  }

  function handleSort(field: string) {
    if (sort === field) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sort = field;
      sortDir = 'asc';
    }
    page = 1;
    fetch();
  }

  function handlePageChange(p: number) {
    page = p;
    fetch();
  }

  function handlePageSizeChange(s: number) {
    page = 1;
    fetch();
    onConfigChange?.({ ...config, pageSize: s });
  }

  function handleFiltersChange(f: any[]) {
    filters = f;
    page = 1;
    fetch();
  }

  function handleColumnsChange(cols: any[]) {
    columns = cols;
    onConfigChange?.({ ...config, columns: cols });
  }

  function handleRowClick(row: any) {
    detailRecord = row;
    onRowClick?.(row);
  }

  function handleSearch(e: Event) {
    search = (e.target as HTMLInputElement).value;
    page = 1;
    fetch();
  }
</script>

<div class="flex flex-col h-full gap-0">
  <!-- ── Toolbar ── -->
  <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300 shrink-0 flex-wrap">
    <!-- View switcher -->
    {#if visibleViews.length > 1}
      <div class="join">
        {#each visibleViews as v}
          <button
            class="join-item btn btn-xs gap-1"
            class:btn-primary={activeView === v.type}
            class:btn-ghost={activeView !== v.type}
            onclick={() => { activeView = v.type; detailRecord = null; }}
            title={v.label}
          >
            <v.icon size={13}/>
            <span class="hidden sm:inline">{v.label}</span>
          </button>
        {/each}
      </div>
      <div class="divider divider-horizontal mx-0 h-5 self-center"></div>
    {/if}

    <!-- Search -->
    <label class="input input-xs input-bordered flex items-center gap-1 w-48">
      <Search size={12} class="text-base-content/40 shrink-0"/>
      <input type="text" placeholder="Search…" value={search} oninput={handleSearch} class="grow min-w-0"/>
      {#if search}
        <button onclick={() => { search = ''; fetch(); }}><X size={10}/></button>
      {/if}
    </label>

    <div class="flex gap-1 ml-auto">
      <!-- Filters toggle -->
      <button
        class="btn btn-xs gap-1"
        class:btn-primary={showFilters}
        class:btn-ghost={!showFilters}
        onclick={() => { showFilters = !showFilters; showColumns = false; }}
      >
        <SlidersHorizontal size={13}/>
        {#if filters.length > 0}
          <span class="badge badge-xs badge-primary">{filters.length}</span>
        {/if}
      </button>

      <!-- Columns toggle (table only) -->
      {#if activeView === 'table'}
        <button
          class="btn btn-xs gap-1"
          class:btn-primary={showColumns}
          class:btn-ghost={!showColumns}
          onclick={() => { showColumns = !showColumns; showFilters = false; }}
        >
          <Columns3 size={13}/>
        </button>
      {/if}

      <!-- Stats toggle -->
      <button
        class="btn btn-xs gap-1"
        class:btn-primary={showStats}
        class:btn-ghost={!showStats}
        onclick={() => showStats = !showStats}
        title="Stats"
      >
        <List size={13}/>
      </button>
    </div>
  </div>

  <!-- ── Panels (filters / columns / stats) ── -->
  {#if showFilters}
    <div class="px-4 py-3 border-b border-base-300 bg-base-100 shrink-0">
      <FilterBar {fields} {filters} onChange={handleFiltersChange}/>
    </div>
  {/if}

  {#if showColumns && activeView === 'table'}
    <div class="px-4 py-3 border-b border-base-300 bg-base-100 shrink-0 max-h-64 overflow-y-auto">
      <ColumnManager {fields} {columns} onChange={handleColumnsChange}/>
    </div>
  {/if}

  <!-- ── Main area ── -->
  <div class="flex flex-1 min-h-0 gap-0">
    <!-- View content -->
    <div class="flex-1 p-4 overflow-auto">
      {#if activeView === 'table'}
        <TableView
          {collection}
          {config}
          {fields}
          {data}
          {total}
          {loading}
          {page}
          {sort}
          {sortDir}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          onSort={handleSort}
          onRowClick={handleRowClick}
          {onCreate}
          onDelete={onDelete}
        />

      {:else if activeView === 'gallery'}
        <!-- GalleryView placeholder -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {#if loading}
            {#each Array(8) as _}
              <div class="skeleton h-40 rounded-xl"></div>
            {/each}
          {:else if data.length === 0}
            <p class="col-span-full text-center py-16 text-base-content/40 text-sm">No records found</p>
          {:else}
            {#each data as row (row.id)}
              {@const titleField = fields.find(f => ['name','title','label'].includes(f.name))}
              {@const imgField = fields.find(f => f.type === 'image' || f.type === 'url')}
              <button
                class="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer text-left overflow-hidden"
                onclick={() => handleRowClick(row)}
              >
                {#if imgField && row[imgField.name]}
                  <figure class="h-28 overflow-hidden">
                    <img src={row[imgField.name]} alt="" class="w-full h-full object-cover"/>
                  </figure>
                {:else}
                  <div class="h-28 bg-base-300 flex items-center justify-center text-base-content/20 text-4xl font-bold">
                    {String(row[titleField?.name] ?? row.id ?? '?').charAt(0).toUpperCase()}
                  </div>
                {/if}
                <div class="card-body p-3">
                  <p class="font-medium text-sm truncate">{row[titleField?.name] ?? row.id}</p>
                  {#each fields.filter(f => !f.is_system && f.name !== titleField?.name && f.name !== imgField?.name).slice(0, 2) as f}
                    <p class="text-xs text-base-content/50 truncate">{row[f.name] ?? '—'}</p>
                  {/each}
                </div>
              </button>
            {/each}
          {/if}
        </div>

      {:else if activeView === 'kanban'}
        <!-- KanbanView placeholder -->
        {@const groupField = fields.find(f => f.type === 'select' || f.name === (config.kanban_group_by ?? 'status'))}
        {@const groups = groupField ? [...new Set(data.map(r => r[groupField.name] ?? 'Uncategorized'))] : ['All']}
        <div class="flex gap-4 h-full overflow-x-auto pb-2">
          {#if loading}
            {#each Array(3) as _}
              <div class="w-64 shrink-0 flex flex-col gap-2">
                <div class="skeleton h-6 w-32 rounded"></div>
                {#each Array(3) as _}<div class="skeleton h-20 rounded-xl"></div>{/each}
              </div>
            {/each}
          {:else}
            {#each groups as group}
              {@const cards = data.filter(r => (r[groupField?.name ?? ''] ?? 'Uncategorized') === group || (!groupField && group === 'All'))}
              <div class="w-64 shrink-0 flex flex-col gap-2">
                <div class="flex items-center gap-2 px-1">
                  <span class="font-medium text-sm capitalize">{group}</span>
                  <span class="badge badge-sm">{cards.length}</span>
                </div>
                <div class="flex flex-col gap-2 overflow-y-auto">
                  {#each cards as row (row.id)}
                    {@const titleField = fields.find(f => ['name','title','label'].includes(f.name))}
                    <button
                      class="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer text-left p-3"
                      onclick={() => handleRowClick(row)}
                    >
                      <p class="font-medium text-sm">{row[titleField?.name] ?? row.id}</p>
                      {#each fields.filter(f => !f.is_system && f.name !== titleField?.name && f.name !== groupField?.name).slice(0, 2) as f}
                        <p class="text-xs text-base-content/50 truncate mt-0.5">{row[f.name] ?? '—'}</p>
                      {/each}
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
          {/if}
        </div>

      {:else if activeView === 'calendar'}
        <!-- CalendarView placeholder -->
        {@const dateField = fields.find(f => (f.type === 'date' || f.type === 'datetime') && (f.name === (config.calendar_date_field ?? 'date') || f.name.includes('date') || f.name.includes('at')))}
        {@const today = new Date()}
        {@const year = today.getFullYear()}
        {@const month = today.getMonth()}
        {@const firstDay = new Date(year, month, 1).getDay()}
        {@const daysInMonth = new Date(year, month + 1, 0).getDate()}
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <span class="font-medium">{today.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
          </div>
          <div class="grid grid-cols-7 gap-1 text-xs text-center text-base-content/50 font-medium">
            {#each ['Su','Mo','Tu','We','Th','Fr','Sa'] as d}<div>{d}</div>{/each}
          </div>
          <div class="grid grid-cols-7 gap-1">
            {#each Array(firstDay) as _}<div></div>{/each}
            {#each Array(daysInMonth) as _, idx}
              {@const day = idx + 1}
              {@const dayDate = new Date(year, month, day).toDateString()}
              {@const dayRecords = dateField ? data.filter(r => r[dateField.name] && new Date(r[dateField.name]).toDateString() === dayDate) : []}
              <div class="min-h-16 rounded-lg border border-base-300 p-1 text-xs {day === today.getDate() ? 'bg-primary/10' : ''}">
                <span class="font-medium" class:text-primary={day === today.getDate()}>{day}</span>
                {#each dayRecords.slice(0, 3) as row}
                  {@const titleField = fields.find(f => ['name','title','label'].includes(f.name))}
                  <button class="w-full text-left truncate rounded px-1 bg-primary/20 text-primary hover:bg-primary/30 mt-0.5"
                    onclick={() => handleRowClick(row)}>
                    {row[titleField?.name] ?? '•'}
                  </button>
                {/each}
                {#if dayRecords.length > 3}
                  <span class="text-base-content/40">+{dayRecords.length - 3}</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>

      {:else if activeView === 'chart'}
        <!-- ChartView placeholder — simple bar chart using inline SVG -->
        {@const numField = fields.find(f => f.type === 'number' || f.type === 'integer')}
        {@const labelField = fields.find(f => ['name','title','label','category'].includes(f.name))}
        {@const chartData = data.slice(0, 20).map(r => ({
          label: String(r[labelField?.name] ?? r.id ?? '').slice(0, 12),
          value: Number(r[numField?.name] ?? 0),
        }))}
        {@const maxVal = Math.max(...chartData.map(d => d.value), 1)}
        {#if loading}
          <div class="skeleton h-64 rounded-xl"></div>
        {:else if !numField}
          <div class="flex items-center justify-center h-48 text-base-content/40 text-sm">
            No numeric field found. Configure <code class="mx-1 font-mono bg-base-200 px-1 rounded">chart_value_field</code> in view config.
          </div>
        {:else}
          <div class="flex flex-col gap-3">
            <p class="text-sm text-base-content/60">{numField.display_name ?? numField.name} by {labelField?.display_name ?? labelField?.name ?? 'record'}</p>
            <div class="flex items-end gap-2 h-48 border-b border-l border-base-300 px-2 pb-1">
              {#each chartData as bar}
                <div class="flex flex-col items-center gap-1 flex-1 min-w-0">
                  <span class="text-xs text-base-content/50 truncate w-full text-center"
                    title={String(bar.value)}>{bar.value}</span>
                  <div
                    class="w-full bg-primary rounded-t transition-all hover:bg-primary/80"
                    style="height: {(bar.value / maxVal) * 160}px"
                    title="{bar.label}: {bar.value}"
                  ></div>
                  <span class="text-xs text-base-content/50 truncate w-full text-center">{bar.label}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <!-- ── Detail panel (slide-in) ── -->
    {#if detailRecord}
      <div class="w-80 shrink-0 border-l border-base-300 bg-base-100 overflow-y-auto">
        <DetailView
          record={detailRecord}
          {fields}
          {config}
          onEdit={() => onEdit?.(detailRecord)}
          onClose={() => detailRecord = null}
        />
      </div>
    {/if}

    <!-- ── Stats sidebar ── -->
    {#if showStats && collection}
      <div class="w-64 shrink-0 border-l border-base-300 bg-base-100 p-4 overflow-y-auto">
        <StatsView {collection}/>
      </div>
    {/if}
  </div>
</div>
