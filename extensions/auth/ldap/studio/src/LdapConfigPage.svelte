<script lang="ts">
  import { onMount } from 'svelte';
  import { ENGINE_URL } from '$lib/config.js';
  import { Server, Save, LoaderCircle, CheckCircle, XCircle, FlaskConical } from '@lucide/svelte';

  let config = $state({
    enabled: false,
    url: '',
    bindDN: '',
    bindPassword: '',
    searchBase: '',
    searchFilter: '(uid={{username}})',
    usernameAttribute: 'uid',
    emailAttribute: 'mail',
    nameAttribute: 'cn',
    tlsVerify: true,
  });

  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let error = $state('');
  let success = $state('');
  let testUsername = $state('');
  let testPassword = $state('');
  let testResult = $state<{ success: boolean; user?: any; error?: string } | null>(null);

  onMount(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/auth/ldap/config`, { credentials: 'include' });
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
      const res = await fetch(`${ENGINE_URL}/api/auth/ldap/config`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      success = 'LDAP configuration saved successfully.';
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  async function test() {
    if (!testUsername || !testPassword) return;
    testing = true;
    testResult = null;
    try {
      const res = await fetch(`${ENGINE_URL}/api/auth/ldap/test`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testUsername, password: testPassword }),
      });
      testResult = await res.json();
    } catch (e: any) {
      testResult = { success: false, error: e.message };
    } finally {
      testing = false;
    }
  }
</script>

<div class="mx-auto max-w-2xl space-y-6 p-6">
  <div class="flex items-center gap-3">
    <Server class="h-6 w-6 text-indigo-500" />
    <div>
      <h1 class="text-xl font-semibold">LDAP / Active Directory</h1>
      <p class="text-sm text-gray-500">Authenticate users via your organization's LDAP or AD server</p>
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

    <form onsubmit={(e) => { e.preventDefault(); save(); }} class="space-y-4">
      <!-- Enable toggle -->
      <div class="flex items-center justify-between rounded-lg border border-gray-200 p-3">
        <div>
          <p class="text-sm font-medium">Enable LDAP Authentication</p>
          <p class="text-xs text-gray-500">Allow users to sign in with LDAP credentials</p>
        </div>
        <input type="checkbox" bind:checked={config.enabled} class="h-4 w-4 rounded accent-indigo-600" />
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">LDAP URL <span class="text-red-500">*</span></label>
          <input bind:value={config.url} type="text" required
            placeholder="ldap://ldap.company.com:389"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
          <p class="mt-1 text-xs text-gray-400">Use ldaps:// for secure connections (port 636)</p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Bind DN <span class="text-red-500">*</span></label>
          <input bind:value={config.bindDN} type="text" required
            placeholder="cn=service-account,dc=company,dc=com"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Bind Password <span class="text-red-500">*</span></label>
          <input bind:value={config.bindPassword} type="password" required
            placeholder="Service account password"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Search Base <span class="text-red-500">*</span></label>
          <input bind:value={config.searchBase} type="text" required
            placeholder="ou=users,dc=company,dc=com"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Search Filter</label>
          <input bind:value={config.searchFilter} type="text"
            placeholder="(uid={{username}})"
            class="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm focus:border-indigo-400 focus:outline-none" />
          <p class="mt-1 text-xs text-gray-400">Use &#123;&#123;username&#125;&#125; as placeholder. AD example: (sAMAccountName=&#123;&#123;username&#125;&#125;)</p>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Username attr</label>
            <input bind:value={config.usernameAttribute} type="text" placeholder="uid"
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Email attr</label>
            <input bind:value={config.emailAttribute} type="text" placeholder="mail"
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Name attr</label>
            <input bind:value={config.nameAttribute} type="text" placeholder="cn"
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
          </div>
        </div>

        <div class="flex items-center gap-2">
          <input type="checkbox" bind:checked={config.tlsVerify} id="tlsVerify" class="h-4 w-4 accent-indigo-600" />
          <label for="tlsVerify" class="text-sm">Verify TLS certificate</label>
          <span class="text-xs text-gray-400">(disable for self-signed certs in dev)</span>
        </div>
      </div>

      <button type="submit" disabled={saving}
        class="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
        {#if saving}
          <LoaderCircle class="h-4 w-4 animate-spin" />
          Saving...
        {:else}
          <Save class="h-4 w-4" />
          Save Configuration
        {/if}
      </button>
    </form>

    <!-- Test connection -->
    <div class="rounded-lg border border-gray-200 p-4 space-y-3">
      <div class="flex items-center gap-2">
        <FlaskConical class="h-4 w-4 text-gray-500" />
        <h2 class="text-sm font-medium">Test Connection</h2>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <input bind:value={testUsername} type="text" placeholder="Test username"
          class="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
        <input bind:value={testPassword} type="password" placeholder="Test password"
          class="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
      </div>
      <button onclick={test} disabled={testing || !testUsername || !testPassword}
        class="flex items-center gap-2 rounded-lg border border-indigo-200 px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">
        {#if testing}
          <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
          Testing...
        {:else}
          <FlaskConical class="h-3.5 w-3.5" />
          Test
        {/if}
      </button>

      {#if testResult}
        <div class={`rounded-lg p-3 text-sm ${testResult.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {#if testResult.success}
            <p class="font-medium">Connection successful</p>
            <p>Email: {testResult.user?.email}</p>
            <p>Name: {testResult.user?.displayName}</p>
          {:else}
            <p class="font-medium">Connection failed</p>
            <p>{testResult.error}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
