<script lang="ts">
import { Plus, Search } from '@lucide/svelte';
import PageHeader from '@zveltio/ui/PageHeader.svelte';
import Pagination from '@zveltio/ui/Pagination.svelte';
import Table from '@zveltio/ui/Table.svelte';
import { m } from '#lib/i18n.svelte.js';
import { cell as show, isSortable } from '#lib/workspace/fields.js';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

type Row = PageData['records'][number];

const base = $derived(`/app/data/${encodeURIComponent(data.collection.name)}`);
const link = (params: { page?: number; sort?: string; order?: string }) => {
  const qs = new URLSearchParams();
  if (data.search) qs.set('q', data.search);
  const sort = params.sort ?? data.sort?.key;
  if (sort) {
    qs.set('sort', sort);
    qs.set('order', params.order ?? data.sort?.dir ?? 'desc');
  }
  qs.set('page', String(params.page ?? 1));
  return `${base}?${qs}`;
};

// The first fields are the list's columns; the form shows all of them. A
// collection whose fields are all hidden from this user still lists its ids.
// A column's link orders by it, flipping the direction when it already does.
const columns = $derived(
  (data.collection.fields.length > 0
    ? data.collection.fields.slice(0, 6)
    : [{ name: 'id', label: 'id', type: 'uuid' }]
  ).map((f) => ({
    key: f.name,
    label: f.label ?? f.name,
    sortHref: isSortable(f)
      ? link({
          sort: f.name,
          order: data.sort?.key === f.name && data.sort.dir === 'asc' ? 'desc' : 'asc',
        })
      : undefined,
  })),
);
// `pages` is absent (count skipped) or -1 (rows gated in memory) when the total
// is unknown: then a full page is the only sign another one follows.
const known = $derived((data.pagination.pages ?? -1) >= 0);
const hasNext = $derived(
  known
    ? data.pagination.page < (data.pagination.pages ?? 0)
    : data.records.length >= data.pagination.limit,
);
</script>

<svelte:head><title>{data.collection.display_name ?? data.collection.name}</title></svelte:head>

<div class="space-y-4">
  <PageHeader title={data.collection.display_name ?? data.collection.name}>
    {#snippet actions()}
      <form method="GET" action={base} class="join">
        {#if data.sort}
          <input type="hidden" name="sort" value={data.sort.key} />
          <input type="hidden" name="order" value={data.sort.dir} />
        {/if}
        <input name="q" value={data.search} placeholder={m['data.search']()} class="input input-sm join-item" />
        <button class="btn btn-sm join-item" aria-label={m['data.search']()}><Search size={16} /></button>
      </form>
      <a href="{base}/new" class="btn btn-primary btn-sm gap-1"><Plus size={16} />{m['data.new']()}</a>
    {/snippet}
  </PageHeader>

  <Table {columns} rows={data.records} rowKey={(r: Row) => r.id} sort={data.sort} empty={m['data.no_records']()}>
    {#snippet cell(r: Row, c, i)}
      {#if i === 0}
        <a class="link link-hover" href="{base}/{encodeURIComponent(r.id)}">{show(r[c.key]) || r.id}</a>
      {:else}
        {show(r[c.key])}
      {/if}
    {/snippet}
  </Table>

  <Pagination
    page={data.pagination.page}
    pages={known ? data.pagination.pages : null}
    {hasNext}
    href={(page) => link({ page })}
    previousLabel={m['data.previous_page']()}
    nextLabel={m['data.next_page']()}
  />
</div>
