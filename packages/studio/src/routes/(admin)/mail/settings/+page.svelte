<script lang="ts">
  import { ENGINE_URL } from '$lib/config.js';
  import { Settings, Save, RefreshCw, Shield, Mail } from '@lucide/svelte';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state(false);

  let config = $state<Record<string, any>>({
    enabled: true,
    max_accounts_per_user: 5,
    max_attachment_size_mb: 25,
    allowed_domains: [],
    blocked_domains: [],
    require_admin_approval: false,
    auto_collect_contacts: true,
    imap_idle_enabled: true,
    sieve_enabled: true,
    pgp_enabled: true,
    oauth2_gmail_client_id: '',
    oauth2_gmail_client_secret: '',
    oauth2_outlook_client_id: '',
    oauth2_outlook_client_secret: '',
    max_messages_sync: 1000,
    sync_interval_minutes: 5,
    trash_auto_delete_days: 30,
  });

  let allowedDomainsText = $state('');
  let blockedDomainsText = $state('');

  async function loadConfig() {
    loading = true; error = '';
    try {
      const res = await fetch(`${ENGINE_URL}/api/mail/admin/config`, { credentials: 'include' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      config = { ...config, ...data.config };
      allowedDomainsText = (config.allowed_domains || []).join('\n');
      blockedDomainsText = (config.blocked_domains || []).join('\n');
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function saveConfig() {
    saving = true; error = ''; success = false;
    try {
      const payload = {
        ...config,
        allowed_domains: allowedDomainsText.split('\n').map((s: string) => s.trim()).filter(Boolean),
        blocked_domains: blockedDomainsText.split('\n').map((s: string) => s.trim()).filter(Boolean),
      };
      const res = await fetch(`${ENGINE_URL}/api/mail/admin/config`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `${res.status}`);
      }
      success = true;
      setTimeout(() => success = false, 3000);
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  $effect(() => { loadConfig(); });
</script>

<div class="p-6 max-w-3xl mx-auto space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold flex items-center gap-2"><Mail class="w-6 h-6 text-primary"/> Mail Settings</h1>
      <p class="text-base-content/60 mt-1">Global configuration for the Zveltio Mail Client (admin only).</p>
    </div>
    <button class="btn btn-primary gap-2" onclick={saveConfig} disabled={saving || loading}>
      {#if saving}<span class="loading loading-spinner loading-sm"></span>{:else}<Save class="w-4 h-4"/>{/if}
      Save Settings
    </button>
  </div>

  {#if error}<div class="alert alert-error text-sm">{error}</div>{/if}
  {#if success}<div class="alert alert-success text-sm">Settings saved successfully.</div>{/if}

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else}
    <!-- ─── General ─── -->
    <div class="card bg-base-200 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title text-base">General</h2>

        <div class="flex items-center justify-between">
          <div>
            <p class="font-medium text-sm">Mail Client Enabled</p>
            <p class="text-xs text-base-content/50">Allow users to access the mail client feature</p>
          </div>
          <input type="checkbox" class="toggle toggle-primary" bind:checked={config.enabled}/>
        </div>

        <div class="divider my-0"></div>

        <div class="grid grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label" for="mail-max-accounts"><span class="label-text text-sm">Max accounts per user</span></label>
            <input id="mail-max-accounts" class="input input-bordered input-sm" type="number" min="1" max="50" bind:value={config.max_accounts_per_user}/>
          </div>
          <div class="form-control">
            <label class="label" for="mail-max-attach"><span class="label-text text-sm">Max attachment size (MB)</span></label>
            <input id="mail-max-attach" class="input input-bordered input-sm" type="number" min="1" max="100" bind:value={config.max_attachment_size_mb}/>
          </div>
          <div class="form-control">
            <label class="label" for="mail-max-sync"><span class="label-text text-sm">Max messages to sync per account</span></label>
            <input id="mail-max-sync" class="input input-bordered input-sm" type="number" min="50" max="10000" bind:value={config.max_messages_sync}/>
          </div>
          <div class="form-control">
            <label class="label" for="mail-sync-interval"><span class="label-text text-sm">Sync interval (minutes)</span></label>
            <input id="mail-sync-interval" class="input input-bordered input-sm" type="number" min="1" max="60" bind:value={config.sync_interval_minutes}/>
          </div>
          <div class="form-control">
            <label class="label" for="mail-trash-days"><span class="label-text text-sm">Trash auto-delete (days, 0 = never)</span></label>
            <input id="mail-trash-days" class="input input-bordered input-sm" type="number" min="0" max="365" bind:value={config.trash_auto_delete_days}/>
          </div>
        </div>
      </div>
    </div>

    <!-- ─── Features ─── -->
    <div class="card bg-base-200 shadow">
      <div class="card-body gap-3">
        <h2 class="card-title text-base">Features</h2>

        {#each [
          { key: 'auto_collect_contacts', label: 'Auto-collect contacts', desc: 'Automatically add recipients to address book when sending' },
          { key: 'imap_idle_enabled', label: 'IMAP IDLE (push)', desc: 'Real-time push notifications for new messages (when supported by server)' },
          { key: 'sieve_enabled', label: 'Sieve Filters', desc: 'Server-side mail filtering rules (requires ManageSieve support)' },
          { key: 'pgp_enabled', label: 'PGP Encryption', desc: 'Allow users to encrypt/sign messages with PGP keys' },
          { key: 'require_admin_approval', label: 'Require admin approval', desc: 'New mail accounts must be approved by an admin before syncing' },
        ] as item}
          <div class="flex items-center justify-between py-1">
            <div>
              <p class="font-medium text-sm">{item.label}</p>
              <p class="text-xs text-base-content/50">{item.desc}</p>
            </div>
            <input type="checkbox" class="toggle toggle-sm" bind:checked={config[item.key]}/>
          </div>
        {/each}
      </div>
    </div>

    <!-- ─── Domain restrictions ─── -->
    <div class="card bg-base-200 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title text-base flex items-center gap-2"><Shield class="w-4 h-4"/> Domain Restrictions</h2>

        <div class="grid grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label" for="mail-allowed-domains">
              <span class="label-text text-sm">Allowed domains</span>
              <span class="label-text-alt text-xs">(one per line, empty = all allowed)</span>
            </label>
            <textarea id="mail-allowed-domains" class="textarea textarea-bordered min-h-24 font-mono text-xs"
              bind:value={allowedDomainsText}
              placeholder="gmail.com&#10;company.com"></textarea>
          </div>
          <div class="form-control">
            <label class="label" for="mail-blocked-domains">
              <span class="label-text text-sm">Blocked domains</span>
              <span class="label-text-alt text-xs">(one per line)</span>
            </label>
            <textarea id="mail-blocked-domains" class="textarea textarea-bordered min-h-24 font-mono text-xs"
              bind:value={blockedDomainsText}
              placeholder="spam.com&#10;tempmail.com"></textarea>
          </div>
        </div>
      </div>
    </div>

    <!-- ─── OAuth2 ─── -->
    <div class="card bg-base-200 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title text-base">OAuth2 (Gmail / Outlook)</h2>
        <p class="text-sm text-base-content/60">Configure OAuth2 app credentials for one-click Gmail and Outlook account setup.</p>

        <div class="grid grid-cols-2 gap-3">
          <div class="col-span-2 font-semibold text-sm text-base-content/70">Gmail</div>
          <div class="form-control">
            <div class="label py-1"><span class="label-text text-sm">Client ID</span></div>
            <input class="input input-bordered input-sm" bind:value={config.oauth2_gmail_client_id} placeholder="xxx.apps.googleusercontent.com"/>
          </div>
          <div class="form-control">
            <div class="label py-1"><span class="label-text text-sm">Client Secret</span></div>
            <input class="input input-bordered input-sm" type="password" bind:value={config.oauth2_gmail_client_secret}/>
          </div>

          <div class="col-span-2 font-semibold text-sm text-base-content/70 mt-2">Outlook / Microsoft 365</div>
          <div class="form-control">
            <div class="label py-1"><span class="label-text text-sm">Client ID</span></div>
            <input class="input input-bordered input-sm" bind:value={config.oauth2_outlook_client_id} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
          </div>
          <div class="form-control">
            <div class="label py-1"><span class="label-text text-sm">Client Secret</span></div>
            <input class="input input-bordered input-sm" type="password" bind:value={config.oauth2_outlook_client_secret}/>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
