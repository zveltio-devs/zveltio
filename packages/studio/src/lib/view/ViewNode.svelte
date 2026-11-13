<script lang="ts">
/**
 * One `view/2` view, drawn by kind (ADR 0042 slices 2 and 4). Containers
 * (`split`, `tabs`) draw their children here; a kind Studio does not draw falls
 * back to the view's own `fallback`, else to the generated list of its collection.
 */
import { fallbackFor, type View, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import type { ViewHost } from './engine.js';
import ViewList from './ViewList.svelte';
import ViewForm from './ViewForm.svelte';
import ViewDetail from './ViewDetail.svelte';
import ViewStat from './ViewStat.svelte';
import ViewButtons from './ViewButtons.svelte';
import ViewBoard from './ViewBoard.svelte';
import ViewTimeline from './ViewTimeline.svelte';
import ViewTree from './ViewTree.svelte';
import ViewMatrix from './ViewMatrix.svelte';
import Self from './ViewNode.svelte';

interface Props {
  view: View;
  host: ViewHost;
  /** The record a nested view sits in (`$record`), e.g. a detail's panel. */
  record?: Record<string, unknown>;
}
const { view, host, record }: Props = $props();

/** The kinds this renderer draws: every `view/2` kind. A later kind falls back. */
const DRAWN = new Set([
  'list',
  'form',
  'detail',
  'board',
  'timeline',
  'tree',
  'matrix',
  'map',
  'stat',
  'split',
  'tabs',
]);

const shown = $derived(DRAWN.has(view.type) ? view : fallbackFor(view, DRAWN));
const scope = $derived<ViewScope>({ ...host.scope, record });
let tab = $state(0);
</script>

{#if shown !== view}
  <div class="alert alert-info text-sm mb-3" data-testid="view-not-drawn">
    {m['view.notDrawn']({ kind: view.type })}
  </div>
{/if}

{#if shown}
  {#if shown.title || (shown.actions?.length && shown.type !== 'detail')}
    <div class="flex items-center justify-between gap-3 mb-3">
      {#if shown.title}<h2 class="text-lg font-semibold">{host.t(shown.title)}</h2>{/if}
      <!-- A detail draws its own: they act on the record it shows. -->
      {#if shown.type !== 'detail'}<ViewButtons buttons={shown.actions} {host} {scope} />{/if}
    </div>
  {/if}

  {#if shown.type === 'list'}
    <ViewList view={shown} {host} {scope} />
  {:else if shown.type === 'form'}
    <ViewForm view={shown} {host} {scope} />
  {:else if shown.type === 'detail'}
    <ViewDetail view={shown} {host} {scope} />
  {:else if shown.type === 'board'}
    <ViewBoard view={shown} {host} {scope} />
  {:else if shown.type === 'timeline'}
    <ViewTimeline view={shown} {host} {scope} />
  {:else if shown.type === 'tree'}
    <ViewTree view={shown} {host} {scope} />
  {:else if shown.type === 'matrix'}
    <ViewMatrix view={shown} {host} {scope} />
  {:else if shown.type === 'map'}
    <!-- Loaded when drawn: Leaflet stays out of the pages with no map. -->
    {#await import('./ViewMap.svelte') then { default: ViewMap }}
      <ViewMap view={shown} {host} {scope} />
    {/await}
  {:else if shown.type === 'stat'}
    <ViewStat view={shown} {host} {scope} />
  {:else if shown.type === 'split'}
    <div class="grid gap-4" style={`grid-template-columns: repeat(${shown.panes.length}, minmax(0, 1fr))`}>
      {#each shown.panes as pane, i (i)}
        <div class="min-w-0"><Self view={pane} {host} {record} /></div>
      {/each}
    </div>
  {:else if shown.type === 'tabs'}
    <div role="tablist" class="tabs tabs-bordered mb-4">
      {#each shown.items as item, i (i)}
        <button role="tab" class="tab" class:tab-active={tab === i} onclick={() => (tab = i)}>
          {host.t(item.title ?? item.id ?? item.type)}
        </button>
      {/each}
    </div>
    {#key tab}
      <Self view={{ ...shown.items[tab], title: undefined }} {host} {record} />
    {/key}
  {/if}
{/if}
