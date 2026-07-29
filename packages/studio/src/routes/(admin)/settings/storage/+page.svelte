<script lang="ts">
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

interface StorageConfig {
  driver: 'local' | 's3';
  localDir: string;
  s3: {
    endpoint: string;
    bucket: string;
    region: string;
    publicUrl: string;
    accessKey: string;
    secretKeySet: boolean;
  };
}

let loading = $state(true);
let saving = $state(false);
let testing = $state(false);
let testResult = $state<{ ok: boolean; detail: string } | null>(null);

// Form model
let driver = $state<'local' | 's3'>('local');
let localDir = $state('');
let endpoint = $state('');
let bucket = $state('');
let region = $state('');
let publicUrl = $state('');
let accessKey = $state('');
let secretKey = $state(''); // typed only to change it
let secretKeySet = $state(false);

async function load() {
  loading = true;
  try {
    const cfg = await api.get<StorageConfig>('/api/admin/storage/config');
    driver = cfg.driver;
    localDir = cfg.localDir;
    endpoint = cfg.s3.endpoint;
    bucket = cfg.s3.bucket;
    region = cfg.s3.region;
    publicUrl = cfg.s3.publicUrl;
    accessKey = cfg.s3.accessKey;
    secretKeySet = cfg.s3.secretKeySet;
    secretKey = '';
  } catch (e) {
    toast.error(`Failed to load storage config: ${(e as Error).message}`);
  } finally {
    loading = false;
  }
}

// Only include the secret when the operator typed a new one; otherwise keep the
// stored value.
function payload() {
  const s3: Record<string, string> = { endpoint, bucket, region, publicUrl, accessKey };
  if (secretKey) s3.secretKey = secretKey;
  return { driver, localDir, s3 };
}

async function testConnection() {
  testing = true;
  testResult = null;
  try {
    testResult = await api.post<{ ok: boolean; detail: string }>(
      '/api/admin/storage/test',
      payload(),
    );
  } catch (e) {
    testResult = { ok: false, detail: (e as Error).message };
  } finally {
    testing = false;
  }
}

async function save() {
  saving = true;
  try {
    await api.put('/api/admin/storage/config', payload());
    toast.success('Storage configuration saved');
    secretKey = '';
    await load();
  } catch (e) {
    toast.error(`Save failed: ${(e as Error).message}`);
  } finally {
    saving = false;
  }
}

onMount(load);
</script>

<PageHeader title="Storage" subtitle="Where uploaded files are stored — local disk or an S3-compatible object store (SeaweedFS, AWS, R2, …)." />

{#if loading}
  <div class="p-6 text-base-content/60">Loading…</div>
{:else}
  <div class="max-w-2xl space-y-6 p-2">
    <!-- Driver -->
    <div class="form-control">
      <label class="label" for="storage-driver"><span class="label-text font-medium">Driver</span></label>
      <select id="storage-driver" class="select select-bordered w-full max-w-xs" bind:value={driver}>
        <option value="local">Local filesystem (default, no external store)</option>
        <option value="s3">S3-compatible (SeaweedFS / AWS / R2 / …)</option>
      </select>
    </div>

    {#if driver === 'local'}
      <div class="form-control">
        <label class="label" for="local-dir"><span class="label-text">Storage directory</span></label>
        <input id="local-dir" class="input input-bordered w-full" bind:value={localDir} placeholder="/var/lib/zveltio/storage" />
        <span class="label-text-alt mt-1 text-base-content/60">Must be writable + on persistent storage.</span>
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="form-control sm:col-span-2">
          <label class="label" for="s3-endpoint"><span class="label-text">Endpoint</span></label>
          <input id="s3-endpoint" class="input input-bordered w-full" bind:value={endpoint} placeholder="http://seaweedfs:8333" />
        </div>
        <div class="form-control">
          <label class="label" for="s3-bucket"><span class="label-text">Bucket</span></label>
          <input id="s3-bucket" class="input input-bordered w-full" bind:value={bucket} placeholder="zveltio" />
        </div>
        <div class="form-control">
          <label class="label" for="s3-region"><span class="label-text">Region</span></label>
          <input id="s3-region" class="input input-bordered w-full" bind:value={region} placeholder="us-east-1" />
        </div>
        <div class="form-control">
          <label class="label" for="s3-access"><span class="label-text">Access key</span></label>
          <input id="s3-access" class="input input-bordered w-full" bind:value={accessKey} />
        </div>
        <div class="form-control">
          <label class="label" for="s3-secret"><span class="label-text">Secret key</span></label>
          <input id="s3-secret" type="password" class="input input-bordered w-full" bind:value={secretKey} placeholder={secretKeySet ? '•••••••• (set — leave blank to keep)' : ''} />
        </div>
        <div class="form-control sm:col-span-2">
          <label class="label" for="s3-public"><span class="label-text">Public URL (optional)</span></label>
          <input id="s3-public" class="input input-bordered w-full" bind:value={publicUrl} placeholder="https://cdn.example.com/zveltio" />
        </div>
      </div>
    {/if}

    <!-- Actions -->
    <div class="flex items-center gap-3">
      <button class="btn btn-outline" onclick={testConnection} disabled={testing}>
        {testing ? 'Testing…' : 'Test connection'}
      </button>
      <button class="btn btn-primary" onclick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>

    {#if testResult}
      <div class="alert {testResult.ok ? 'alert-success' : 'alert-error'}">
        <span>{testResult.ok ? '✓ ' : '✗ '}{testResult.detail}</span>
      </div>
    {/if}
  </div>
{/if}
