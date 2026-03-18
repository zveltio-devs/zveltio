<script lang="ts">
  import { onMount } from 'svelte';
  import { ENGINE_URL } from '$lib/config.js';
  import { Shield, Save, LoaderCircle, CheckCircle, XCircle, Copy } from '@lucide/svelte';

  let config = $state({
    enabled: false,
    entryPoint: '',
    issuer: '',
    cert: '',
    callbackUrl: '',
    privateKey: '',
    signatureAlgorithm: 'sha256' as 'sha1' | 'sha256' | 'sha512',
    wantAuthnResponseSigned: true,
    mapEmail: 'email',
    mapName: 'displayName',
  });

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state('');
  let metadataUrl = $state('');

  onMount(async () => {
    metadataUrl = `${ENGINE_URL}/api/auth/saml/metadata`;
    try {
      const res = await fetch(`${ENGINE_URL}/api/auth/saml/config`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.config) Object.assign(config, data.config);
      }
    } catch { /* first load */ }
    loading = false;
  });

  async function save() {
    saving = true;
    error = '';
    success = '';
    try {
      const res = await fetch(`${ENGINE_URL}/api/auth/saml/config`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      success = 'SAML configuration saved successfully.';
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  async function copyMetadataUrl() {
    await navigator.clipboard.writeText(metadataUrl);
  }
</script>

<div class="mx-auto max-w-2xl space-y-6 p-6">
  <div class="flex items-center gap-3">
    <Shield class="h-6 w-6 text-blue-500" />
    <div>
      <h1 class="text-xl font-semibold">SAML 2.0 SSO</h1>
      <p class="text-sm text-gray-500">Configure Single Sign-On with an external Identity Provider</p>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 text-gray-400">
      <LoaderCircle class="h-4 w-4 animate-spin" />
      Loading...
    </div>
  {:else}
    {#if error}
      <div class="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <XCircle class="h-4 w-4 shrink-0" />
        {error}
      </div>
    {/if}
    {#if success}
      <div class="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
        <CheckCircle class="h-4 w-4 shrink-0" />
        {success}
      </div>
    {/if}

    <!-- SP Metadata URL (read-only) -->
    <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p class="text-xs font-medium text-gray-600 mb-1">Service Provider Metadata URL</p>
      <div class="flex items-center gap-2">
        <code class="flex-1 truncate text-xs text-gray-800">{metadataUrl}</code>
        <button onclick={copyMetadataUrl} class="rounded p-1 hover:bg-gray-200" title="Copy">
          <Copy class="h-3.5 w-3.5 text-gray-500" />
        </button>
      </div>
      <p class="mt-1 text-xs text-gray-400">Register this URL in your IdP as the SP metadata endpoint.</p>
    </div>

    <form onsubmit={(e) => { e.preventDefault(); save(); }} class="space-y-4">
      <!-- Enable toggle -->
      <div class="flex items-center justify-between rounded-lg border border-gray-200 p-3">
        <div>
          <p class="text-sm font-medium">Enable SAML SSO</p>
          <p class="text-xs text-gray-500">Allow users to sign in via your Identity Provider</p>
        </div>
        <input type="checkbox" bind:checked={config.enabled} class="h-4 w-4 rounded accent-blue-600" />
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">IdP SSO URL <span class="text-red-500">*</span></label>
          <input bind:value={config.entryPoint} type="url" required
            placeholder="https://idp.example.com/sso/saml"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">SP Entity ID / Issuer <span class="text-red-500">*</span></label>
          <input bind:value={config.issuer} type="text" required
            placeholder="https://your-zveltio-instance.com"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">ACS Callback URL <span class="text-red-500">*</span></label>
          <input bind:value={config.callbackUrl} type="url" required
            placeholder="https://your-zveltio-instance.com/api/auth/saml/callback"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">IdP Certificate (PEM) <span class="text-red-500">*</span></label>
          <textarea bind:value={config.cert} rows={4} required
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:border-blue-400 focus:outline-none"></textarea>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">SP Private Key (optional)</label>
          <textarea bind:value={config.privateKey} rows={3}
            placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:border-blue-400 focus:outline-none"></textarea>
          <p class="mt-1 text-xs text-gray-400">Required only for signed authentication requests.</p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Signature Algorithm</label>
            <select bind:value={config.signatureAlgorithm}
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none">
              <option value="sha256">SHA-256 (recommended)</option>
              <option value="sha512">SHA-512</option>
              <option value="sha1">SHA-1 (legacy)</option>
            </select>
          </div>
          <div class="flex items-end pb-2">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" bind:checked={config.wantAuthnResponseSigned} class="h-4 w-4 accent-blue-600" />
              Require signed response
            </label>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Email attribute</label>
            <input bind:value={config.mapEmail} type="text" placeholder="email"
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Name attribute</label>
            <input bind:value={config.mapName} type="text" placeholder="displayName"
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
        </div>
      </div>

      <button type="submit" disabled={saving}
        class="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {#if saving}
          <LoaderCircle class="h-4 w-4 animate-spin" />
          Saving...
        {:else}
          <Save class="h-4 w-4" />
          Save Configuration
        {/if}
      </button>
    </form>
  {/if}
</div>
