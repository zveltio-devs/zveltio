<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { base } from '$app/paths';
  import { Wand2, CheckCircle, AlertCircle, Loader, ChevronRight, Database } from '@lucide/svelte';

  let description = $state('');
  let seed = $state(true);
  let seedCount = $state(5);
  let generating = $state(false);
  let result = $state<{
    success: boolean;
    collections: string[];
    skipped: string[];
    job_ids: string[];
    seed_data: Record<string, any[]>;
    message: string;
  } | null>(null);
  let error = $state('');

  const EXAMPLES = [
    'A blog platform with posts, categories, tags, authors and comments. Posts have title, content, status (draft/published), featured image and SEO fields.',
    'An e-commerce store with products, categories, orders, customers and reviews. Products have price, stock, images and variants.',
    'A project management app with projects, tasks, milestones, team members and time entries. Tasks have priority, status, due date and assignees.',
    'A CRM with contacts, companies, deals, activities and notes. Deals have a pipeline stage and estimated value.',
  ];

  async function generate() {
    if (!description.trim()) return;
    generating = true;
    result = null;
    error = '';
    try {
      const res = await api.post('/api/ai/generate-schema', {
        description: description.trim(),
        seed,
        seed_count: seedCount,
      });
      result = res;
    } catch (e: any) {
      error = e.message;
    } finally {
      generating = false;
    }
  }
</script>

<div class="p-6 max-w-3xl mx-auto">
  <div class="mb-8">
    <h1 class="text-3xl font-bold flex items-center gap-3">
      <Wand2 size={30} class="text-primary" />
      AI Schema Generator
    </h1>
    <p class="text-base-content/60 mt-2">
      Describe your application in plain English — Zveltio generates the full database schema in seconds.
    </p>
  </div>

  <!-- Examples -->
  <div class="mb-4">
    <p class="text-xs font-semibold text-base-content/40 uppercase tracking-wider mb-2">Examples</p>
    <div class="flex flex-wrap gap-2">
      {#each EXAMPLES as ex}
        <button
          class="badge badge-outline badge-sm cursor-pointer hover:badge-primary transition-colors text-left py-3 px-3 h-auto whitespace-normal"
          onclick={() => (description = ex)}
        >
          {ex.slice(0, 60)}…
        </button>
      {/each}
    </div>
  </div>

  <!-- Input -->
  <div class="card bg-base-200 p-6 mb-6">
    <div class="form-control mb-4">
      <label class="label">
        <span class="label-text font-semibold">Describe your application</span>
      </label>
      <textarea
        class="textarea textarea-bordered text-sm leading-relaxed"
        rows={6}
        placeholder="e.g. A blog platform with posts, categories, authors and comments. Posts should have a title, rich text content, featured image, status (draft/published), and SEO metadata..."
        bind:value={description}
      ></textarea>
    </div>

    <div class="flex items-center gap-6 mb-4">
      <label class="label cursor-pointer gap-2">
        <input type="checkbox" class="checkbox checkbox-primary checkbox-sm" bind:checked={seed} />
        <span class="label-text">Generate sample data</span>
      </label>
      {#if seed}
        <div class="flex items-center gap-2">
          <span class="label-text text-sm">Records per collection:</span>
          <input
            type="number"
            class="input input-bordered input-xs w-16 text-center"
            min="1"
            max="50"
            bind:value={seedCount}
          />
        </div>
      {/if}
    </div>

    <button
      class="btn btn-primary w-full"
      onclick={generate}
      disabled={!description.trim() || generating}
    >
      {#if generating}
        <Loader size={16} class="animate-spin" />
        Generating schema…
      {:else}
        <Wand2 size={16} />
        Generate Schema
      {/if}
    </button>
  </div>

  <!-- Error -->
  {#if error}
    <div class="alert alert-error mb-4">
      <AlertCircle size={16} />
      {error}
    </div>
  {/if}

  <!-- Result -->
  {#if result}
    <div class="card bg-base-200 p-6">
      <div class="flex items-center gap-2 mb-4">
        <CheckCircle size={20} class="text-success" />
        <span class="font-semibold">{result.message}</span>
      </div>

      {#if result.collections.length > 0}
        <div class="mb-4">
          <p class="text-sm font-semibold text-base-content/60 mb-2">Collections created:</p>
          <div class="flex flex-wrap gap-2">
            {#each result.collections as col}
              <a
                href="{base}/collections/{col}/data"
                class="badge badge-success gap-1 cursor-pointer"
              >
                <Database size={10} />
                {col}
                <ChevronRight size={10} />
              </a>
            {/each}
          </div>
        </div>
      {/if}

      {#if result.skipped.length > 0}
        <div class="mb-4">
          <p class="text-sm font-semibold text-base-content/60 mb-2">Skipped (already exist):</p>
          <div class="flex flex-wrap gap-2">
            {#each result.skipped as col}
              <span class="badge badge-warning badge-outline">{col}</span>
            {/each}
          </div>
        </div>
      {/if}

      {#if result.seed_data && Object.keys(result.seed_data).length > 0}
        <div>
          <p class="text-sm font-semibold text-base-content/60 mb-2">Sample data preview:</p>
          {#each Object.entries(result.seed_data) as [colName, rows]}
            {#if rows.length > 0}
              <div class="mb-3">
                <p class="text-xs font-mono text-base-content/50 mb-1">{colName} ({rows.length} records)</p>
                <div class="mockup-code text-xs max-h-40 overflow-auto">
                  <pre><code>{JSON.stringify(rows[0], null, 2)}</code></pre>
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      <div class="mt-4 pt-4 border-t border-base-300">
        <p class="text-xs text-base-content/40">
          Collections are created asynchronously via the DDL queue. They may take a moment to appear.
        </p>
        <a href="{base}/collections" class="btn btn-ghost btn-xs mt-2">
          <Database size={12} /> View all collections →
        </a>
      </div>
    </div>
  {/if}
</div>
