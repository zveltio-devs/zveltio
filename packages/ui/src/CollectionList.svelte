<script lang="ts">
/**
 * A page of any collection (`@zveltio/ui`, ADR 0007 item 3): search, a table
 * ordered through links, pagination. Navigation is plain links under `base`
 * (`?q=`, `?sort=&order=`, `?page=`); the host loads the page those name. The
 * kit has no catalogue: the host passes the words.
 */
import { Plus, Search } from '@lucide/svelte';
import type { CollectionMeta, CollectionRecord, CollectionSort } from './collection.js';
import { cell as show, isSortable } from './fields.js';
import PageHeader from './PageHeader.svelte';
import Pagination from './Pagination.svelte';
import Table from './Table.svelte';

let {
  collection,
  records,
  pagination,
  search = '',
  sort = null,
  base,
  labels,
}: {
  collection: CollectionMeta;
  records: CollectionRecord[];
  pagination: { page: number; limit: number; pages?: number };
  search?: string;
  sort?: CollectionSort | null;
  /** The list's own URL; a record is at `<base>/<id>`, a new one at `<base>/new`. */
  base: string;
  labels: { search: string; new: string; empty: string; previous: string; next: string };
} = $props();

const link = (params: { page?: number; sort?: string; order?: string }) => {
  const qs = new URLSearchParams();
  if (search) qs.set('q', search);
  const key = params.sort ?? sort?.key;
  if (key) {
    qs.set('sort', key);
    qs.set('order', params.order ?? sort?.dir ?? 'desc');
  }
  qs.set('page', String(params.page ?? 1));
  return `${base}?${qs}`;
};

// The first fields are the list's columns; the form shows all of them. A
// collection whose fields are all hidden from this user still lists its ids.
// A column's link orders by it, flipping the direction when it already does.
const columns = $derived(
  (collection.fields.length > 0
    ? collection.fields.slice(0, 6)
    : [{ name: 'id', label: 'id', type: 'uuid' }]
  ).map((f) => ({
    key: f.name,
    label: f.label ?? f.name,
    sortHref: isSortable(f)
      ? link({ sort: f.name, order: sort?.key === f.name && sort.dir === 'asc' ? 'desc' : 'asc' })
      : undefined,
  })),
);
// `pages` is absent (count skipped) or -1 (rows gated in memory) when the total
// is unknown: then a full page is the only sign another one follows.
const known = $derived((pagination.pages ?? -1) >= 0);
const hasNext = $derived(
  known ? pagination.page < (pagination.pages ?? 0) : records.length >= pagination.limit,
);
</script>

<div class="space-y-4">
  <PageHeader title={collection.display_name ?? collection.name}>
    {#snippet actions()}
      <form method="GET" action={base} class="join">
        {#if sort}
          <input type="hidden" name="sort" value={sort.key} />
          <input type="hidden" name="order" value={sort.dir} />
        {/if}
        <input name="q" value={search} placeholder={labels.search} class="input input-sm join-item" />
        <button class="btn btn-sm join-item" aria-label={labels.search}><Search size={16} /></button>
      </form>
      <a href="{base}/new" class="btn btn-primary btn-sm gap-1"><Plus size={16} />{labels.new}</a>
    {/snippet}
  </PageHeader>

  <Table {columns} rows={records} rowKey={(r: CollectionRecord) => r.id} {sort} empty={labels.empty}>
    {#snippet cell(r: CollectionRecord, c, i)}
      {#if i === 0}
        <a class="link link-hover" href="{base}/{encodeURIComponent(r.id)}">{show(r[c.key]) || r.id}</a>
      {:else}
        {show(r[c.key])}
      {/if}
    {/snippet}
  </Table>

  <Pagination
    page={pagination.page}
    pages={known ? pagination.pages : null}
    {hasNext}
    href={(page) => link({ page })}
    previousLabel={labels.previous}
    nextLabel={labels.next}
  />
</div>
