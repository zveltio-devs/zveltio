<script lang="ts">
import { Plus, Search } from '@lucide/svelte';
import { m } from '#lib/i18n.svelte.js';
import { cell } from '#lib/workspace/fields.js';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

// The first fields are the list's columns; the form shows all of them. A
// collection whose fields are all hidden from this user still lists its ids.
const columns = $derived(
  data.collection.fields.length > 0
    ? data.collection.fields.slice(0, 6)
    : [{ name: 'id', label: 'id' }],
);
const base = $derived(`/app/data/${encodeURIComponent(data.collection.name)}`);
// `pages` is absent (count skipped) or -1 (rows gated in memory) when the total
// is unknown: then a full page is the only sign another one follows.
const known = $derived((data.pagination.pages ?? -1) >= 0);
const hasNext = $derived(
  known
    ? data.pagination.page < (data.pagination.pages ?? 0)
    : data.records.length >= data.pagination.limit,
);
const link = (page: number) =>
  `${base}?${new URLSearchParams({ page: String(page), ...(data.search ? { q: data.search } : {}) })}`;
</script>

<svelte:head><title>{data.collection.display_name ?? data.collection.name}</title></svelte:head>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-3">
    <h1 class="text-2xl font-bold flex-1">{data.collection.display_name ?? data.collection.name}</h1>
    <form method="GET" action={base} class="join">
      <input name="q" value={data.search} placeholder={m['data.search']()} class="input input-sm join-item" />
      <button class="btn btn-sm join-item" aria-label={m['data.search']()}><Search size={16} /></button>
    </form>
    <a href="{base}/new" class="btn btn-primary btn-sm gap-1"><Plus size={16} />{m['data.new']()}</a>
  </div>

  <div class="overflow-x-auto bg-base-100 rounded-box shadow">
    <table class="table table-sm">
      <thead>
        <tr>
          {#each columns as f (f.name)}<th>{f.label ?? f.name}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each data.records as r (r.id)}
          <tr class="hover:bg-base-200">
            {#each columns as f, i (f.name)}
              <td>
                {#if i === 0}
                  <a class="link link-hover" href="{base}/{encodeURIComponent(r.id)}">{cell(r[f.name]) || r.id}</a>
                {:else}
                  {cell(r[f.name])}
                {/if}
              </td>
            {/each}
          </tr>
        {:else}
          <tr><td colspan={columns.length || 1} class="text-center text-base-content/60 py-8">{m['data.no_records']()}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if data.pagination.page > 1 || hasNext}
    <div class="join">
      <a class="join-item btn btn-sm" class:btn-disabled={data.pagination.page <= 1} href={link(data.pagination.page - 1)}>«</a>
      <span class="join-item btn btn-sm btn-ghost">
        {data.pagination.page}{known ? ` / ${data.pagination.pages}` : ''}
      </span>
      <a class="join-item btn btn-sm" class:btn-disabled={!hasNext} href={link(data.pagination.page + 1)}>»</a>
    </div>
  {/if}
</div>
