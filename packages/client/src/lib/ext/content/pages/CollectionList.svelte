<script lang="ts">
  /**
   * The data block, drawn.
   *
   * `collection_list` was resolved by the server and rendered by nobody. The
   * engine looked up the collection, checked the caller's permission, applied
   * row policies and the column mask, and handed back the rows in
   * `content._data` — where they sat, because every public host answered
   * "Unsupported block: collection_list". Measured, not guessed: a page built
   * from the twelve library blocks came out of the reference renderer with ten
   * placeholders and one `<hr>`.
   *
   * Four layouts, matching `view_type`. `table` and `list` are the two a saved
   * view most often was; `card` and `calendar` are what portals' own renderers
   * drew, and they came across in the merge.
   *
   * This component never CHOOSES a query. It receives what the server decided
   * the caller may see — `_data` when allowed, `_error` when not — and paging
   * asks the server for the next window of the SAME block, by id, through a
   * route that reads the block back out of the stored page. The request carries
   * an offset and nothing else, so there is still exactly one place that decides
   * who may read what. A renderer that composed its own query would be a second
   * authorisation path, which is the shape that produced the leak this area was
   * repaired for.
   */

  // biome-ignore lint/suspicious/noExplicitAny: rows are untyped collection data
  import type { Snippet } from 'svelte';

  type Row = Record<string, any>;

  let {
    collection = '',
    view_type = 'list',
    title = '',
    fields = [] as unknown,
    display_fields = '',
    _data = [] as Row[],
    _error = '',
    _offset = 0,
    _limit = 0,
    _has_more = false,
    /**
     * Where to ask for the next window, given by the host that rendered the
     * page: `/…/blocks/<id>/rows`. Absent means no paging controls — a consumer
     * embedding blocks without a route to page against gets the first window and
     * no buttons, which is what it had before.
     */
    rowsUrl = '',
    /**
     * How to draw one record when `view_type` is `template`.
     *
     * Passed in by `BlockRenderer` rather than imported, because drawing a
     * record's template means drawing BLOCKS — and this component importing the
     * block renderer that imports it would be a cycle. The snippet keeps the
     * paging controls and the refusal handling here, in one place, whichever
     * layout is chosen.
     */
    // A Snippet, not a plain function. `{@render …}` accepts only a snippet —
    // declared as `(row, index) => unknown` this prop failed to typecheck at the
    // render site, and left the caller's `{#snippet item(row, i)}` parameters
    // implicitly `any` because there was no snippet type to infer them from.
    renderItem = undefined as Snippet<[Row, number]> | undefined,
  } = $props();

  /**
   * What the server sent with the page is the source until the visitor pages;
   * after that, the fetched window is. Derived rather than copied into state, so
   * a re-render with fresh props is not shadowed by a stale snapshot — the shape
   * `$state(_data)` would silently give, capturing only the first value.
   */
  let paged = $state<{ rows: Row[]; offset: number; hasMore: boolean } | null>(null);
  let paging = $state(false);
  let pageError = $state('');

  const rows = $derived(paged?.rows ?? _data);
  const offset = $derived(paged?.offset ?? _offset);
  const hasMore = $derived(paged?.hasMore ?? _has_more);

  const pageSize = $derived(_limit || rows.length || 20);

  async function goto(nextOffset: number) {
    if (!rowsUrl || paging) return;
    paging = true;
    pageError = '';
    try {
      const url = `${rowsUrl}${rowsUrl.includes('?') ? '&' : '?'}offset=${Math.max(0, nextOffset)}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // A refusal is reported, not rendered as an empty page.
      if (json.error) { pageError = json.error; return; }
      paged = {
        rows: json.data ?? [],
        offset: json.offset ?? nextOffset,
        hasMore: json.has_more === true,
      };
    } catch {
      pageError = 'Could not load more rows.';
    } finally {
      paging = false;
    }
  }

  /** Bookkeeping columns nobody asked to see when no field list was given. */
  const NOISE = new Set([
    'id', 'tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at',
    'search_vector', 'search_text', 'deleted_at',
  ]);

  /**
   * Which columns to draw, in order.
   *
   * The author's list wins when there is one — and it arrives in two shapes,
   * because a migrated view wrote `fields: [{field}]` while the CMS editor
   * wrote `display_fields: "a, b"`. Both are read, the same way the server
   * reads them, so the page shows the columns it was configured with rather
   * than whatever the first row happens to carry.
   */
  const columns = $derived.by(() => {
    const named: string[] = [];
    if (Array.isArray(fields)) {
      for (const f of fields) {
        if (typeof f === 'string' && f.trim()) named.push(f.trim());
        else if (f && typeof f === 'object') {
          const o = f as Record<string, unknown>;
          if (typeof o.field === 'string') named.push(o.field);
          else if (typeof o.name === 'string') named.push(o.name);
        }
      }
    }
    if (typeof display_fields === 'string') {
      for (const s of display_fields.split(',')) {
        const t = s.trim();
        if (t) named.push(t);
      }
    }
    if (named.length > 0) return [...new Set(named)];
    const first = rows[0];
    if (!first) return [];
    return Object.keys(first).filter((k) => !NOISE.has(k));
  });

  /** `first_name` → `First name`. No label config exists yet; this is the guess. */
  function humanize(key: string): string {
    const s = key.replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * A cell, as text.
   *
   * Dates get the visitor's locale, booleans a tick, objects and arrays a
   * compact JSON so a jsonb column does not render as `[object Object]`.
   * Deliberately conservative: there is no per-column format setting to honour
   * yet, so this guesses from the value and never from a configuration that
   * does not exist.
   */
  function cell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? '✓' : '—';
    if (value instanceof Date) return value.toLocaleDateString();
    if (typeof value === 'string') {
      // ISO timestamp → locale date. Anything else is left exactly as stored.
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toLocaleString();
      }
      return value;
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /** The field a card leads with, when the author named none. */
  const titleField = $derived(
    columns.find((c) => /name|title|label|subject/i.test(c)) ?? columns[0] ?? '',
  );

  /** The date a calendar groups by. */
  const dateField = $derived(
    columns.find((c) => /date|_at$|start|due/i.test(c)) ?? 'created_at',
  );

  const calendarGroups = $derived.by(() => {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const raw = row[dateField];
      if (!raw) continue;
      const d = new Date(raw as string);
      if (Number.isNaN(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  });
</script>

<section class="zv-collection-list">
  {#if title}
    <h3 class="text-lg font-semibold mb-3">{title}</h3>
  {/if}

  {#if _error}
    <!--
      The server's refusal, shown rather than swallowed. An empty table reads as
      "no data", which is a different and misleading statement from "this is not
      yours to see" or "this collection is not published on this site".
    -->
    <p class="text-sm opacity-60 border border-dashed rounded-lg p-4">{_error}</p>

  {:else if rows.length === 0}
    <p class="text-sm opacity-50 border border-dashed rounded-lg p-4">
      No records{collection ? ` in ${collection}` : ''}.
    </p>

  {:else if view_type === 'template' && renderItem}
    <!--
      One block, designed once, drawn once per record. The grid is the same
      twelve columns the rest of the page uses, so an item's `col_span` decides
      how many fit on a row.
    -->
    <div class="grid grid-cols-12 gap-4 items-start">
      {#each rows as row, i (i)}
        {@render renderItem(row, i)}
      {/each}
    </div>

  {:else if view_type === 'table'}
    <div class="overflow-x-auto rounded-lg border border-base-300">
      <table class="table table-sm w-full">
        <thead>
          <tr>{#each columns as c (c)}<th>{humanize(c)}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each rows as row, i (i)}
            <tr>{#each columns as c (c)}<td>{cell(row[c])}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>

  {:else if view_type === 'card'}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each rows as row, i (i)}
        <article class="rounded-lg border border-base-300 p-4">
          {#if titleField}
            <h4 class="font-semibold mb-2">{cell(row[titleField])}</h4>
          {/if}
          <dl class="text-sm space-y-0.5">
            {#each columns.filter((c) => c !== titleField) as c (c)}
              <div class="flex gap-2">
                <dt class="opacity-50 shrink-0">{humanize(c)}</dt>
                <dd class="truncate">{cell(row[c])}</dd>
              </div>
            {/each}
          </dl>
        </article>
      {/each}
    </div>

  {:else if view_type === 'calendar'}
    <div class="space-y-3">
      {#each calendarGroups as [day, rows] (day)}
        <div class="rounded-lg border border-base-300 overflow-hidden">
          <div class="px-3 py-1.5 bg-base-200 text-xs font-semibold">
            {new Date(day).toLocaleDateString(undefined, {
              weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
            })}
          </div>
          <ul class="divide-y divide-base-300">
            {#each rows as row, i (i)}
              <li class="px-3 py-2 text-sm">{cell(row[titleField])}</li>
            {/each}
          </ul>
        </div>
      {/each}
      {#if calendarGroups.length === 0}
        <p class="text-sm opacity-50 border border-dashed rounded-lg p-4">
          No dates to place — “{humanize(dateField)}” is empty on every record.
        </p>
      {/if}
    </div>

  {:else}
    <!-- list -->
    <ul class="divide-y divide-base-300 rounded-lg border border-base-300">
      {#each rows as row, i (i)}
        <li class="px-4 py-2.5">
          <p class="font-medium">{cell(row[titleField])}</p>
          {#if columns.length > 1}
            <p class="text-sm opacity-60 truncate">
              {columns.filter((c) => c !== titleField).map((c) => cell(row[c])).filter(Boolean).join(' · ')}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <!--
    Paging. Shown only when the host gave a `rowsUrl` and there is more than one
    window — a block whose whole result fits in one page has no controls, which
    is most of them.
  -->
  {#if rowsUrl && !_error && (hasMore || offset > 0)}
    <nav class="flex items-center gap-2 mt-3 text-sm" aria-label="Pagination">
      <button class="btn btn-sm btn-ghost" disabled={offset === 0 || paging}
        onclick={() => goto(offset - pageSize)}>← Previous</button>
      <span class="opacity-60">
        {offset + 1}–{offset + rows.length}
      </span>
      <button class="btn btn-sm btn-ghost" disabled={!hasMore || paging}
        onclick={() => goto(offset + pageSize)}>Next →</button>
      {#if paging}<span class="opacity-50">…</span>{/if}
    </nav>
  {/if}
  {#if pageError}
    <p class="text-sm text-warning mt-2">{pageError}</p>
  {/if}
</section>
