<script lang="ts">
  /**
   * Empty state — refreshed for 2026.
   *
   * Three rendering modes, picked in this order:
   *   1. `illustration` prop set → abstract SVG via <EmptyIllustration>.
   *   2. `icon` prop set        → Lucide icon in soft-tinted circle.
   *   3. Fallback                → built-in folder-plus SVG.
   *
   * Microcopy convention: lead with a positive next-step (not "Nothing
   * here yet"), the description should suggest one concrete next action.
   * The action button stays visually consistent with PageHeader's
   * primary action.
   */
  import type { Component, Snippet } from 'svelte';
  import EmptyIllustration from './EmptyIllustration.svelte';

  type IllustrationVariant = 'list' | 'table' | 'cloud' | 'target' | 'spark';

  let {
    title = 'Nothing here yet',
    description = 'Get started by creating your first item.',
    icon: Icon,
    illustration,
    illustrationColor = 'text-primary',
    actionLabel,
    actionHref,
    onaction,
    action,
    className,
  }: {
    title?: string;
    description?: string;
    icon?: Component<any>;
    /** Abstract SVG variant (mutually exclusive with `icon`). */
    illustration?: IllustrationVariant;
    illustrationColor?: string;
    actionLabel?: string;
    /** When set, the primary action renders as an anchor instead of a button. */
    actionHref?: string;
    onaction?: () => void;
    action?: Snippet;
    className?: string;
  } = $props();
</script>

<div class="text-center py-12 px-4 {className ?? ''}">
  <div class="mx-auto mb-5 flex justify-center">
    {#if illustration}
      <EmptyIllustration variant={illustration} color={illustrationColor} size={120} />
    {:else if Icon}
      <div class="w-20 h-20 rounded-2xl bg-base-200 flex items-center justify-center text-base-content/40 shadow-z1">
        <Icon size={36} />
      </div>
    {:else}
      <div class="w-20 h-20 rounded-2xl bg-base-200 flex items-center justify-center text-base-content/40 shadow-z1">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                d="M9 13h6m-3-3v6m5 5H5a2 2 0 01-2-2V9a2 2 0 012-2h4l3 3h4a2 2 0 012 2v1a2 2 0 01-2 2z" />
        </svg>
      </div>
    {/if}
  </div>

  <h3 class="text-lg font-semibold text-base-content mb-1 tracking-tight">{title}</h3>
  <p class="text-sm text-base-content/55 max-w-md mx-auto mb-6 leading-relaxed">{description}</p>

  {#if action}
    {@render action()}
  {:else if actionLabel && actionHref}
    <a class="btn btn-primary btn-sm shadow-z1" href={actionHref}>{actionLabel}</a>
  {:else if actionLabel && onaction}
    <button class="btn btn-primary btn-sm shadow-z1" onclick={onaction}>{actionLabel}</button>
  {/if}
</div>
