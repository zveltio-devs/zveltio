<script lang="ts">
  import { onMount } from 'svelte';
  import { settingsApi } from '$lib/api.js';
  import { Save, Loader2 } from '@lucide/svelte';

  let settings = $state<Record<string, any>>({});
  let branding = $state({ company_name: '', primary_color: '#570df8', logo_url: '' });
  let smtp = $state({ host: '', port: 587, user: '', from_email: '', from_name: 'Zveltio' });
  let loading = $state(true);
  let saving = $state(false);
  let saved = $state(false);

  onMount(async () => {
    const all = await settingsApi.getAll();
    settings = all;
    if (all.branding) branding = { ...branding, ...all.branding };
    if (all.smtp) smtp = { ...smtp, ...all.smtp };
    loading = false;
  });

  async function save() {
    saving = true;
    try {
      await settingsApi.updateBulk({ branding, smtp });
      saved = true;
      setTimeout(() => (saved = false), 2000);
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-6 max-w-2xl">
  <div>
    <h1 class="text-2xl font-bold">Settings</h1>
    <p class="text-base-content/60 text-sm mt-1">Configure your Zveltio instance</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-12">
      <Loader2 size={32} class="animate-spin text-primary" />
    </div>
  {:else}
    <!-- Branding -->
    <div class="card bg-base-200">
      <div class="card-body">
        <h2 class="card-title text-base">Branding</h2>

        <div class="form-control">
          <label class="label" for="company_name">
            <span class="label-text">Company name</span>
          </label>
          <input
            id="company_name"
            type="text"
            bind:value={branding.company_name}
            class="input input-bordered"
          />
        </div>

        <div class="form-control">
          <label class="label" for="primary_color">
            <span class="label-text">Primary color</span>
          </label>
          <div class="flex gap-2">
            <input
              id="primary_color"
              type="color"
              bind:value={branding.primary_color}
              class="input input-bordered w-16 p-1"
            />
            <input
              type="text"
              bind:value={branding.primary_color}
              class="input input-bordered flex-1 font-mono"
            />
          </div>
        </div>

        <div class="form-control">
          <label class="label" for="logo_url">
            <span class="label-text">Logo URL</span>
          </label>
          <input
            id="logo_url"
            type="url"
            bind:value={branding.logo_url}
            placeholder="https://example.com/logo.png"
            class="input input-bordered"
          />
        </div>
      </div>
    </div>

    <!-- SMTP -->
    <div class="card bg-base-200">
      <div class="card-body">
        <h2 class="card-title text-base">Email (SMTP)</h2>

        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="smtp_host"><span class="label-text">Host</span></label>
            <input id="smtp_host" type="text" bind:value={smtp.host} class="input input-bordered" />
          </div>
          <div class="form-control">
            <label class="label" for="smtp_port"><span class="label-text">Port</span></label>
            <input id="smtp_port" type="number" bind:value={smtp.port} class="input input-bordered" />
          </div>
          <div class="form-control">
            <label class="label" for="smtp_user"><span class="label-text">User</span></label>
            <input id="smtp_user" type="text" bind:value={smtp.user} class="input input-bordered" />
          </div>
          <div class="form-control">
            <label class="label" for="from_email"><span class="label-text">From email</span></label>
            <input id="from_email" type="email" bind:value={smtp.from_email} class="input input-bordered" />
          </div>
        </div>
      </div>
    </div>

    <button class="btn btn-primary" onclick={save} disabled={saving}>
      {#if saving}
        <Loader2 size={16} class="animate-spin" />
      {:else if saved}
        ✓ Saved
      {:else}
        <Save size={16} />
        Save Settings
      {/if}
    </button>
  {/if}
</div>
