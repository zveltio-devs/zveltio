<script lang="ts">
  import { api } from '$lib/api.js';
  import { Wand2, Eye, Check, ArrowLeft, LoaderCircle, ChevronDown, ChevronRight } from '@lucide/svelte';

  type Step = 'input' | 'preview' | 'done';

  let step = $state<Step>('input');
  let description = $state('');
  let loading = $state(false);
  let error = $state('');

  // Preview data
  let preview = $state<{ collections: any[]; seed_data?: any } | null>(null);
  let confirmToken = $state('');
  let collectionsCount = $state(0);
  let estimatedFields = $state(0);
  let expandedCollections = $state<Set<string>>(new Set());

  // Done data
  let createdCollections = $state<string[]>([]);
  let skippedCollections = $state<string[]>([]);

  async function generatePreview() {
    if (!description.trim()) return;
    loading = true;
    error = '';
    try {
      const res = await api.post<{
        preview: any;
        collections_count: number;
        estimated_fields: number;
        confirm_token: string;
      }>('/api/ai/preview-schema', { description });
      preview = res.preview;
      confirmToken = res.confirm_token;
      collectionsCount = res.collections_count;
      estimatedFields = res.estimated_fields;
      // Expand first collection by default
      if (res.preview.collections.length > 0) {
        expandedCollections = new Set([res.preview.collections[0].name]);
      }
      step = 'preview';
    } catch (e: any) {
      error = e.message ?? 'Preview generation failed';
    } finally {
      loading = false;
    }
  }

  async function confirmCreate() {
    loading = true;
    error = '';
    try {
      const res = await api.post<{
        collections: string[];
        skipped: string[];
        job_ids: string[];
        message: string;
      }>('/api/ai/generate-schema', { confirm_token: confirmToken });
      createdCollections = res.collections;
      skippedCollections = res.skipped;
      step = 'done';
    } catch (e: any) {
      error = e.message ?? 'Schema creation failed';
    } finally {
      loading = false;
    }
  }

  function toggleCollection(name: string) {
    const next = new Set(expandedCollections);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    expandedCollections = next;
  }

  function reset() {
    step = 'input';
    description = '';
    preview = null;
    confirmToken = '';
    error = '';
    createdCollections = [];
    skippedCollections = [];
  }
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <Wand2 class="h-6 w-6 text-purple-500" />
    <div>
      <h1 class="text-xl font-semibold">AI Schema Generator</h1>
      <p class="text-sm text-gray-500">Describe your app — AI will design the database schema</p>
    </div>
  </div>

  <!-- Step indicator -->
  <div class="flex items-center gap-2 text-sm">
    <span class={step === 'input' ? 'font-semibold text-purple-600' : 'text-gray-400'}>1. Describe</span>
    <span class="text-gray-300">→</span>
    <span class={step === 'preview' ? 'font-semibold text-purple-600' : 'text-gray-400'}>2. Review</span>
    <span class="text-gray-300">→</span>
    <span class={step === 'done' ? 'font-semibold text-green-600' : 'text-gray-400'}>3. Done</span>
  </div>

  {#if error}
    <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {error}
    </div>
  {/if}

  <!-- Step 1: Input -->
  {#if step === 'input'}
    <div class="space-y-4">
      <div>
        <label class="mb-1 block text-sm font-medium text-gray-700" for="desc">
          Application description
        </label>
        <textarea
          id="desc"
          bind:value={description}
          rows={6}
          placeholder="E.g. A project management app with teams, projects, tasks, comments, and file attachments. Tasks have priority, due date, and status. Team members can be assigned to tasks."
          class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-100"
        ></textarea>
        <p class="mt-1 text-xs text-gray-400">{description.length}/4000 characters</p>
      </div>

      <button
        onclick={generatePreview}
        disabled={loading || description.trim().length < 10}
        class="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {#if loading}
          <LoaderCircle class="h-4 w-4 animate-spin" />
          Generating preview...
        {:else}
          <Eye class="h-4 w-4" />
          Preview Schema
        {/if}
      </button>
    </div>
  {/if}

  <!-- Step 2: Preview -->
  {#if step === 'preview' && preview}
    <div class="space-y-4">
      <!-- Summary bar -->
      <div class="flex gap-4 rounded-lg border border-purple-100 bg-purple-50 px-4 py-3 text-sm">
        <div>
          <span class="font-semibold text-purple-700">{collectionsCount}</span>
          <span class="text-gray-600"> collections</span>
        </div>
        <div>
          <span class="font-semibold text-purple-700">{estimatedFields}</span>
          <span class="text-gray-600"> total fields</span>
        </div>
        <div class="ml-auto text-xs text-gray-400">Token valid 10 min</div>
      </div>

      <!-- Collections accordion -->
      <div class="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {#each preview.collections as col}
          <div>
            <button
              onclick={() => toggleCollection(col.name)}
              class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
            >
              <div>
                <span class="font-medium text-sm">{col.displayName ?? col.name}</span>
                <code class="ml-2 text-xs text-gray-400">{col.name}</code>
                {#if col.description}
                  <p class="text-xs text-gray-500 mt-0.5">{col.description}</p>
                {/if}
              </div>
              <div class="flex items-center gap-2 text-xs text-gray-400">
                <span>{col.fields.length} fields</span>
                {#if expandedCollections.has(col.name)}
                  <ChevronDown class="h-4 w-4" />
                {:else}
                  <ChevronRight class="h-4 w-4" />
                {/if}
              </div>
            </button>

            {#if expandedCollections.has(col.name)}
              <div class="border-t border-gray-100 bg-gray-50 px-4 py-2">
                <table class="w-full text-xs">
                  <thead>
                    <tr class="text-gray-400">
                      <th class="py-1 text-left font-medium">Field</th>
                      <th class="py-1 text-left font-medium">Type</th>
                      <th class="py-1 text-left font-medium">Required</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-100">
                    {#each col.fields as field}
                      <tr>
                        <td class="py-1 font-mono">{field.name}</td>
                        <td class="py-1">
                          <span class="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">{field.type}</span>
                        </td>
                        <td class="py-1 text-gray-500">{field.required ? 'Yes' : '—'}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Actions -->
      <div class="flex gap-3">
        <button
          onclick={() => { step = 'input'; error = ''; }}
          class="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          <ArrowLeft class="h-4 w-4" />
          Back
        </button>
        <button
          onclick={confirmCreate}
          disabled={loading}
          class="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {#if loading}
            <LoaderCircle class="h-4 w-4 animate-spin" />
            Creating...
          {:else}
            <Check class="h-4 w-4" />
            Create Schema
          {/if}
        </button>
      </div>
    </div>
  {/if}

  <!-- Step 3: Done -->
  {#if step === 'done'}
    <div class="space-y-4">
      <div class="rounded-lg border border-green-200 bg-green-50 px-4 py-4">
        <div class="flex items-center gap-2 text-green-700">
          <Check class="h-5 w-5" />
          <span class="font-semibold">Schema created successfully</span>
        </div>

        {#if createdCollections.length > 0}
          <div class="mt-3">
            <p class="text-sm font-medium text-green-800 mb-1">Created ({createdCollections.length}):</p>
            <div class="flex flex-wrap gap-1">
              {#each createdCollections as name}
                <code class="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">{name}</code>
              {/each}
            </div>
          </div>
        {/if}

        {#if skippedCollections.length > 0}
          <div class="mt-2">
            <p class="text-sm font-medium text-yellow-700 mb-1">Skipped (already exist):</p>
            <div class="flex flex-wrap gap-1">
              {#each skippedCollections as name}
                <code class="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">{name}</code>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="flex gap-3">
        <a
          href="/collections"
          class="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
        >
          View Collections
        </a>
        <button
          onclick={reset}
          class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          Generate Another
        </button>
      </div>
    </div>
  {/if}
</div>
