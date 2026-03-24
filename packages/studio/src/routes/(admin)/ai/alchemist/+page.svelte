<script lang="ts">
  import { ENGINE_URL } from '$lib/config.js';
  import { Upload, Wand2, Play, CheckCircle, XCircle, Plus, Minus } from '@lucide/svelte';

  type Step = 'upload' | 'review' | 'done';

  let step = $state<Step>('upload');
  let files = $state<FileList | null>(null);
  let loading = $state(false);
  let error = $state('');

  // Step 1 results
  let sessionId = $state('');
  let analysis = $state('');
  let confidence = $state(0);
  let notes = $state('');
  let collections = $state<any[]>([]);
  let extractedData = $state<Record<string, any[]>>({});

  // Step 2 results
  let execResult = $state<any>(null);

  async function analyze() {
    if (!files || files.length === 0) return;
    loading = true;
    error = '';

    const form = new FormData();
    for (const file of Array.from(files)) form.append('files', file);

    try {
      const res = await fetch(`${ENGINE_URL}/api/ai/alchemist/analyze`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Request failed: ${res.status}`);
      }
      const data = await res.json();
      sessionId = data.session_id;
      analysis = data.analysis ?? '';
      confidence = data.confidence ?? 0;
      notes = data.notes ?? '';
      collections = (data.collections ?? []).map((c: any) => ({
        ...c,
        fields: c.fields ?? [],
        _skip: c._exists ?? false,
      }));
      extractedData = data.extracted_data ?? {};
      step = 'review';
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function execute() {
    loading = true;
    error = '';
    try {
      const res = await fetch(`${ENGINE_URL}/api/ai/alchemist/execute`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          collections: collections
            .filter(c => !c._skip)
            .map(({ _skip, _exists, ...rest }) => rest),
          extracted_data: extractedData,
          skip_existing: true,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Request failed: ${res.status}`);
      }
      execResult = await res.json();
      step = 'done';
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function addField(colIdx: number) {
    collections[colIdx].fields = [...collections[colIdx].fields, { name: '', type: 'text', required: false }];
  }

  function removeField(colIdx: number, fIdx: number) {
    collections[colIdx].fields = collections[colIdx].fields.filter((_: any, i: number) => i !== fIdx);
  }

  const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'email', 'url', 'json', 'richtext', 'enum', 'integer', 'float', 'textarea', 'slug', 'color', 'phone', 'tags'];
</script>

<div class="p-6 max-w-5xl mx-auto space-y-6">
  <div>
    <h1 class="text-2xl font-bold flex items-center gap-2"><Wand2 class="w-6 h-6 text-primary"/> Data Alchemist</h1>
    <p class="text-base-content/60 mt-1">Upload documents — AI proposes a schema and imports your data automatically.</p>
  </div>

  <!-- Step indicator -->
  <ul class="steps w-full">
    <li class="step {step !== 'upload' ? 'step-primary' : 'step-primary'}">Upload</li>
    <li class="step {step === 'review' || step === 'done' ? 'step-primary' : ''}">Review Schema</li>
    <li class="step {step === 'done' ? 'step-primary' : ''}">Done</li>
  </ul>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  <!-- STEP 1: Upload -->
  {#if step === 'upload'}
    <div class="card bg-base-200 shadow">
      <div class="card-body items-center text-center gap-4">
        <Upload class="w-12 h-12 text-primary opacity-60"/>
        <p class="text-base-content/70">Drag files here or click to browse.<br/><span class="text-sm">Supported: CSV, Excel (.xlsx), PDF, JSON, plain text</span></p>
        <input
          type="file"
          multiple
          accept=".csv,.xlsx,.xls,.pdf,.txt,.json,.md"
          class="file-input file-input-bordered w-full max-w-sm"
          onchange={(e) => files = (e.target as HTMLInputElement).files}
        />
        {#if files && files.length > 0}
          <ul class="text-sm text-left w-full max-w-sm">
            {#each Array.from(files) as f}
              <li class="flex items-center gap-2 py-1 border-b border-base-300">
                <CheckCircle class="w-4 h-4 text-success shrink-0"/>
                {f.name} <span class="text-base-content/40 text-xs ml-auto">{(f.size / 1024).toFixed(1)} KB</span>
              </li>
            {/each}
          </ul>
        {/if}
        <button
          class="btn btn-primary gap-2 mt-2"
          onclick={analyze}
          disabled={loading || !files || files.length === 0}
        >
          {#if loading}
            <span class="loading loading-spinner loading-sm"></span> Analyzing...
          {:else}
            <Wand2 class="w-4 h-4"/> Analyze with AI
          {/if}
        </button>
      </div>
    </div>
  {/if}

  <!-- STEP 2: Review schema -->
  {#if step === 'review'}
    <div class="space-y-4">
      <!-- AI summary -->
      <div class="alert alert-info">
        <Wand2 class="w-5 h-5 shrink-0"/>
        <div>
          <p class="font-semibold">{analysis}</p>
          {#if notes}<p class="text-sm mt-1 opacity-70">{notes}</p>{/if}
          {#if confidence > 0}<p class="text-xs mt-1 opacity-60">Confidence: {Math.round(confidence * 100)}%</p>{/if}
        </div>
      </div>

      <!-- Collections to create -->
      {#each collections as col, ci}
        <div class="card bg-base-200 shadow border {col._skip ? 'opacity-50' : ''}">
          <div class="card-body gap-3">
            <div class="flex items-center gap-3 flex-wrap">
              <input class="input input-bordered input-sm font-mono" bind:value={col.name} placeholder="collection_name"/>
              <input class="input input-bordered input-sm flex-1" bind:value={col.displayName} placeholder="Display Name"/>
              <label class="label cursor-pointer gap-2">
                <span class="label-text text-sm">{col._exists ? 'Exists — skip' : 'Skip'}</span>
                <input type="checkbox" class="toggle toggle-sm" bind:checked={col._skip}/>
              </label>
            </div>

            <!-- Fields -->
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <thead>
                  <tr><th>Field Name</th><th>Type</th><th>Required</th><th></th></tr>
                </thead>
                <tbody>
                  {#each col.fields as field, fi}
                    <tr>
                      <td><input class="input input-xs input-bordered w-32" bind:value={field.name} placeholder="field_name"/></td>
                      <td>
                        <select class="select select-xs select-bordered" bind:value={field.type}>
                          {#each FIELD_TYPES as t}<option value={t}>{t}</option>{/each}
                        </select>
                      </td>
                      <td class="text-center"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={field.required}/></td>
                      <td>
                        <button class="btn btn-xs btn-ghost text-error" onclick={() => removeField(ci, fi)}>
                          <Minus class="w-3 h-3"/>
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <button class="btn btn-xs btn-ghost gap-1 self-start" onclick={() => addField(ci)}>
              <Plus class="w-3 h-3"/> Add Field
            </button>

            <!-- Data preview -->
            {#if extractedData[col.name]?.length > 0}
              <details class="mt-2">
                <summary class="cursor-pointer text-sm text-base-content/60">
                  Data preview ({extractedData[col.name].length} rows to import)
                </summary>
                <div class="overflow-x-auto mt-2 max-h-40">
                  <table class="table table-xs table-zebra">
                    <thead>
                      <tr>{#each Object.keys(extractedData[col.name][0]) as k}<th>{k}</th>{/each}</tr>
                    </thead>
                    <tbody>
                      {#each extractedData[col.name].slice(0, 5) as row}
                        <tr>{#each Object.values(row) as v}<td class="font-mono text-xs truncate max-w-24">{v ?? ''}</td>{/each}</tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/if}
          </div>
        </div>
      {/each}

      <div class="flex gap-3">
        <button class="btn btn-ghost" onclick={() => step = 'upload'}>Back</button>
        <button class="btn btn-primary gap-2" onclick={execute} disabled={loading}>
          {#if loading}
            <span class="loading loading-spinner loading-sm"></span> Creating...
          {:else}
            <Play class="w-4 h-4"/> Create & Import
          {/if}
        </button>
      </div>
    </div>
  {/if}

  <!-- STEP 3: Done -->
  {#if step === 'done' && execResult}
    <div class="card bg-base-200 shadow">
      <div class="card-body items-center text-center gap-4">
        <CheckCircle class="w-16 h-16 text-success"/>
        <h2 class="text-xl font-bold">{execResult.message}</h2>

        {#if execResult.collections_created.length > 0}
          <div class="w-full text-left">
            <p class="font-semibold text-sm mb-1">Collections created:</p>
            <ul class="list-disc list-inside text-sm space-y-0.5">
              {#each execResult.collections_created as c}
                <li class="text-success">{c}</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if Object.keys(execResult.records_inserted).length > 0}
          <div class="w-full text-left">
            <p class="font-semibold text-sm mb-1">Records inserted:</p>
            <ul class="list-disc list-inside text-sm space-y-0.5">
              {#each Object.entries(execResult.records_inserted) as [col, count]}
                <li>{col}: <strong>{count}</strong> rows</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if execResult.errors.length > 0}
          <div class="w-full text-left">
            <p class="font-semibold text-sm text-error mb-1">Errors:</p>
            <ul class="list-disc list-inside text-sm text-error space-y-0.5">
              {#each execResult.errors as e}<li>{e}</li>{/each}
            </ul>
          </div>
        {/if}

        <button class="btn btn-primary mt-2" onclick={() => { step = 'upload'; files = null; execResult = null; collections = []; }}>
          Start Over
        </button>
      </div>
    </div>
  {/if}
</div>
