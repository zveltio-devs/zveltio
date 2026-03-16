<script lang="ts">
 import { onMount } from 'svelte';
 import { settingsApi } from '$lib/api.js';
 import { Globe, Palette, Mail, Shield, Save, Loader2, Eye, EyeOff } from '@lucide/svelte';

 let loading = $state(true);
 let saving = $state(false);
 let saved = $state(false);
 let tab = $state<'general' | 'branding' | 'smtp' | 'security'>('general');
 let showSmtpPass = $state(false);

 let s = $state({
 app_name: 'Zveltio',
 site_url: '',
 logo_url: '',
 primary_color: '#5BBFBA',
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

 onMount(async () => {
 try {
 const data = await settingsApi.getAll();
 for (const [k, v] of Object.entries(data)) {
 if (k in s) (s as any)[k] = v;
 }
 } finally { loading = false; }
 });

 async function save() {
 saving = true; saved = false;
 try {
 await settingsApi.updateBulk(s);
 saved = true;
 setTimeout(() => (saved = false), 3000);
 } catch (err) {
 alert(err instanceof Error ? err.message : 'Save failed');
 } finally { saving = false; }
 }

 const TABS = [
 { id: 'general', label: 'General', icon: Globe },
 { id: 'branding', label: 'Branding', icon: Palette },
 { id: 'smtp', label: 'SMTP', icon: Mail },
 { id: 'security', label: 'Security', icon: Shield },
 ] as const;
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Settings</h1>
 <p class="text-base-content/60 text-sm mt-1">Platform configuration</p>
 </div>
 <button class="btn {saved ? 'btn-success' : 'btn-primary'} btn-sm" onclick={save} disabled={saving || loading}>
 {#if saving}<Loader2 size={16} class="animate-spin" />{:else}<Save size={16} />{/if}
 {saved ? '✓ Saved' : 'Save Settings'}
 </button>
 </div>

 <div class="tabs tabs-bordered">
 {#each TABS as t}
 <button class="tab gap-2 {tab === t.id ? 'tab-active' : ''}" onclick={() => (tab = t.id)}>
 <t.icon size={16} />{t.label}
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-16"><Loader2 size={32} class="animate-spin text-primary" /></div>
 {:else}
 <div class="card bg-base-200 max-w-2xl">
 <div class="card-body space-y-5">
 {#if tab === 'general'}
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Application Name</span></label>
 <input class="input" bind:value={s.app_name} placeholder="Zveltio" />
 </div>
 <div class="form-control">
 <label class="label">
 <span class="label-text font-medium">Site URL</span>
 <span class="label-text-alt text-base-content/50">Used in emails and webhooks</span>
 </label>
 <input class="input font-mono" bind:value={s.site_url} placeholder="https://app.example.com" />
 </div>

 {:else if tab === 'branding'}
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Logo URL</span></label>
 <input class="input font-mono" bind:value={s.logo_url} placeholder="https://example.com/logo.svg" />
 {#if s.logo_url}
 <div class="mt-2 p-3 bg-base-300 rounded-lg inline-flex">
 <img src={s.logo_url} alt="Logo preview" class="h-12 object-contain" />
 </div>
 {/if}
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Primary Color</span></label>
 <div class="flex gap-3 items-center">
 <input type="color" class="w-12 h-10 rounded cursor-pointer border border-base-300 bg-transparent" bind:value={s.primary_color} />
 <input class="input font-mono flex-1" bind:value={s.primary_color} placeholder="#5BBFBA" />
 </div>
 </div>

 {:else if tab === 'smtp'}
 <div class="alert alert-info text-sm py-2">
 <span>Configure SMTP to enable email notifications, invitations, and password resets.</span>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Host</span></label>
 <input class="input font-mono" bind:value={s.smtp_host} placeholder="smtp.gmail.com" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Port</span></label>
 <input type="number" class="input" bind:value={s.smtp_port} placeholder="587" />
 </div>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Username</span></label>
 <input class="input font-mono" bind:value={s.smtp_user} placeholder="user@example.com" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Password</span></label>
 <div class="relative">
 {#if showSmtpPass}
 <input class="input w-full pr-10 font-mono" bind:value={s.smtp_pass} />
 {:else}
 <input type="password" class="input w-full pr-10 font-mono" bind:value={s.smtp_pass} />
 {/if}
 <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs"
 onclick={() => (showSmtpPass = !showSmtpPass)}>
 {#if showSmtpPass}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
 </button>
 </div>
 </div>
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">From Address</span></label>
 <input class="input font-mono" bind:value={s.smtp_from} placeholder="noreply@example.com" />
 </div>
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-sm" bind:checked={s.smtp_secure} />
 <span class="label-text">Use TLS/SSL</span>
 </label>

 {:else}
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={s.two_factor_enabled} />
 <div>
 <p class="label-text font-medium">Enable Two-Factor Authentication</p>
 <p class="text-xs text-base-content/50">Users can optionally enable 2FA for their accounts</p>
 </div>
 </label>
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Session Expiry (hours)</span></label>
 <input type="number" class="input w-36" bind:value={s.session_expiry_hours} min="1" max="8760" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">API Rate Limit (requests/minute)</span></label>
 <input type="number" class="input w-36" bind:value={s.api_rate_limit} min="1" max="10000" />
 </div>
 {/if}
 </div>
 </div>
 {/if}
</div>
