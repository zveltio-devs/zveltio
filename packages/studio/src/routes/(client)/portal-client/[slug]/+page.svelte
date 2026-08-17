<script lang="ts">
import { page } from '$app/state';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';

const ZONE_SLUG = 'client';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let pageData = $state<{ page: any; site: any; blocks: any[]; record: any } | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

const slug = $derived(page.params.slug);

onMount(async () => {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.get<{ page: any; site: any; blocks: any[]; record: any }>(
      `/ext/content/pages/sites/${ZONE_SLUG}/render/${slug}`,
    );
    pageData = res;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    error = e?.message ?? 'Failed to load page';
  } finally {
    loading = false;
  }
});
</script>

{#if loading}
  <div class="flex items-center justify-center py-20">
    <span class="loading loading-spinner loading-md text-primary"></span>
  </div>

{:else if error}
  <div class="alert alert-error max-w-md mx-auto mt-10">
    <span>{error}</span>
  </div>

{:else if pageData}
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-base-content">{pageData.page.title}</h1>
      {#if pageData.page.description}
        <p class="text-sm text-base-content/60 mt-1">{pageData.page.description}</p>
      {/if}
    </div>

    <!--
      Blocks, drawn by the extension's own renderer.

      This hand-rolled a table for `view_type === 'table'`, a stats strip for
      `stats`, and dumped JSON for everything else — a third rendering of the
      same data, beside the public host's and the editor's preview. Since the
      pages merge a portal page IS blocks, so it is drawn by the component that
      draws blocks, and a new block type appears here without anyone editing
      this file.
    -->
    <BlockRenderer
      blocks={pageData.blocks ?? []}
      record={pageData.record ?? null}
      blocksBaseUrl={`/ext/content/pages/sites/${ZONE_SLUG}/render/${slug}/blocks`}
    />

    {#if (pageData.blocks ?? []).length === 0}
      <div class="text-center py-12 text-base-content/40 text-sm">
        This page has no blocks yet.
      </div>
    {/if}
  </div>
{/if}
