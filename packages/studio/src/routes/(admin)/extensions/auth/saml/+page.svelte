<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Save, LoaderCircle, Copy, Shield } from '@lucide/svelte';

  type SAMLConfig = {
    enabled: boolean; entryPoint: string; issuer: string; cert: string;
    callbackUrl: string; signatureAlgorithm: string;
    wantAuthnResponseSigned: boolean; mapEmail: string; mapName: string;
  };

  let config = $state<SAMLConfig>({
    enabled: false, entryPoint: '', issuer: '', cert: '', callbackUrl: '',
    signatureAlgorithm: 'sha256', wantAuthnResponseSigned: true,
    mapEmail: 'email', mapName: 'displayName',
  });
  let loading = $state(true);
  let saving = $state(false);
  let metadataUrl = $state('');

  onMount(async () => {
    try {
      const r = await api.get<{ config: SAMLConfig | null }>('/api/auth/saml/config');
      if (r.config) config = r.config;
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load SAML config');
    } finally {
      loading = false;
    }
    // Build SP metadata URL from current origin
    const base = (window as any).__ZVELTIO_ENGINE_URL__ || '';
    metadataUrl = `${base}/api/auth/saml/metadata`;
  });

  async function save() {
    saving = true;
    try {
      await api.post('/api/auth/saml/config', config);
      toast.success('SAML configuration saved.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Error saving config');
    } finally {
      saving = false;
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url);
    toast.success('Copied to clipboard.');
  }
</script>

<div class="max-w-2xl space-y-6">
  <div>
    <h1 class="text-xl font-semibold">SAML 2.0 SSO</h1>
    <p class="text-sm text-base-content/50">Configure SAML Single Sign-On with your Identity Provider</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <!-- SP Metadata (read-only) -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-3">
        <h4 class="font-medium text-sm flex items-center gap-2"><Shield size={14} /> Service Provider Info</h4>
        <p class="text-xs text-base-content/60">Provide these values to your Identity Provider when configuring the SAML application.</p>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">SP Metadata URL</span></label>
          <div class="flex gap-2">
            <input class="input input-sm flex-1 font-mono text-xs" readonly value={metadataUrl} />
            <button class="btn btn-ghost btn-sm" onclick={() => copyUrl(metadataUrl)}><Copy size={13} /></button>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">ACS (Callback) URL</span></label>
          <div class="flex gap-2">
            <input class="input input-sm flex-1 font-mono text-xs" readonly value={`${(window as any).__ZVELTIO_ENGINE_URL__ || ''}/api/auth/saml/callback`} />
            <button class="btn btn-ghost btn-sm" onclick={() => copyUrl(`${(window as any).__ZVELTIO_ENGINE_URL__ || ''}/api/auth/saml/callback`)}><Copy size={13} /></button>
          </div>
        </div>
      </div>
    </div>

    <!-- Config Form -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-4">
        <h4 class="font-medium text-sm">Identity Provider Settings</h4>

        <div class="flex items-center gap-3">
          <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={config.enabled} />
          <span class="text-sm">Enable SAML SSO</span>
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">IDP Entry Point URL *</span></label>
          <input class="input input-sm font-mono text-xs" placeholder="https://your-idp.com/sso/saml" bind:value={config.entryPoint} />
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">IDP Issuer / Entity ID</span></label>
          <input class="input input-sm" bind:value={config.issuer} />
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">IDP Certificate (PEM)</span></label>
          <textarea class="textarea textarea-sm font-mono text-xs" rows={5}
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            bind:value={config.cert}></textarea>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Email Attribute</span></label>
            <input class="input input-sm" bind:value={config.mapEmail} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Name Attribute</span></label>
            <input class="input input-sm" bind:value={config.mapName} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Signature Algorithm</span></label>
            <select class="select select-sm" bind:value={config.signatureAlgorithm}>
              <option value="sha1">SHA-1</option>
              <option value="sha256">SHA-256</option>
              <option value="sha512">SHA-512</option>
            </select>
          </div>
          <div class="form-control justify-end">
            <label class="label cursor-pointer py-0 gap-3 justify-start">
              <input type="checkbox" class="checkbox checkbox-sm" bind:checked={config.wantAuthnResponseSigned} />
              <span class="label-text text-xs">Require signed response</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <button class="btn btn-primary gap-2" onclick={save} disabled={saving}>
      {#if saving}<LoaderCircle size={15} class="animate-spin" />{:else}<Save size={15} />{/if}
      Save Configuration
    </button>
  {/if}
</div>
