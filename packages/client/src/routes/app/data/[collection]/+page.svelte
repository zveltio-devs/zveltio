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
  base="/app/data/{encodeURIComponent(data.collection.name)}"
  labels={{
    search: m['data.search'](),
    new: m['data.new'](),
    empty: m['data.no_records'](),
    previous: m['data.previous_page'](),
    next: m['data.next_page'](),
  }}
/>
