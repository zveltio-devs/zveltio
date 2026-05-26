<script lang="ts">
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Save, LoaderCircle, Play } from '@lucide/svelte';

type LDAPConfig = {
  enabled: boolean;
  url: string;
  bindDN: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  nameAttribute: string;
  tlsVerify: boolean;
};

let config = $state<LDAPConfig>({
  enabled: false,
  url: 'ldap://ldap.example.com:389',
  bindDN: 'cn=admin,dc=example,dc=com',
  bindPassword: '',
  searchBase: 'dc=example,dc=com',
  searchFilter: '(uid={{username}})',
  usernameAttribute: 'uid',
  emailAttribute: 'mail',
  nameAttribute: 'cn',
  tlsVerify: true,
});
let loading = $state(true);
let saving = $state(false);
let testing = $state(false);

onMount(async () => {
  try {
    const r = await api.get<{ config: LDAPConfig | null }>('/ext/auth/ldap/config');
    if (r.config) config = { ...config, ...r.config };
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
});

async function save() {
  saving = true;
  try {
    await api.post('/ext/auth/ldap/config', config);
    toast.success(m['auth.ldap.toast.saved']());
  } catch (e: any) {
    toast.error(e?.message ?? 'Error saving config');
  } finally {
    saving = false;
  }
}

async function testConnection() {
  testing = true;
  try {
    await api.post('/ext/auth/ldap/test', config);
    toast.success(m['auth.ldap.toast.connectionOk']());
  } catch (e: any) {
    toast.error(e?.message ?? 'Connection failed');
  } finally {
    testing = false;
  }
}
</script>

<ExtensionPageShell title={m['auth.ldap.title']()} subtitle={m['auth.ldap.subtitle']()}>
    <div class="max-w-2xl space-y-6">
{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-4">

        <div class="flex items-center gap-3">
          <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={config.enabled} />
          <span class="text-sm">{m['auth.ldap.section.enable']()}</span>
        </div>

        <div class="divider my-0 text-xs text-base-content/30">{m['auth.ldap.section.server']()}</div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.ldap_url']()}</span></label>
          <input class="input input-sm font-mono text-xs" placeholder={m['auth.ldap.ui.ldap_ldap_example_com_389']()} bind:value={config.url} />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.bind_dn']()}</span></label>
            <input class="input input-sm font-mono text-xs" bind:value={config.bindDN} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.bind_password']()}</span></label>
            <input class="input input-sm" type="password" bind:value={config.bindPassword} />
          </div>
        </div>

        <div class="form-control flex-row items-center gap-3">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={config.tlsVerify} />
          <label class="label-text text-xs cursor-pointer">{m['auth.ldap.section.tls']()}</label>
        </div>

        <div class="divider my-0 text-xs text-base-content/30">{m['auth.ldap.section.search']()}</div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.search_base']()}</span></label>
          <input class="input input-sm font-mono text-xs" bind:value={config.searchBase} />
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.search_filter']()}</span></label>
          <input class="input input-sm font-mono text-xs" placeholder={"(uid={{username}})"} bind:value={config.searchFilter} />
          <label class="label py-0"><span class="label-text-alt text-xs text-base-content/40">{m['auth.ldap.placeholder.username']()}</span></label>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.username_attr']()}</span></label>
            <input class="input input-sm" bind:value={config.usernameAttribute} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.email_attr']()}</span></label>
            <input class="input input-sm" bind:value={config.emailAttribute} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['auth.ldap.ui.name_attr']()}</span></label>
            <input class="input input-sm" bind:value={config.nameAttribute} />
          </div>
        </div>
      </div>
    </div>

    <div class="flex gap-3">
      <button class="btn btn-outline btn-sm gap-2" onclick={testConnection} disabled={!config.url || testing}>
        {#if testing}<LoaderCircle size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
        {m['auth.ldap.btn.test']()}
      </button>
      <button class="btn btn-primary gap-2" onclick={save} disabled={saving}>
        {#if saving}<LoaderCircle size={15} class="animate-spin" />{:else}<Save size={15} />{/if}
        {m['common.save']()}
      </button>
    </div>
  {/if}
    </div>
</ExtensionPageShell>
