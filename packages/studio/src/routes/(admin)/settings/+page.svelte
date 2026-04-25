<script lang="ts">
 import { onMount } from 'svelte';
 import { api, settingsApi } from '$lib/api.js';
 import { Globe, Palette, Mail, Shield, Save, LoaderCircle, Eye, EyeOff, Gauge } from '@lucide/svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';
 import { toast } from '$lib/stores/toast.svelte.js';

 let loading = $state(true);
 let saving = $state(false);
 let saved = $state(false);
 let tab = $state<'general' | 'branding' | 'smtp' | 'security' | 'rate_limiting'>('general');
 let showSmtpPass = $state(false);

 let s = $state({
 app_name: 'Zveltio',
 site_url: '',
 logo_url: '',
 primary_color: '#069494',
 smtp_host: '',
 smtp_port: 587,
 smtp_user: '',
 smtp_pass: '',
 smtp_from: '',
 smtp_secure: false,
 two_factor_enabled: false,
 session_expiry_hours: 24,
 api_rate_limit: 100,
 });

 // Rate limiting — per-tier configs from zv_rate_limit_configs
 let rlTiers = $state<Array<{ key_prefix: string; window_ms: number; max_requests: number; is_active: boolean; description: string }>>([]);
 let rlSaving = $state<string | null>(null);
 let rlResetting = $state(false);

 onMount(async () => {
 try {
 const data = await settingsApi.getAll();
 for (const [k, v] of Object.entries(data)) {
 if (k in s) (s as any)[k] = v;
 }
 } finally { loading = false; }
 loadRateLimiting();
 });

 async function loadRateLimiting() {
 try {
 const res = await api.get<{ rate_limits: any[] }>('/api/admin/rate-limits');
 if (Array.isArray(res?.rate_limits)) rlTiers = res.rate_limits;
 } catch {
 // table may not exist yet if migration hasn't run
 }
 }

 async function save() {
 saving = true; saved = false;
 try {
 await settingsApi.updateBulk(s);
 saved = true;
 toast.success('Settings saved successfully');
 setTimeout(() => (saved = false), 3000);
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Save failed');
 } finally { saving = false; }
 }

 async function saveTier(tier: typeof rlTiers[number]) {
 rlSaving = tier.key_prefix;
 try {
 await api.patch(`/api/admin/rate-limits/${tier.key_prefix}`, {
 window_ms: tier.window_ms,
 max_requests: tier.max_requests,
 is_active: tier.is_active,
 });
 toast.success(`${tier.key_prefix} limits saved`);
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Save failed');
 } finally { rlSaving = null; }
 }

 async function resetDefaults() {
 rlResetting = true;
 try {
 await api.post('/api/admin/rate-limits/reset', {});
 toast.success('Rate limits reset to defaults');
 await loadRateLimiting();
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Reset failed');
 } finally { rlResetting = false; }
 }

 const TABS = [
 { id: 'general', label: 'General', icon: Globe },
 { id: 'branding', label: 'Branding', icon: Palette },
 { id: 'smtp', label: 'SMTP', icon: Mail },
 { id: 'security', label: 'Security', icon: Shield },
 { id: 'rate_limiting', label: 'Rate Limiting', icon: Gauge },
 ] as const;
</script>

<div class="space-y-6">
 <PageHeader title="Settings" subtitle="Configure your Zveltio instance">
  {#if tab !== 'rate_limiting'}
  <button class="btn {saved ? 'btn-success' : 'btn-primary'} btn-sm" onclick={save} disabled={saving || loading}>
  {#if saving}<LoaderCircle size={16} class="animate-spin" />{:else}<Save size={16} />{/if}
  {saved ? '✓ Saved' : 'Save Settings'}
  </button>
  {:else}
  <button class="btn btn-ghost btn-sm" onclick={resetDefaults} disabled={rlResetting}>
  {#if rlResetting}<LoaderCircle size={16} class="animate-spin" />{/if}
  Reset Defaults
  </button>
  {/if}
 </PageHeader>

 <div class="tabs tabs-bordered">
 {#each TABS as t}
 <button class="tab gap-2 {tab === t.id ? 'tab-active' : ''}" onclick={() => (tab = t.id)}>
 <t.icon size={16} />{t.label}
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-16"><LoaderCircle size={32} class="animate-spin text-primary" /></div>
 {:else}
 <div class="card bg-base-200 max-w-2xl">
 <div class="card-body space-y-5">
 {#if tab === 'general'}
 <div class="form-control">
 <label class="label" for="setting-app-name"><span class="label-text font-medium">Application Name</span></label>
 <input id="setting-app-name" class="input" bind:value={s.app_name} placeholder="Zveltio" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-site-url">
 <span class="label-text font-medium">Site URL</span>
 <span class="label-text-alt text-base-content/50">Used in emails and webhooks</span>
 </label>
 <input id="setting-site-url" class="input font-mono" bind:value={s.site_url} placeholder="https://app.example.com" />
 </div>

 {:else if tab === 'branding'}
 <div class="form-control">
 <label class="label" for="setting-logo-url"><span class="label-text font-medium">Logo URL</span></label>
 <input id="setting-logo-url" class="input font-mono" bind:value={s.logo_url} placeholder="https://example.com/logo.svg" />
 {#if s.logo_url}
 <div class="mt-2 p-3 bg-base-300 rounded-lg inline-flex">
 <img src={s.logo_url} alt="Logo preview" class="h-12 object-contain" />
 </div>
 {/if}
 </div>
 <div class="form-control">
 <label class="label" for="setting-primary-color-text"><span class="label-text font-medium">Primary Color</span></label>
 <div class="flex gap-3 items-center">
 <input type="color" class="w-12 h-10 rounded cursor-pointer border border-base-300 bg-transparent" bind:value={s.primary_color} aria-label="Primary color picker" />
 <input id="setting-primary-color-text" class="input font-mono flex-1" bind:value={s.primary_color} placeholder="#069494" />
 </div>
 </div>

 {:else if tab === 'smtp'}
 <div class="alert alert-info text-sm py-2">
 <span>Configure SMTP to enable email notifications, invitations, and password resets.</span>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="setting-smtp-host"><span class="label-text font-medium">Host</span></label>
 <input id="setting-smtp-host" class="input font-mono" bind:value={s.smtp_host} placeholder="smtp.gmail.com" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-smtp-port"><span class="label-text font-medium">Port</span></label>
 <input id="setting-smtp-port" type="number" class="input" bind:value={s.smtp_port} placeholder="587" />
 </div>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="setting-smtp-user"><span class="label-text font-medium">Username</span></label>
 <input id="setting-smtp-user" class="input font-mono" bind:value={s.smtp_user} placeholder="user@example.com" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-smtp-pass"><span class="label-text font-medium">Password</span></label>
 <div class="relative">
 {#if showSmtpPass}
 <input id="setting-smtp-pass" class="input w-full pr-10 font-mono" bind:value={s.smtp_pass} />
 {:else}
 <input id="setting-smtp-pass" type="password" class="input w-full pr-10 font-mono" bind:value={s.smtp_pass} />
 {/if}
 <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs"
 onclick={() => (showSmtpPass = !showSmtpPass)}>
 {#if showSmtpPass}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
 </button>
 </div>
 </div>
 </div>
 <div class="form-control">
 <label class="label" for="setting-smtp-from"><span class="label-text font-medium">From Address</span></label>
 <input id="setting-smtp-from" class="input font-mono" bind:value={s.smtp_from} placeholder="noreply@example.com" />
 </div>
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-sm" bind:checked={s.smtp_secure} />
 <span class="label-text">Use TLS/SSL</span>
 </label>

 {:else if tab === 'security'}
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={s.two_factor_enabled} />
 <div>
 <p class="label-text font-medium">Enable Two-Factor Authentication</p>
 <p class="text-xs text-base-content/50">Users can optionally enable 2FA for their accounts</p>
 </div>
 </label>
 <div class="form-control">
 <label class="label" for="setting-session-expiry"><span class="label-text font-medium">Session Expiry (hours)</span></label>
 <input id="setting-session-expiry" type="number" class="input w-36" bind:value={s.session_expiry_hours} min="1" max="8760" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-rate-limit"><span class="label-text font-medium">API Rate Limit (requests/minute)</span></label>
 <input id="setting-rate-limit" type="number" class="input w-36" bind:value={s.api_rate_limit} min="1" max="10000" />
 </div>

 {:else if tab === 'rate_limiting'}
 <p class="text-sm text-base-content/60 mb-4">
 Configure request limits per tier. Changes apply within 60 seconds without restart.
 </p>

 {#if rlTiers.length === 0}
 <p class="text-sm text-base-content/40 text-center py-8">No rate limit configs found — run migrations first.</p>
 {:else}
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>Tier</th>
 <th>Window</th>
 <th>Max requests</th>
 <th>Active</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each rlTiers as tier}
 <tr>
 <td>
 <span class="font-mono font-semibold text-xs">{tier.key_prefix}</span>
 {#if tier.description}
 <p class="text-xs text-base-content/40 mt-0.5 max-w-45">{tier.description}</p>
 {/if}
 </td>
 <td>
 <div class="flex items-center gap-1">
 <input
 type="number"
 class="input input-sm input-bordered w-20 font-mono text-xs"
 bind:value={tier.window_ms}
 min="1000"
 max="3600000"
 step="1000"
 />
 <span class="text-xs text-base-content/50">ms</span>
 </div>
 </td>
 <td>
 <input
 type="number"
 class="input input-sm input-bordered w-24 font-mono text-xs"
 bind:value={tier.max_requests}
 min="1"
 max="100000"
 />
 </td>
 <td>
 <input
 type="checkbox"
 class="toggle toggle-xs toggle-success"
 bind:checked={tier.is_active}
 />
 </td>
 <td>
 <button
 class="btn btn-xs btn-primary"
 onclick={() => saveTier(tier)}
 disabled={rlSaving === tier.key_prefix}
 >
 {#if rlSaving === tier.key_prefix}
 <LoaderCircle size={12} class="animate-spin" />
 {:else}
 <Save size={12} />
 {/if}
 </button>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 {/if}

  {/if}
 </div>
 </div>
 {/if}
</div>
