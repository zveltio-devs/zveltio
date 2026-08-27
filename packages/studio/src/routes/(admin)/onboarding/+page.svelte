<script lang="ts">
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { m } from '$lib/i18n.svelte.js';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import {
  CircleCheck,
  Circle,
  ArrowRight,
  ArrowLeft,
  Database,
  Key,
  Webhook,
  Zap,
  PartyPopper,
  Copy,
} from '@lucide/svelte';

// ── Steps ──────────────────────────────────────────────────────
const STEPS = [
  { id: 'welcome', label: m['onboarding.stepWelcome'] },
  { id: 'collection', label: m['common.col.collection'] },
  { id: 'api-key', label: m['onboarding.apiKey'] },
  { id: 'test', label: m['onboarding.stepTest'] },
  { id: 'webhook', label: m['onboarding.stepWebhook'] },
  { id: 'done', label: m['onboarding.stepDone'] },
] as const;

type StepId = (typeof STEPS)[number]['id'];

let step = $state<StepId>('welcome');
let loading = $state(false);

// Step 2 — collection
let colName = $state('');
let colLabel = $state('');
let colCreated = $state(false);
let colNameManuallyEdited = $state(false);

$effect(() => {
  if (!colNameManuallyEdited && colLabel) {
    colName = colLabel
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
  }
});

// Step 3 — API key
let keyName = $state('My App');
let apiKey = $state('');
let keyCreated = $state(false);

// Step 4 — test
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let engineUrl = (typeof window !== 'undefined' ? (window as any).__ZVELTIO_ENGINE_URL__ : '') || '';
let testResult = $state('');
let testLoading = $state(false);

// Step 5 — webhook (optional)
let webhookUrl = $state('');
let webhookEvents = $state(['data.created']);
let webhookSkipped = $state(false);

const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));

function next() {
  const idx = STEPS.findIndex((s) => s.id === step);
  if (idx < STEPS.length - 1) step = STEPS[idx + 1].id;
}
function back() {
  const idx = STEPS.findIndex((s) => s.id === step);
  if (idx > 0) step = STEPS[idx - 1].id;
}

// ── Step 2: create collection ──────────────────────────────────
async function createCollection() {
  if (!colName.trim()) return;
  loading = true;
  try {
    const slug = colName
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    await api.post('/api/collections', {
      name: slug,
      label: colLabel || colName,
      fields: [{ name: 'title', type: 'text', required: true }],
    });
    colCreated = true;
    toast.success(`Collection "${colLabel || colName}" created!`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create collection');
  } finally {
    loading = false;
  }
}

// ── Step 3: create API key ─────────────────────────────────────
async function createApiKey() {
  loading = true;
  try {
    const res = await api.post<{ key: string }>('/api/admin/api-keys', {
      name: keyName || 'My App',
      scopes: [{ collection: '*', actions: ['read', 'create', 'update', 'delete'] }],
    });
    apiKey = res.key ?? '';
    keyCreated = true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create API key');
  } finally {
    loading = false;
  }
}

function copyKey() {
  navigator.clipboard.writeText(apiKey).then(() => toast.success('Copied!'));
}

// ── Step 4: test API call ──────────────────────────────────────
async function runTest() {
  testLoading = true;
  testResult = '';
  try {
    const colSlug =
      colName
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '') || 'test';
    const res = await api.fetch(`/api/data/${colSlug}?limit=1`, {
      headers: { 'X-API-Key': apiKey },
    });
    const data = await res.json();
    testResult = JSON.stringify(data, null, 2);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    testResult = `Error: ${err.message}`;
  } finally {
    testLoading = false;
  }
}

// ── Step 5: create webhook ─────────────────────────────────────
async function createWebhook() {
  if (!webhookUrl.trim()) {
    webhookSkipped = true;
    next();
    return;
  }
  loading = true;
  try {
    await api.post('/api/webhooks', {
      name: 'My First Webhook',
      url: webhookUrl,
      events: webhookEvents,
      is_active: true,
    });
    toast.success('Webhook created!');
    next();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create webhook');
  } finally {
    loading = false;
  }
}

function skipWebhook() {
  webhookSkipped = true;
  next();
}

function finish() {
  localStorage.setItem('zveltio-onboarding-done', '1');
  goto(`${base}/`);
}
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 py-12 px-4">
  <div class="w-full max-w-xl">

    <!-- Progress bar -->
    <div class="flex items-center gap-1.5 mb-8 justify-center">
      {#each STEPS as s, i}
        <div class="flex items-center gap-1.5">
          <div class="flex items-center gap-1">
            {#if i < stepIndex}
              <CircleCheck size={18} class="text-success" />
            {:else if i === stepIndex}
              <div class="w-4.5 h-4.5 rounded-full bg-primary border-2 border-primary flex items-center justify-center">
                <div class="w-1.5 h-1.5 rounded-full bg-white"></div>
              </div>
            {:else}
              <Circle size={18} class="text-base-content/55" />
            {/if}
            <span class="text-xs hidden sm:inline {i === stepIndex ? 'font-semibold text-primary' : i < stepIndex ? 'text-success' : 'text-base-content/55'}">{s.label()}</span>
          </div>
          {#if i < STEPS.length - 1}
            <div class="w-6 h-px {i < stepIndex ? 'bg-success' : 'bg-base-300'}"></div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Card -->
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body gap-6">

        <!-- STEP: welcome -->
        {#if step === 'welcome'}
          <div class="text-center space-y-3">
            <div class="text-5xl mb-2">👋</div>
            <h1 class="text-2xl font-bold">{m['onboarding.welcomeTitle']()}</h1>
            <p class="text-base-content/65">{m['onboarding.welcomeDesc1']()}<br />{m['onboarding.welcomeDesc2']()}</p>
          </div>
          <div class="flex flex-col items-center gap-3 mt-2">
            <button class="btn btn-primary gap-2" onclick={next}>
              {m['onboarding.getStarted']()} <ArrowRight size={16} />
            </button>
            <button class="btn btn-ghost btn-sm text-base-content/65" onclick={finish}>
              {m['onboarding.skipSetup']()}
            </button>
          </div>

        <!-- STEP: collection -->
        {:else if step === 'collection'}
          <div>
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Database size={20} class="text-primary" />
              </div>
              <div>
                <h2 class="font-bold text-lg">{m['onboarding.colTitle']()}</h2>
                <p class="text-sm text-base-content/65">{m['onboarding.colDesc']()}</p>
              </div>
            </div>

            {#if colCreated}
              <div class="alert alert-success mb-4">
                <CircleCheck size={18} />
                <span>{m['onboarding.colCreatedMsg']({ name: colLabel || colName })}</span>
              </div>
            {:else}
              <div class="space-y-3">
                <div class="form-control">
                  <label class="label" for="col-label"><span class="label-text">{m['common.col.name']()}</span></label>
                  <input id="col-label" class="input" bind:value={colLabel} placeholder={m['onboarding.egBlogPosts']()} />
                </div>
                <div class="form-control">
                  <label class="label" for="col-name">
                    <span class="label-text">{m['onboarding.slug']()} <span class="text-base-content/65">{m['onboarding.autoGenerated']()}</span></span>
                  </label>
                  <input
                    id="col-name"
                    class="input font-mono text-sm"
                    bind:value={colName}
                    placeholder="blog_posts"
                    oninput={() => { colNameManuallyEdited = true; }}
                  />
                </div>
              </div>
            {/if}
          </div>

          <div class="flex justify-between">
            <button class="btn btn-ghost gap-1" onclick={back}><ArrowLeft size={16} />{m['onboarding.back']()}</button>
            {#if colCreated}
              <button class="btn btn-primary gap-2" onclick={next}>{m['common.next']()} <ArrowRight size={16} /></button>
            {:else}
              <button class="btn btn-primary gap-2" onclick={createCollection} disabled={loading || !colName.trim()}>
                {#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
                {m['onboarding.createCollection']()} <ArrowRight size={16} />
              </button>
            {/if}
          </div>

        <!-- STEP: api-key -->
        {:else if step === 'api-key'}
          <div>
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-full bg-warning/10 flex items-center justify-center">
                <Key size={20} class="text-warning" />
              </div>
              <div>
                <h2 class="font-bold text-lg">{m['onboarding.keyTitle']()}</h2>
                <p class="text-sm text-base-content/65">{m['onboarding.keyDesc']()}</p>
              </div>
            </div>

            {#if keyCreated}
              <div class="space-y-3">
                <div class="alert alert-warning text-sm">
                  <span>{m['onboarding.copyKeyWarning']()}</span>
                </div>
                <div class="flex items-center gap-2">
                  <code class="flex-1 bg-base-200 rounded px-3 py-2 text-xs font-mono break-all">{apiKey}</code>
                  <button class="btn btn-ghost btn-sm" onclick={copyKey} aria-label={m['onboarding.copyApiKey']()} title={m['common.copyShort']()}><Copy size={14} /></button>
                </div>
              </div>
            {:else}
              <div class="form-control">
                <label class="label" for="key-name"><span class="label-text">{m['onboarding.keyNameLabel']()}</span></label>
                <input id="key-name" class="input" bind:value={keyName} placeholder={m['onboarding.egMyApp']()} />
              </div>
            {/if}
          </div>

          <div class="flex justify-between">
            <button class="btn btn-ghost gap-1" onclick={back}><ArrowLeft size={16} />{m['onboarding.back']()}</button>
            {#if keyCreated}
              <button class="btn btn-primary gap-2" onclick={next}>{m['common.next']()} <ArrowRight size={16} /></button>
            {:else}
              <button class="btn btn-primary gap-2" onclick={createApiKey} disabled={loading}>
                {#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
                {m['onboarding.generateKey']()} <ArrowRight size={16} />
              </button>
            {/if}
          </div>

        <!-- STEP: test -->
        {:else if step === 'test'}
          <div>
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center">
                <Zap size={20} class="text-success" />
              </div>
              <div>
                <h2 class="font-bold text-lg">{m['onboarding.testTitle']()}</h2>
                <p class="text-sm text-base-content/65">{m['onboarding.testDesc']()}</p>
              </div>
            </div>

            <div class="bg-base-200 rounded-lg p-3 font-mono text-xs mb-3 space-y-1">
              <p class="text-base-content/65">GET {engineUrl}/api/data/{colName || 'your_collection'}</p>
              <p class="text-base-content/65">X-API-Key: {apiKey ? apiKey.slice(0, 20) + '…' : m['onboarding.yourKey']()}</p>
            </div>

            <button class="btn btn-sm btn-outline gap-2 w-full" onclick={runTest} disabled={testLoading}>
              {#if testLoading}<span class="loading loading-spinner loading-xs"></span>{:else}<Zap size={14} />{/if}
              {m['onboarding.runRequest']()}
            </button>

            {#if testResult}
              <pre class="mt-3 bg-base-200 rounded p-3 text-xs overflow-auto max-h-40 font-mono">{testResult}</pre>
            {/if}
          </div>

          <div class="flex justify-between">
            <button class="btn btn-ghost gap-1" onclick={back}><ArrowLeft size={16} />{m['onboarding.back']()}</button>
            <button class="btn btn-primary gap-2" onclick={next}>{m['common.next']()} <ArrowRight size={16} /></button>
          </div>

        <!-- STEP: webhook -->
        {:else if step === 'webhook'}
          <div>
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-full bg-info/10 flex items-center justify-center">
                <Webhook size={20} class="text-info" />
              </div>
              <div>
                <h2 class="font-bold text-lg">{m['onboarding.webhookTitle']()} <span class="badge badge-ghost badge-sm">{m['common.optional']()}</span></h2>
                <p class="text-sm text-base-content/65">{m['onboarding.webhookDesc']()}</p>
              </div>
            </div>

            <div class="form-control">
              <label class="label" for="wh-url"><span class="label-text">{m['onboarding.webhookUrl']()}</span></label>
              <input id="wh-url" class="input font-mono text-sm" bind:value={webhookUrl} placeholder="https://your-app.com/webhooks/zveltio" />
              <p class="text-xs text-base-content/65 mt-1">{m['onboarding.leaveEmptySkip']()}</p>
            </div>
          </div>

          <div class="flex justify-between">
            <button class="btn btn-ghost gap-1" onclick={back}><ArrowLeft size={16} />{m['onboarding.back']()}</button>
            <div class="flex gap-2">
              <button class="btn btn-ghost btn-sm" onclick={skipWebhook}>{m['onboarding.skip']()}</button>
              <button class="btn btn-primary gap-2" onclick={createWebhook} disabled={loading}>
                {#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
                {webhookUrl ? m['onboarding.createContinue']() : m['onboarding.skip']()} <ArrowRight size={16} />
              </button>
            </div>
          </div>

        <!-- STEP: done -->
        {:else if step === 'done'}
          <div class="text-center space-y-4 py-2">
            <PartyPopper size={52} class="mx-auto text-success" />
            <h2 class="text-2xl font-bold">{m['onboarding.doneTitle']()}</h2>
            <p class="text-base-content/65">{m['onboarding.doneDesc']()}</p>

            <div class="text-left space-y-2 bg-base-200 rounded-lg p-4">
              {#if colCreated}
                <div class="flex items-center gap-2 text-sm">
                  <CircleCheck size={16} class="text-success shrink-0" />
                  <span>{m['common.col.collection']()} <strong>{colLabel || colName}</strong></span>
                </div>
              {/if}
              {#if keyCreated}
                <div class="flex items-center gap-2 text-sm">
                  <CircleCheck size={16} class="text-success shrink-0" />
                  <span>{m['onboarding.apiKeyWord']()} <strong>{keyName}</strong></span>
                </div>
              {/if}
              {#if !webhookSkipped && webhookUrl}
                <div class="flex items-center gap-2 text-sm">
                  <CircleCheck size={16} class="text-success shrink-0" />
                  <span>{m['onboarding.stepWebhook']()} → <span class="font-mono text-xs">{webhookUrl}</span></span>
                </div>
              {/if}
            </div>

            <div class="flex gap-3 justify-center pt-2">
              <a href="{base}/collections" class="btn btn-outline btn-sm gap-1">
                <Database size={14} /> {m['nav.collections']()}
              </a>
              <button class="btn btn-primary gap-2" onclick={finish}>
                {m['onboarding.goDashboard']()} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        {/if}

      </div>
    </div>

  </div>
</div>
