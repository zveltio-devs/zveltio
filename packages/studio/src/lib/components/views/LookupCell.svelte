<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { ExternalLink } from '@lucide/svelte';

  interface Props {
    value?: any;           // foreign key value (UUID or int)
    collection?: string;   // target collection name
    displayField?: string; // which field to show (default: name/title/label)
    linkTo?: string;       // optional href template e.g. "/admin/collections/users/{{id}}"
  }

  let { value = null, collection = '', displayField = '', linkTo = '' }: Props = $props();

  let label = $state<string | null>(null);
  let loading = $state(false);

  onMount(() => {
    if (value && collection) load();
  });

  async function load() {
    loading = true;
    try {
      const res = await api.get<{ data: Record<string, any> }>(`/api/data/${collection}/${value}?fields=id,name,title,label,${displayField}`);
      const record = res?.data ?? res;
      if (record) {
        label = record[displayField] ?? record.name ?? record.title ?? record.label ?? String(value);
      }
    } catch {
      label = String(value);
    } finally {
      loading = false;
    }
  }

  const href = $derived(
    linkTo
      ? linkTo.replace('{{id}}', String(value ?? '')).replace('{{collection}}', collection)
      : null
  );
</script>

{#if value == null}
  <span class="text-base-content/30 text-sm">—</span>
{:else if loading}
  <span class="skeleton h-4 w-20 rounded inline-block"/>
{:else}
  <span class="flex items-center gap-1 text-sm">
    {#if href}
      <a {href} class="link link-primary truncate max-w-xs" title={label ?? String(value)}>
        {label ?? value}
      </a>
      <a {href} target="_blank" rel="noopener noreferrer" class="text-base-content/30 hover:text-primary shrink-0">
        <ExternalLink size={11}/>
      </a>
    {:else}
      <span class="truncate max-w-xs" title={label ?? String(value)}>{label ?? value}</span>
    {/if}
  </span>
{/if}
