<script lang="ts">
  import { base } from '$app/paths';
  import { Columns, GitFork, Sparkles, Code, LayoutGrid, Database, FileText } from '@lucide/svelte';

  type Props = {
    collectionName: string;
    active: 'data' | 'schema' | 'fields' | 'relations' | 'ai' | 'code' | 'views';
  };

  let { collectionName, active }: Props = $props();

  const tabs = $derived([
    { id: 'data' as const,      label: 'Data',      icon: Database, href: `${base}/collections/${collectionName}` },
    { id: 'schema' as const,    label: 'Schema',    icon: FileText, href: `${base}/collections/${collectionName}?tab=schema` },
    { id: 'fields' as const,    label: 'Fields',    icon: Columns,  href: `${base}/collections/${collectionName}/fields` },
    { id: 'relations' as const, label: 'Relations', icon: GitFork,  href: `${base}/collections/${collectionName}/relations` },
    { id: 'ai' as const,        label: 'AI Search', icon: Sparkles, href: `${base}/collections/${collectionName}?tab=ai` },
    { id: 'code' as const,      label: 'Code',      icon: Code,     href: `${base}/collections/${collectionName}?tab=code` },
    { id: 'views' as const,     label: 'Views',     icon: LayoutGrid, href: `${base}/collections/${collectionName}?tab=views` },
  ]);
</script>

<div class="border-b border-base-200 mb-4">
  <div class="flex gap-0">
    {#each tabs as tab}
      <a
        href={tab.href}
        data-sveltekit-noscroll
        class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors gap-1 flex items-center
               {active === tab.id
                 ? 'border-primary text-primary'
                 : 'border-transparent text-base-content/50 hover:text-base-content'}"
      >
        <tab.icon size={13} />{tab.label}
      </a>
    {/each}
  </div>
</div>
