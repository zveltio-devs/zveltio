<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Save, LoaderCircle, Play } from '@lucide/svelte';

  type LDAPConfig = {
    enabled: boolean; url: string; bindDN: string; bindPassword: string;
    searchBase: string; searchFilter: string; usernameAttribute: string;
    emailAttribute: string; nameAttribute: string; tlsVerify: boolean;
  };

  let config = $state<LDAPConfig>({
    enabled: false, url: 'ldap://ldap.example.com:389', bindDN: 'cn=admin,dc=example,dc=com',
    bindPassword: '', searchBase: 'dc=example,dc=com', searchFilter: '(uid={{username}})',
    usernameAttribute: 'uid', emailAttribute: 'mail', nameAttribute: 'cn', tlsVerify: true,
  });
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);

  onMount(async () => {
    try {
      const r = await api.get<{ config: LDAPConfig | null }>('/api/auth/ldap/config');
      if (r.config) config = { ...config, ...r.config };
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load LDAP config');
    } finally {
      loading = false;
    }
  });

  async function save() {
    saving = true;
    try {
      await api.post('/api/auth/ldap/config', config);
      toast.success('LDAP configuration saved.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Error saving config');
    } finally {
      saving = false;
    }
  }

  async function testConnection() {
    testing = true;
    try {
      await api.post('/api/auth/ldap/test', config);
      toast.success('Connection successful!');
    } catch (e: any) {
      toast.error(e?.message ?? 'Connection failed');
    } finally {
      testing = false;
    }
  }
</script>

<div class="max-w-2xl space-y-6">
  <div>
    <h1 class="text-xl font-semibold">LDAP / Active Directory</h1>
    <p class="text-sm text-base-content/50">Connect your LDAP server or Active Directory for user authentication</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-4">

        <div class="flex items-center gap-3">
          <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={config.enabled} />
          <span class="text-sm">Enable LDAP Authentication</span>
        </div>

        <div class="divider my-0 text-xs text-base-content/30">Server Connection</div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">LDAP URL *</span></label>
          <input class="input input-sm font-mono text-xs" placeholder="ldap://ldap.example.com:389" bind:value={config.url} />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Bind DN</span></label>
            <input class="input input-sm font-mono text-xs" bind:value={config.bindDN} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Bind Password</span></label>
            <input class="input input-sm" type="password" bind:value={config.bindPassword} />
          </div>
        </div>

        <div class="form-control flex-row items-center gap-3">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={config.tlsVerify} />
          <label class="label-text text-xs cursor-pointer">Verify TLS certificate</label>
        </div>

        <div class="divider my-0 text-xs text-base-content/30">Search Settings</div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Search Base</span></label>
          <input class="input input-sm font-mono text-xs" bind:value={config.searchBase} />
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Search Filter</span></label>
          <input class="input input-sm font-mono text-xs" placeholder={"(uid={{username}})"} bind:value={config.searchFilter} />
          <label class="label py-0"><span class="label-text-alt text-xs text-base-content/40">Use {`{{username}}`} as placeholder for the login value</span></label>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Username Attr</span></label>
            <input class="input input-sm" bind:value={config.usernameAttribute} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Email Attr</span></label>
            <input class="input input-sm" bind:value={config.emailAttribute} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Name Attr</span></label>
            <input class="input input-sm" bind:value={config.nameAttribute} />
          </div>
        </div>
      </div>
    </div>

    <div class="flex gap-3">
      <button class="btn btn-outline btn-sm gap-2" onclick={testConnection} disabled={!config.url || testing}>
        {#if testing}<LoaderCircle size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
        Test Connection
      </button>
      <button class="btn btn-primary gap-2" onclick={save} disabled={saving}>
        {#if saving}<LoaderCircle size={15} class="animate-spin" />{:else}<Save size={15} />{/if}
        Save
      </button>
    </div>
  {/if}
</div>
