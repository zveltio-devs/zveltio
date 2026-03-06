<script lang="ts">
  import { Code, Copy, Check } from '@lucide/svelte';

  interface Props {
    collectionName: string;
    fields?: Array<{ name: string; type: string }>;
  }

  let { collectionName, fields = [] }: Props = $props();
  let copied = $state(false);
  let activeTab = $state<'svelte' | 'sdk' | 'curl'>('svelte');

  const snippets = $derived({
    svelte: `<script lang="ts">
  import { useCollection } from '$stores/collection.svelte';

  const ${collectionName} = useCollection('${collectionName}');
<\/script>

{#if ${collectionName}.loading}
  <span class="loading loading-spinner"></span>
{:else}
  {#each ${collectionName}.data as item}
    <div>{item.id}${fields.length > 0 ? ` — {item.${fields[0].name}}` : ''}</div>
  {/each}
{/if}

<!-- Create -->
<button onclick={() => ${collectionName}.create({ ${fields.slice(0, 2).map((f) => `${f.name}: '...'`).join(', ')} })}>
  Add
</button>`,

    sdk: `import { ZveltioClient } from '@zveltio/sdk';

const client = new ZveltioClient({ url: 'http://localhost:3000' });

// List
const { records } = await client.collection('${collectionName}').list();

// Create
await client.collection('${collectionName}').create({
  ${fields.slice(0, 3).map((f) => `${f.name}: '...'`).join(',\n  ')}
});

// Update
await client.collection('${collectionName}').update('RECORD_ID', { ... });

// Delete
await client.collection('${collectionName}').delete('RECORD_ID');`,

    curl: `# List records
curl http://localhost:3000/api/data/${collectionName} \\
  -H "Cookie: session=YOUR_SESSION"

# Create record
curl -X POST http://localhost:3000/api/data/${collectionName} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: zvk_YOUR_KEY" \\
  -d '{ ${fields.slice(0, 2).map((f) => `"${f.name}": "..."`).join(', ')} }'

# Update record
curl -X PATCH http://localhost:3000/api/data/${collectionName}/RECORD_ID \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: zvk_YOUR_KEY" \\
  -d '{ "${fields[0]?.name || 'field'}": "new_value" }'`,
  });

  async function copyToClipboard(text: string) {
    await navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }
</script>

<div class="card bg-base-200">
  <div class="card-body p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-semibold flex items-center gap-2">
        <Code size={16} />
        Code Snippets
      </h3>
      <div class="join">
        {#each (['svelte', 'sdk', 'curl'] as const) as tab}
          <button
            class="join-item btn btn-xs"
            class:btn-active={activeTab === tab}
            onclick={() => activeTab = tab}
          >{tab === 'svelte' ? 'Svelte 5' : tab === 'sdk' ? 'SDK' : 'cURL'}</button>
        {/each}
      </div>
    </div>

    <div class="relative">
      <pre class="bg-base-300 p-3 rounded-lg text-xs overflow-x-auto max-h-64"><code>{snippets[activeTab]}</code></pre>
      <button
        class="btn btn-ghost btn-xs absolute top-2 right-2"
        onclick={() => copyToClipboard(snippets[activeTab])}
      >
        {#if copied}<Check size={14} class="text-success" />{:else}<Copy size={14} />{/if}
      </button>
    </div>
  </div>
</div>
