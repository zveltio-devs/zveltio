<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
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
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

// Form model
let driver = $state<'local' | 's3'>('local');
// What the engine last told us the driver is — the baseline `save()` compares
// against to know whether this save switches drivers.
let loadedDriver = $state<'local' | 's3'>('local');
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
    loadedDriver = cfg.driver;
    localDir = cfg.localDir;
    endpoint = cfg.s3.endpoint;
    bucket = cfg.s3.bucket;
    region = cfg.s3.region;
    publicUrl = cfg.s3.publicUrl;
    accessKey = cfg.s3.accessKey;
    secretKeySet = cfg.s3.secretKeySet;
    secretKey = '';
  } catch (e) {
    toast.error(m['stor.loadFailed']({ error: (e as Error).message }));
  } finally {
    loading = false;
  }
}

// A probe result belongs to the values it was run against.
//
// `testResult` survived every later edit, so a green "connection ok" stayed on
// screen while the endpoint below it was changed to something that had never
// been reached — an operator could save a broken configuration with a tick mark
// next to it. Anything that changes the connection clears the verdict.
$effect(() => {
  // Read them so the effect re-runs when any of them changes.
  void [driver, localDir, endpoint, bucket, region, accessKey, secretKey];
  testResult = null;
});

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

function save() {
  // Changing the driver reroutes every future upload. Files already stored under
  // the old driver keep URLs that point at it, so this is not a setting that can
  // be flipped back and forth without consequence — it is worth one question.
  if (driver !== loadedDriver) {
    confirmState = {
      open: true,
      title: m['stor.switchDriverTitle'](),
      message: m['stor.switchDriverMsg']({ from: loadedDriver, to: driver }),
      confirmLabel: m['common.save'](),
      onconfirm: () => {
        confirmState.open = false;
        doSave();
      },
    };
    return;
  }
  doSave();
}

async function doSave() {
  saving = true;
  try {
    await api.put('/api/admin/storage/config', payload());
    toast.success(m['stor.saved']());
    secretKey = '';
    await load();
  } catch (e) {
    toast.error(m['stor.saveFailed']({ error: (e as Error).message }));
  } finally {
    saving = false;
  }
}

onMount(load);
</script>

<PageHeader title={m['stor.title']()} subtitle={m['stor.subtitle']()} />

{#if loading}
  <div class="p-6 text-base-content/65">{m['common.loading']()}</div>
{:else}
  <div class="max-w-2xl space-y-6 p-2">
    <!-- Driver -->
    <div class="form-control">
      <label class="label" for="storage-driver"><span class="label-text font-medium">{m['stor.driver']()}</span></label>
      <select id="storage-driver" class="select select-bordered w-full max-w-xs" bind:value={driver}>
        <option value="local">{m['stor.driverLocal']()}</option>
        <option value="s3">{m['stor.driverS3']()}</option>
      </select>
    </div>

    {#if driver === 'local'}
      <div class="form-control">
        <label class="label" for="local-dir"><span class="label-text">{m['stor.directory']()}</span></label>
        <input id="local-dir" class="input input-bordered w-full" bind:value={localDir} placeholder="/var/lib/zveltio/storage" />
        <span class="label-text-alt mt-1 text-base-content/65">{m['stor.dirHint']()}</span>
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="form-control sm:col-span-2">
          <label class="label" for="s3-endpoint"><span class="label-text">{m['stor.endpoint']()}</span></label>
          <input id="s3-endpoint" class="input input-bordered w-full" bind:value={endpoint} placeholder="http://seaweedfs:8333" />
        </div>
        <div class="form-control">
          <label class="label" for="s3-bucket"><span class="label-text">{m['stor.bucket']()}</span></label>
          <input id="s3-bucket" class="input input-bordered w-full" bind:value={bucket} placeholder="zveltio" />
        </div>
        <div class="form-control">
          <label class="label" for="s3-region"><span class="label-text">{m['stor.region']()}</span></label>
          <input id="s3-region" class="input input-bordered w-full" bind:value={region} placeholder="us-east-1" />
        </div>
        <div class="form-control">
          <label class="label" for="s3-access"><span class="label-text">{m['stor.accessKey']()}</span></label>
          <input id="s3-access" class="input input-bordered w-full" bind:value={accessKey} />
        </div>
        <div class="form-control">
          <label class="label" for="s3-secret"><span class="label-text">{m['stor.secretKey']()}</span></label>
          <input id="s3-secret" type="password" class="input input-bordered w-full" bind:value={secretKey} placeholder={secretKeySet ? m['stor.secretSetPh']() : ''} />
        </div>
        <div class="form-control sm:col-span-2">
          <label class="label" for="s3-public"><span class="label-text">{m['stor.publicUrl']()}</span></label>
          <input id="s3-public" class="input input-bordered w-full" bind:value={publicUrl} placeholder="https://cdn.example.com/zveltio" />
        </div>
      </div>
    {/if}

    <!-- Actions -->
    <div class="flex items-center gap-3">
      <button class="btn btn-outline" onclick={testConnection} disabled={testing}>
        {testing ? m['stor.testing']() : m['common.testConnection']()}
      </button>
      <button class="btn btn-primary" onclick={save} disabled={saving}>
        {saving ? m['erd.saving']() : m['common.save']()}
      </button>
    </div>

    {#if testResult}
      <div class="alert {testResult.ok ? 'alert-success' : 'alert-error'}">
        <span>{testResult.ok ? '✓ ' : '✗ '}{testResult.detail}</span>
      </div>
    {/if}
  </div>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? m['common.confirm']()}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
