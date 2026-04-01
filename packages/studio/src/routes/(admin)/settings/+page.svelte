<script lang="ts">
 import { onMount } from 'svelte';
 import { api, settingsApi } from '$lib/api.js';
 import { Globe, Palette, Mail, Shield, Save, LoaderCircle, Eye, EyeOff, Gauge, Plus, Trash2 } from '@lucide/svelte';
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

 // Rate limiting state
 let rl = $state({
 enabled: true,
 default_ip_limit: 60,
 default_key_limit: 1000,
 collection_overrides: [] as Array<{ collection: string; limit: number }>,
 });
 let rlSaving = $state(false);
 let rlSaved = $state(false);

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
 const res = await api.get<{ key: string; value: any }>('/api/settings/rate_limiting');
 const data = res?.value;
 if (data && typeof data === 'object') {
 if ('enabled' in data) rl.enabled = data.enabled;
 if ('default_ip_limit' in data) rl.default_ip_limit = data.default_ip_limit;
 if ('default_key_limit' in data) rl.default_key_limit = data.default_key_limit;
 if (Array.isArray(data.collection_overrides)) rl.collection_overrides = data.collection_overrides;
 }
 } catch {
 // Not yet configured — use defaults silently
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

 async function saveRateLimiting() {
 rlSaving = true; rlSaved = false;
 try {
 await api.put('/api/settings/rate_limiting', { value: { ...rl } });
 rlSaved = true;
 toast.success('Rate limiting settings saved');
 setTimeout(() => (rlSaved = false), 3000);
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Save failed');
 } finally { rlSaving = false; }
 }

 function addCollectionOverride() {
 rl.collection_overrides = [...rl.collection_overrides, { collection: '', limit: 100 }];
 }

 function removeCollectionOverride(i: number) {
 rl.collection_overrides = rl.collection_overrides.filter((_, idx) => idx !== i);
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
  <button class="btn {rlSaved ? 'btn-success' : 'btn-primary'} btn-sm" onclick={saveRateLimiting} disabled={rlSaving}>
  {#if rlSaving}<LoaderCircle size={16} class="animate-spin" />{:else}<Save size={16} />{/if}
  {rlSaved ? '✓ Saved' : 'Save'}
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
 <!-- Global toggle -->
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={rl.enabled} />
 <div>
 <p class="label-text font-medium">Enable Rate Limiting</p>
 <p class="text-xs text-base-content/50">Apply request limits globally across all API endpoints</p>
 </div>
 </label>

 <div class="divider my-2"></div>

 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="rl-ip-limit">
 <span class="label-text font-medium">Default IP limit</span>
 <span class="label-text-alt text-base-content/50">req / minute</span>
 </label>
 <input
 id="rl-ip-limit"
 type="number"
 class="input"
 bind:value={rl.default_ip_limit}
 min="1"
 max="100000"
 disabled={!rl.enabled}
 />
 </div>
 <div class="form-control">
 <label class="label" for="rl-key-limit">
 <span class="label-text font-medium">Default API key limit</span>
 <span class="label-text-alt text-base-content/50">req / hour</span>
 </label>
 <input
 id="rl-key-limit"
 type="number"
 class="input"
 bind:value={rl.default_key_limit}
 min="1"
 max="1000000"
 disabled={!rl.enabled}
 />
 </div>
 </div>

 <div class="divider my-2"></div>

 <!-- Per-collection overrides -->
 <div>
 <div class="flex items-center justify-between mb-3">
 <div>
 <p class="font-medium text-sm">Per-collection overrides</p>
 <p class="text-xs text-base-content/50">Override the default rate limit for specific collections</p>
 </div>
 <button
 class="btn btn-xs btn-ghost gap-1"
 onclick={addCollectionOverride}
 disabled={!rl.enabled}
 >
 <Plus size={12} /> Add
 </button>
 </div>

 {#if rl.collection_overrides.length === 0}
 <p class="text-xs text-base-content/40 text-center py-4 border border-dashed border-base-300 rounded-lg">
 No overrides — all collections use the default limit
 </p>
 {:else}
 <div class="space-y-2">
 {#each rl.collection_overrides as override, i}
 <div class="flex gap-2 items-center">
 <input
 class="input input-sm flex-1"
 type="text"
 placeholder="collection_name"
 bind:value={override.collection}
 disabled={!rl.enabled}
 />
 <input
 class="input input-sm w-28"
 type="number"
 placeholder="1000"
 bind:value={override.limit}
 min="1"
 disabled={!rl.enabled}
 />
 <span class="text-xs text-base-content/50 shrink-0">req/hr</span>
 <button
 class="btn btn-ghost btn-xs text-error shrink-0"
 onclick={() => removeCollectionOverride(i)}
 >
 <Trash2 size={13} />
 </button>
 </div>
 {/each}
 </div>
 {/if}
 </div>

  {/if}
 </div>
 </div>
 {/if}
</div>
