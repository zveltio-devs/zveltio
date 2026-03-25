<script lang="ts">
  import { ExternalLink, Copy, Mail, Phone, Globe } from '@lucide/svelte';

  interface Action {
    type: 'link' | 'copy' | 'email' | 'phone' | 'url';
    label?: string;
    template?: string; // e.g. "https://example.com/{{id}}"
  }

  interface Props {
    value?: any;
    row?: Record<string, any>;
    actions?: Action[];
  }

  let { value = null, row = {}, actions = [] }: Props = $props();

  function interpolate(tpl: string): string {
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(row[k] ?? value ?? ''));
  }

  function resolvedHref(action: Action): string {
    const base = action.template ?? String(value ?? '');
    const resolved = interpolate(base);
    if (action.type === 'email') return `mailto:${resolved}`;
    if (action.type === 'phone') return `tel:${resolved}`;
    return resolved;
  }

  async function copyValue(action: Action) {
    const text = action.template ? interpolate(action.template) : String(value ?? '');
    await navigator.clipboard.writeText(text).catch(() => {});
  }

  const defaultActions = $derived<Action[]>(() => {
    if (actions.length) return actions;
    if (!value) return [];
    const str = String(value);
    if (str.startsWith('http')) return [{ type: 'url', label: 'Open' }];
    if (str.includes('@')) return [{ type: 'email' }];
    return [{ type: 'copy' }];
  }());
</script>

<div class="flex items-center gap-1 flex-wrap">
  {#if value != null}
    <!-- Render primary value as text if not just buttons -->
    {#if defaultActions.every(a => a.type !== 'url' && a.type !== 'link')}
      <span class="text-sm truncate max-w-xs">{value}</span>
    {/if}

    {#each defaultActions as action}
      {#if action.type === 'copy'}
        <button class="btn btn-ghost btn-xs" onclick={() => copyValue(action)} title={action.label ?? 'Copy'}>
          <Copy size={12}/>
        </button>
      {:else if action.type === 'email'}
        <a href={resolvedHref(action)} class="btn btn-ghost btn-xs" title={action.label ?? 'Send email'}>
          <Mail size={12}/>
          {#if action.label}<span>{action.label}</span>{/if}
        </a>
      {:else if action.type === 'phone'}
        <a href={resolvedHref(action)} class="btn btn-ghost btn-xs" title={action.label ?? 'Call'}>
          <Phone size={12}/>
          {#if action.label}<span>{action.label}</span>{/if}
        </a>
      {:else if action.type === 'url' || action.type === 'link'}
        <a href={resolvedHref(action)} target="_blank" rel="noopener noreferrer"
           class="btn btn-ghost btn-xs gap-1 text-primary" title={action.label ?? 'Open'}>
          {#if action.type === 'url'}<Globe size={12}/>{:else}<ExternalLink size={12}/>{/if}
          {#if action.label}<span>{action.label}</span>{:else}<span class="max-w-32 truncate">{value}</span>{/if}
        </a>
      {/if}
    {/each}
  {:else}
    <span class="text-base-content/30 text-sm">—</span>
  {/if}
</div>
