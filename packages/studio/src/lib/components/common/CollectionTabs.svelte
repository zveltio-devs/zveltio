<script lang="ts">
  import { base } from '$app/paths';
  import { Database, Layers, Code, Settings } from '@lucide/svelte';

  type Props = {
    collectionName: string;
    active: 'data' | 'schema' | 'api' | 'settings';
  };

  let { collectionName, active }: Props = $props();
</script>

<div class="border-b border-base-200 mb-6">
  <div class="flex gap-0">
    {#each [
      { id: 'data',     label: 'Data',     Icon: Database,  href: `${base}/collections/${collectionName}` },
      { id: 'schema',   label: 'Schema',   Icon: Layers,    href: `${base}/collections/${collectionName}?tab=schema` },
      { id: 'api',      label: 'API',      Icon: Code,      href: `${base}/collections/${collectionName}?tab=api` },
      { id: 'settings', label: 'Settings', Icon: Settings,  href: `${base}/collections/${collectionName}?tab=settings` },
    ] as tab}
      <a
        href={tab.href}
        data-sveltekit-noscroll
        class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors gap-1.5 flex items-center
               {active === tab.id
                 ? 'border-primary text-primary'
                 : 'border-transparent text-base-content/50 hover:text-base-content'}"
      >
        <tab.Icon size={13} />{tab.label}
      </a>
    {/each}
  </div>
</div>
