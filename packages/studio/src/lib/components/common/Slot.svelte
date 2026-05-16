<!--
  Composition slot for extensions (S3-03).

  Renders every contribution registered against `name` via
  `window.__zveltio.registerSlot(name, { component, priority, visible,
  props })`. Sort is priority asc (lower first), stable within ties.

  Usage:

    <Slot name="dashboard.widgets" ctx={{ user }} />

  `ctx` is forwarded to each contribution's `visible(ctx)` predicate AND
  spread into the rendered component as props (after the contribution's
  own `props`). Slot hosts that need authorization-aware visibility pass
  `{ user }` here.

  If no extension targets the slot the markup collapses to nothing — slot
  hosts can declare slots liberally without worrying about empty UI.
-->
<script lang="ts">
  import { studioApi } from '$lib/extension-api.svelte.js';
  import type { SlotContribution } from '@zveltio/sdk/extension';

  interface Props {
    name: string;
    ctx?: Record<string, unknown>;
  }

  let { name, ctx = {} }: Props = $props();

  const contributions = $derived<SlotContribution[]>(
    studioApi.getSlotContributions(name).filter((c) => {
      if (typeof c.visible !== 'function') return true;
      try { return c.visible(ctx); }
      catch (err) {
        console.error(`[slot:${name}] visible() threw, hiding contribution:`, err);
        return false;
      }
    }),
  );
</script>

{#each contributions as c, i (i)}
  {#if c.component}
    <svelte:component this={c.component} {...(c.props ?? {})} {...ctx} />
  {/if}
{/each}
