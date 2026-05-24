<script lang="ts">
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { m } from '$lib/i18n.svelte.js';
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
      const r = await api.get<{ config: SAMLConfig | null }>('/ext/auth/saml/config');
      if (r.config) config = r.config;
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
    const base = (window as any).__ZVELTIO_ENGINE_URL__ || '';
    metadataUrl = `${base}/ext/auth/saml/metadata`;
  });

  async function save() {
    saving = true;
    try {
      await api.post('/ext/auth/saml/config', config);
      toast.success(m['auth.saml.toast.saved']());
    } catch (e: any) {
      toast.error(e?.message ?? 'Error saving config');
    } finally {
      saving = false;
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url);
    toast.success(m['ext.copied']());
  }
</script>

<ExtensionPageShell title={m['auth.saml.title']()} subtitle={m['auth.saml.subtitle']()}>
  {#snippet children()}
    <div class="max-w-2xl space-y-6">
{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <!-- SP Metadata (read-only) -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-3">
        <h4 class="font-medium text-sm flex items-center gap-2"><Shield size={14} /> {m['auth.saml.section.sp']()}</h4>
        <p class="text-xs text-base-content/60">Provide these values to your Identity Provider when configuring the SAML application.</p>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.sp_metadata_url']()}</span></label>
          <div class="flex gap-2">
            <input class="input input-sm flex-1 font-mono text-xs" readonly value={metadataUrl} />
            <button class="btn btn-ghost btn-sm" onclick={() => copyUrl(metadataUrl)}><Copy size={13} /></button>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.acs_callback_url']()}</span></label>
          <div class="flex gap-2">
            <input class="input input-sm flex-1 font-mono text-xs" readonly value={`${(window as any).__ZVELTIO_ENGINE_URL__ || ''}/ext/auth/saml/callback`} />
            <button class="btn btn-ghost btn-sm" onclick={() => copyUrl(`${(window as any).__ZVELTIO_ENGINE_URL__ || ''}/ext/auth/saml/callback`)}><Copy size={13} /></button>
          </div>
        </div>
      </div>
    </div>

    <!-- Config Form -->
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-4">
        <h4 class="font-medium text-sm">{m['auth.saml.section.idp']()}</h4>

        <div class="flex items-center gap-3">
          <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={config.enabled} />
          <span class="text-sm">{m['auth.saml.enable']()}</span>
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.idp_entry_point_url']()}</span></label>
          <input class="input input-sm font-mono text-xs" placeholder={m['auth.saml.ui.https_your_idp_com_sso_saml']()} bind:value={config.entryPoint} />
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.idp_issuer_entity_id']()}</span></label>
          <input class="input input-sm" bind:value={config.issuer} />
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.idp_certificate_pem']()}</span></label>
          <textarea class="textarea textarea-sm font-mono text-xs" rows={5}
            placeholder={m['auth.saml.ui.begin_certificate_10_10_end_certificate']()}
            bind:value={config.cert}></textarea>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.email_attribute']()}</span></label>
            <input class="input input-sm" bind:value={config.mapEmail} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.name_attribute']()}</span></label>
            <input class="input input-sm" bind:value={config.mapName} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.saml.ui.signature_algorithm']()}</span></label>
            <select class="select select-sm" bind:value={config.signatureAlgorithm}>
              <option value="sha1">{m['auth.saml.ui.sha_1']()}</option>
              <option value="sha256">{m['auth.saml.ui.sha_256']()}</option>
              <option value="sha512">{m['auth.saml.ui.sha_512']()}</option>
            </select>
          </div>
          <div class="form-control justify-end">
            <label class="label cursor-pointer py-0 gap-3 justify-start">
              <input type="checkbox" class="checkbox checkbox-sm" bind:checked={config.wantAuthnResponseSigned} />
              <span class="label-text text-xs">{m['auth.saml.ui.require_signed_response']()}</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <button class="btn btn-primary gap-2" onclick={save} disabled={saving}>
      {#if saving}<LoaderCircle size={15} class="animate-spin" />{:else}<Save size={15} />{/if}
      {m['auth.saml.btn.save']()}
    </button>
  {/if}
    </div>
  {/snippet}
</ExtensionPageShell>
