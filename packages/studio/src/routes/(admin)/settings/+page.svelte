<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api, settingsApi } from '$lib/api.js';
import {
  Globe,
  Palette,
  Mail,
  Shield,
  Save,
  LoaderCircle,
  Eye,
  EyeOff,
  Gauge,
} from '@lucide/svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import { toast } from '$lib/stores/toast.svelte.js';
import Slot from '$lib/components/common/Slot.svelte';
import { auth } from '$lib/auth.svelte.js';

let loading = $state(true);
let saving = $state(false);
let saved = $state(false);
let loadError = $state('');
let rlError = $state('');
let tab = $state<'general' | 'branding' | 'smtp' | 'security' | 'rate_limiting'>('general');
let showSmtpPass = $state(false);

let s = $state({
  app_name: 'Zveltio',
  site_url: '',
  logo_url: '',
  primary_color: '#4F46E5',
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  smtp_secure: false,
  two_factor_enabled: false,
  registration_enabled: false,
  session_expiry_hours: 24,
  api_rate_limit: 100,
  // Regional — read by $lib/stores/format.svelte.ts for all date display.
  language: '',
  timezone: '',
  date_format: '',
});

// Rate limiting — per-tier configs from zv_rate_limit_configs
let rlTiers = $state<
  Array<{
    key_prefix: string;
    window_ms: number;
    max_requests: number;
    is_active: boolean;
    description: string;
  }>
>([]);
let rlSaving = $state<string | null>(null);
let rlResetting = $state(false);
// A per-tenant limit has no seeded row until one is added (PATCH creates it).
let rlTierNames = $state<string[]>([]);
let newTenantLimit = $state({ tier: 'api', tenant: '', window_ms: 60000, max_requests: 1000 });

onMount(async () => {
  try {
    const data = await settingsApi.getAll();
    for (const [k, v] of Object.entries(data)) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      if (k in s) (s as any)[k] = v;
    }
    loadError = '';
  } catch (err) {
    // A failed load used to leave the form holding its DECLARED DEFAULTS —
    // app_name 'Zveltio', registration off, a 24-hour session, empty locale and
    // timezone — and nothing said so. The next Save wrote all of that over the
    // instance's real configuration. So the failure is shown, and Save is held
    // shut until the settings have actually been read.
    loadError = err instanceof Error ? err.message : m['common.loadFailed']();
    toast.error(loadError);
  } finally {
    loading = false;
  }
  loadRateLimiting();
});

async function loadRateLimiting() {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const res = await api.get<{ rate_limits: any[]; tiers?: string[] }>('/api/admin/rate-limits');
    if (Array.isArray(res?.rate_limits)) rlTiers = res.rate_limits;
    rlTierNames = res?.tiers ?? [];
  } catch (err) {
    // A 403 or a 500 read exactly like the pre-migration case — the tier table
    // came back empty and the tab said "no rate limits configured", which is
    // also what a working instance with none looks like.
    rlError = err instanceof Error ? err.message : m['common.loadFailed']();
  }
}

async function save() {
  saving = true;
  saved = false;
  try {
    await settingsApi.updateBulk(s);
    saved = true;
    toast.success(m['settings.saved']());
    setTimeout(() => (saved = false), 3000);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['common.saveFailed']());
  } finally {
    saving = false;
  }
}

async function saveTier(tier: (typeof rlTiers)[number]) {
  rlSaving = tier.key_prefix;
  try {
    await api.patch(`/api/admin/rate-limits/${tier.key_prefix}`, {
      window_ms: tier.window_ms,
      max_requests: tier.max_requests,
      is_active: tier.is_active,
    });
    toast.success(m['settings.tierSaved']({ tier: tier.key_prefix }));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['common.saveFailed']());
  } finally {
    rlSaving = null;
  }
}

async function addTenantLimit() {
  const tenant = newTenantLimit.tenant.trim();
  const key = tenant ? `tenant:${newTenantLimit.tier}:${tenant}` : `tenant:${newTenantLimit.tier}`;
  rlSaving = key;
  try {
    await api.patch(`/api/admin/rate-limits/${key}`, {
      window_ms: newTenantLimit.window_ms,
      max_requests: newTenantLimit.max_requests,
      is_active: true,
    });
    toast.success(m['settings.tierSaved']({ tier: key }));
    newTenantLimit.tenant = '';
    await loadRateLimiting();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['common.saveFailed']());
  } finally {
    rlSaving = null;
  }
}

function resetDefaults() {
  // Every tier back to its shipped values in one click, with no question asked —
  // the only unguarded destructive action on this screen.
  confirmState = {
    open: true,
    title: m['settings.resetDefaultsTitle'](),
    message: m['settings.resetDefaultsMsg'](),
    confirmLabel: m['settings.resetDefaults'](),
    onconfirm: () => {
      confirmState.open = false;
      doResetDefaults();
    },
  };
}

async function doResetDefaults() {
  rlResetting = true;
  try {
    await api.post('/api/admin/rate-limits/reset', {});
    toast.success(m['settings.rateLimitsReset']());
    await loadRateLimiting();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['common.resetFailed']());
  } finally {
    rlResetting = false;
  }
}

const TABS = [
  { id: 'general', label: () => m['settings.tab.general'](), icon: Globe },
  { id: 'branding', label: () => m['settings.tab.branding'](), icon: Palette },
  { id: 'smtp', label: () => m['settings.tab.smtp'](), icon: Mail },
  { id: 'security', label: () => m['settings.tab.security'](), icon: Shield },
  { id: 'rate_limiting', label: () => m['settings.tab.rateLimiting'](), icon: Gauge },
] as const;

let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });
</script>

<div class="space-y-6">
 <PageHeader title={m['nav.settings']()} subtitle={m['settings.subtitle']()}>
  {#if tab !== 'rate_limiting'}
  <button class="btn {saved ? 'btn-success' : 'btn-primary'} btn-sm" onclick={save} disabled={saving || loading || !!loadError}>
  {#if saving}<LoaderCircle size={16} class="animate-spin" />{:else}<Save size={16} />{/if}
  {saved ? m['settings.savedLabel']() : m['settings.saveSettings']()}
  </button>
  {:else}
  <button class="btn btn-ghost btn-sm" onclick={resetDefaults} disabled={rlResetting}>
  {#if rlResetting}<LoaderCircle size={16} class="animate-spin" />{/if}
  {m['settings.resetDefaults']()}
  </button>
  {/if}
 </PageHeader>

 <div class="tabs tabs-bordered">
 {#each TABS as t}
 <button class="tab gap-2 {tab === t.id ? 'tab-active' : ''}" onclick={() => (tab = t.id)}>
 <t.icon size={16} />{t.label()}
 </button>
 {/each}
 <!-- Storage config lives on its own route (its own driver/probe state). -->
 <a class="tab gap-2" href="/admin/settings/storage">{m['nav.storage']()}</a>
 <!-- S3-03: settings.tabs slot — extensions contribute custom tab buttons here.
      Contributions are rendered after the core tabs. -->
 <Slot name="settings.tabs" ctx={{ user: auth.user, activeTab: tab }} />
 </div>

 {#if loading}
 <div class="flex justify-center py-16"><LoaderCircle size={32} class="animate-spin text-primary" /></div>
 {:else if loadError}
 <div class="alert alert-error max-w-2xl">
 <span>{m['settings.loadFailedKeepSafe']({ error: loadError })}</span>
 <button class="btn btn-sm btn-ghost" onclick={() => location.reload()}>{m['common.retry']()}</button>
 </div>
 {:else}
 <div class="card bg-base-100 max-w-2xl">
 <div class="card-body space-y-4">
 {#if tab === 'general'}
 <div class="form-control">
 <label class="label" for="setting-app-name"><span class="label-text font-medium">{m['settings.appName']()}</span></label>
 <input id="setting-app-name" class="input" bind:value={s.app_name} placeholder="Zveltio" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-site-url">
 <span class="label-text font-medium">{m['settings.siteUrl']()}</span>
 <span class="label-text-alt text-base-content/65">{m['settings.siteUrlHint']()}</span>
 </label>
 <input id="setting-site-url" class="input font-mono" bind:value={s.site_url} placeholder="https://app.example.com" />
 </div>
 <div class="divider text-xs opacity-50">{m['settings.regional']()}</div>
 <p class="text-xs text-base-content/65 -mt-2 mb-1">{m['settings.dateFormatHint']()}</p>
 <div class="form-control">
 <label class="label" for="setting-language">
 <span class="label-text font-medium">{m['settings.locale']()}</span>
 <span class="label-text-alt text-base-content/65">{m['settings.localeHint']()}</span>
 </label>
 <input id="setting-language" class="input font-mono w-48" bind:value={s.language} placeholder="ro" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-timezone">
 <span class="label-text font-medium">{m['settings.timezone']()}</span>
 <span class="label-text-alt text-base-content/65">{m['settings.timezoneHint']()}</span>
 </label>
 <input id="setting-timezone" class="input font-mono w-64" bind:value={s.timezone} placeholder="Europe/Bucharest" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-date-format"><span class="label-text font-medium">{m['settings.dateFormat']()}</span></label>
 <select id="setting-date-format" class="select w-48" bind:value={s.date_format}>
 <option value="">{m['settings.localeDefault']()}</option>
 <option value="iso">ISO — 2026-07-17</option>
 <option value="eu">EU — 17/07/2026</option>
 <option value="us">US — 07/17/2026</option>
 </select>
 </div>

 {:else if tab === 'branding'}
 <div class="form-control">
 <label class="label" for="setting-logo-url"><span class="label-text font-medium">{m['settings.logoUrl']()}</span></label>
 <input id="setting-logo-url" class="input font-mono" bind:value={s.logo_url} placeholder="https://example.com/logo.svg" />
 {#if s.logo_url}
 <div class="mt-2 p-3 bg-base-300 rounded-lg inline-flex">
 <img src={s.logo_url} alt={m['settings.logoPreview']()} class="h-12 object-contain" />
 </div>
 {/if}
 </div>
 <div class="form-control">
 <label class="label" for="setting-primary-color-text"><span class="label-text font-medium">{m['settings.primaryColor']()}</span></label>
 <div class="flex gap-3 items-center">
 <input type="color" class="w-12 h-10 rounded cursor-pointer border border-base-300 bg-transparent" bind:value={s.primary_color} aria-label={m['settings.primaryColorPicker']()} />
 <input id="setting-primary-color-text" class="input font-mono flex-1" bind:value={s.primary_color} placeholder="#4F46E5" />
 </div>
 </div>

 {:else if tab === 'smtp'}
 <div class="alert alert-info text-sm py-2">
 <span>{m['settings.smtpHint']()}</span>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="setting-smtp-host"><span class="label-text font-medium">{m['common.col.host']()}</span></label>
 <input id="setting-smtp-host" class="input font-mono" bind:value={s.smtp_host} placeholder="smtp.gmail.com" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-smtp-port"><span class="label-text font-medium">{m['common.col.port']()}</span></label>
 <input id="setting-smtp-port" type="number" class="input" bind:value={s.smtp_port} placeholder="587" />
 </div>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="setting-smtp-user"><span class="label-text font-medium">{m['common.col.username']()}</span></label>
 <input id="setting-smtp-user" class="input font-mono" bind:value={s.smtp_user} placeholder="user@example.com" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-smtp-pass"><span class="label-text font-medium">{m['auth.password']()}</span></label>
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
 <label class="label" for="setting-smtp-from"><span class="label-text font-medium">{m['settings.fromAddress']()}</span></label>
 <input id="setting-smtp-from" class="input font-mono" bind:value={s.smtp_from} placeholder="noreply@example.com" />
 </div>
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-sm" bind:checked={s.smtp_secure} />
 <span class="label-text">{m['settings.useTls']()}</span>
 </label>

 {:else if tab === 'security'}
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={s.registration_enabled} />
 <div>
 <p class="label-text font-medium">{m['settings.allowSignup']()}</p>
 <p class="text-xs text-base-content/65">{m['settings.signupHint']()}</p>
 </div>
 </label>
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={s.two_factor_enabled} />
 <div>
 <p class="label-text font-medium">{m['settings.enable2fa']()}</p>
 <p class="text-xs text-base-content/65">{m['settings.enable2faHint']()}</p>
 </div>
 </label>
 <div class="form-control">
 <label class="label" for="setting-session-expiry"><span class="label-text font-medium">{m['settings.sessionExpiry']()}</span></label>
 <input id="setting-session-expiry" type="number" class="input w-36" bind:value={s.session_expiry_hours} min="1" max="8760" />
 </div>
 <div class="form-control">
 <label class="label" for="setting-rate-limit"><span class="label-text font-medium">{m['settings.rateLimit']()}</span></label>
 <input id="setting-rate-limit" type="number" class="input w-36" bind:value={s.api_rate_limit} min="1" max="10000" />
 </div>

 {:else if tab === 'rate_limiting'}
 <p class="text-sm text-base-content/65 mb-4">
 {m['settings.rateLimitIntro']()}
 </p>

 {#if rlError}
 <div class="alert alert-error text-sm"><span>{rlError}</span></div>
 {:else if rlTiers.length === 0}
 <p class="text-sm text-base-content/65 text-center py-8">{m['settings.noRateLimits']()}</p>
 {:else}
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>{m['settings.tier']()}</th>
 <th>{m['settings.window']()}</th>
 <th>{m['settings.maxRequests']()}</th>
 <th>{m['common.col.active']()}</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each rlTiers as tier}
 <tr>
 <td>
 <span class="font-mono font-semibold text-xs">{tier.key_prefix}</span>
 {#if tier.description}
 <p class="text-xs text-base-content/65 mt-0.5 max-w-45">{tier.description}</p>
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
 <span class="text-xs text-base-content/65">ms</span>
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

 <div class="mt-6">
 <h3 class="font-semibold text-sm">{m['settings.tenantLimitTitle']()}</h3>
 <p class="text-xs text-base-content/65 mb-2">{m['settings.tenantLimitHint']()}</p>
 <div class="flex flex-wrap items-end gap-2">
 <select class="select select-sm" aria-label={m['settings.tier']()} bind:value={newTenantLimit.tier}>
 {#each rlTierNames as t}
 <option value={t}>{t}</option>
 {/each}
 </select>
 <input
 class="input input-sm input-bordered w-80 font-mono text-xs"
 placeholder={m['settings.tenantLimitTenant']()}
 aria-label={m['settings.tenantLimitTenant']()}
 bind:value={newTenantLimit.tenant}
 />
 <input
 type="number"
 class="input input-sm input-bordered w-24 font-mono text-xs"
 aria-label={m['settings.window']()}
 bind:value={newTenantLimit.window_ms}
 min="1000"
 max="3600000"
 step="1000"
 />
 <input
 type="number"
 class="input input-sm input-bordered w-24 font-mono text-xs"
 aria-label={m['settings.maxRequests']()}
 bind:value={newTenantLimit.max_requests}
 min="1"
 max="100000"
 />
 <button class="btn btn-sm btn-primary" onclick={addTenantLimit} disabled={rlSaving !== null}>
 {m['settings.tenantLimitAdd']()}
 </button>
 </div>
 </div>
 {/if}

  {/if}
 </div>
 </div>
 {/if}
</div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? m['common.confirm']()}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
