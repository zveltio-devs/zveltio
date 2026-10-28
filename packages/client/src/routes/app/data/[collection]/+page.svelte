<script lang="ts">
import CollectionList from '@zveltio/ui/CollectionList.svelte';
import { m } from '#lib/i18n.svelte.js';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.collection.display_name ?? data.collection.name}</title></svelte:head>

<CollectionList
  collection={data.collection}
  records={data.records}
  pagination={data.pagination}
  search={data.search}
  sort={data.sort}
  filters={data.filters}
  base="/app/data/{encodeURIComponent(data.collection.name)}"
  labels={{
    search: m['data.search'](),
    new: m['data.new'](),
    empty: m['data.no_records'](),
    previous: m['data.previous_page'](),
    next: m['data.next_page'](),
    filter: {
      add: m['data.filter_add'](),
      remove: m['data.filter_remove'](),
      field: m['data.filter_field'](),
      op: m['data.filter_op'](),
      value: m['data.filter_value'](),
      yes: m['data.yes'](),
      no: m['data.no'](),
      ops: {
        contains: m['data.op_contains'](),
        eq: m['data.op_eq'](),
        neq: m['data.op_neq'](),
        starts_with: m['data.op_starts_with'](),
        gt: m['data.op_gt'](),
        gte: m['data.op_gte'](),
        lt: m['data.op_lt'](),
        lte: m['data.op_lte'](),
        is_null: m['data.op_is_null'](),
        is_not_null: m['data.op_is_not_null'](),
      },
    },
  }}
/>
