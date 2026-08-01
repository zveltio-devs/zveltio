<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { Plus, Search, Trash2, Globe, Check, X } from '@lucide/svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import PageSpinner from '$lib/components/common/PageSpinner.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let locales = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let keys = $state<any[]>([]);
let pagination = $state({ total: 0, page: 1, limit: 50 });
let loading = $state(true);
let activeLocale = $state('en');
let search = $state('');
let showAddKey = $state(false);
let showAddLocale = $state(false);
let saving = $state(false);

let newKey = $state({ key: '', context: '', default_value: '', description: '' });
let newLocale = $state({ code: '', name: '', is_default: false });
let editingCell = $state<{ keyId: string; locale: string } | null>(null);
let editValue = $state('');
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

onMount(async () => {
  await loadAll();
});

async function loadAll() {
  loading = true;
  const [locRes, keysRes] = await Promise.all([
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    api.get<{ locales: any[] }>('/ext/i18n/translations/locales'),
    loadKeys(),
  ]);
  locales = locRes.locales || [];
  if (locales.length > 0) activeLocale = locales.find((l) => l.is_default)?.code || locales[0].code;
  loading = false;
}

async function loadKeys() {
  const qs = new URLSearchParams({
    limit: String(pagination.limit),
    page: String(pagination.page),
  });
  if (search.trim()) qs.set('search', search.trim());
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const res = await api.get<{ keys: any[]; pagination: any }>(`/ext/i18n/translations?${qs}`);
  keys = res.keys || [];
  pagination = { ...pagination, ...res.pagination };
  return res;
}

async function addKey() {
  if (!newKey.key.trim()) return;
  saving = true;
  try {
    await api.post('/ext/i18n/translations', newKey);
    await loadKeys();
    showAddKey = false;
    newKey = { key: '', context: '', default_value: '', description: '' };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message);
  } finally {
    saving = false;
  }
}

async function addLocale() {
  if (!newLocale.code || !newLocale.name) return;
  saving = true;
  try {
    await api.post('/ext/i18n/translations/locales', newLocale);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.get<{ locales: any[] }>('/ext/i18n/translations/locales');
    locales = res.locales;
    showAddLocale = false;
    newLocale = { code: '', name: '', is_default: false };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message);
  } finally {
    saving = false;
  }
}

async function deleteKey(id: string, key: string) {
  confirmState = {
    open: true,
    title: m['tr.deleteKeyTitle'](),
    message: m['tr.deleteKeyMsg']({ key }),
    confirmLabel: m['common.delete'](),
    onconfirm: async () => {
      confirmState.open = false;
      await api.delete(`/ext/i18n/translations/${id}`);
      keys = keys.filter((k) => k.id !== id);
    },
  };
}

function startEdit(keyId: string, locale: string, currentValue: string) {
  editingCell = { keyId, locale };
  editValue = currentValue || '';
}

async function saveEdit() {
  if (!editingCell) return;
  const { keyId, locale } = editingCell;
  saving = true;
  try {
    await api.put(`/ext/i18n/translations/${keyId}/${locale}`, {
      value: editValue,
      is_machine_translated: false,
      reviewed: false,
    });
    // Update local state
    const keyIdx = keys.findIndex((k) => k.id === keyId);
    if (keyIdx >= 0) {
      const translations = [...(keys[keyIdx].translations || [])];
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const tIdx = translations.findIndex((t: any) => t.locale === locale);
      if (tIdx >= 0) {
        translations[tIdx] = { ...translations[tIdx], value: editValue };
      } else {
        translations.push({ locale, value: editValue, reviewed: false });
      }
      keys[keyIdx] = { ...keys[keyIdx], translations };
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message);
  } finally {
    saving = false;
    editingCell = null;
  }
}

function cancelEdit() {
  editingCell = null;
  editValue = '';
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function getTranslation(key: any, locale: string): string {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const t = (key.translations || []).find((tr: any) => tr.locale === locale);
  return t?.value || '';
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function isReviewed(key: any, locale: string): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const t = (key.translations || []).find((tr: any) => tr.locale === locale);
  return t?.reviewed || false;
}

async function searchKeys() {
  pagination.page = 1;
  await loadKeys();
}
</script>

<div class="space-y-6">
 <!-- Header -->
 <PageHeader title={m['nav.translations']()} subtitle={m['tr.subtitle']()}>
  <div class="flex gap-2">
  <button class="btn btn-ghost btn-sm" onclick={() => (showAddLocale = !showAddLocale)}>
  <Globe size={16} />
  {m['tr.addLocale']()}
  </button>
  <button class="btn btn-primary btn-sm" onclick={() => (showAddKey = !showAddKey)}>
  <Plus size={16} />
  {m['tr.addKey']()}
  </button>
  </div>
 </PageHeader>

 <!-- Add locale form -->
 {#if showAddLocale}
 <div class="card bg-base-200 border border-primary/30">
 <div class="card-body gap-3">
 <h3 class="font-semibold">{m['tr.addLocale']()}</h3>
 <div class="grid grid-cols-3 gap-3">
 <div class="form-control">
 <label class="label" for="lc_code"><span class="label-text">{m['tr.code']()}</span></label>
 <input id="lc_code" type="text" bind:value={newLocale.code} placeholder="ro" class="input input-sm" />
 </div>
 <div class="form-control">
 <label class="label" for="lc_name"><span class="label-text">{m['common.col.name']()}</span></label>
 <input id="lc_name" type="text" bind:value={newLocale.name} placeholder="Română" class="input input-sm" />
 </div>
 <div class="form-control justify-end">
 <label class="flex items-center gap-2 cursor-pointer pb-1">
 <input type="checkbox" bind:checked={newLocale.is_default} class="checkbox checkbox-sm" />
 <span class="label-text">{m['tr.default']()}</span>
 </label>
 </div>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-primary btn-sm" onclick={addLocale} disabled={saving}>{m['erd.add']()}</button>
 <button class="btn btn-ghost btn-sm" onclick={() => (showAddLocale = false)}>{m['common.cancel']()}</button>
 </div>
 </div>
 </div>
 {/if}

 <!-- Add key form -->
 {#if showAddKey}
 <div class="card bg-base-200 border border-primary/30">
 <div class="card-body gap-3">
 <h3 class="font-semibold">{m['tr.newKey']()}</h3>
 <div class="grid grid-cols-2 gap-3">
 <div class="form-control">
 <label class="label" for="key_key"><span class="label-text">{m['common.col.key']()} <span class="text-error">*</span></span></label>
 <input id="key_key" type="text" bind:value={newKey.key} placeholder="auth.login.title" class="input input-sm font-mono" />
 </div>
 <div class="form-control">
 <label class="label" for="key_ctx"><span class="label-text">{m['tr.context']()}</span></label>
 <input id="key_ctx" type="text" bind:value={newKey.context} placeholder="ui / email / content" class="input input-sm" />
 </div>
 <div class="form-control col-span-2">
 <label class="label" for="key_def"><span class="label-text">{m['tr.defaultValue']()}</span></label>
 <input id="key_def" type="text" bind:value={newKey.default_value} placeholder={m['tr.loginPh']()} class="input input-sm" />
 </div>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-primary btn-sm" onclick={addKey} disabled={saving || !newKey.key}>{m['tr.addKey']()}</button>
 <button class="btn btn-ghost btn-sm" onclick={() => (showAddKey = false)}>{m['common.cancel']()}</button>
 </div>
 </div>
 </div>
 {/if}

 <!-- Locale tabs -->
 {#if locales.length > 0}
 <div class="flex items-center gap-2 flex-wrap">
 {#each locales as locale}
 <button
 class="btn btn-sm {activeLocale === locale.code ? 'btn-primary' : 'btn-outline'}"
 onclick={() => (activeLocale = locale.code)}
 >
 {locale.name} <span class="font-mono text-xs opacity-60">({locale.code})</span>
 {#if locale.is_default}
 <span class="badge badge-ghost badge-xs ml-1">{m['tr.default']()}</span>
 {/if}
 </button>
 {/each}
 </div>
 {/if}

 <!-- Search bar -->
 <div class="flex gap-2">
 <div class="relative flex-1">
 <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/40" />
 <input
 type="text"
 bind:value={search}
 onkeydown={(e) => e.key === 'Enter' && searchKeys()}
 placeholder={m['tr.searchKeys']()}
 class="input input-sm w-full pl-9"
 />
 </div>
 <button class="btn btn-sm" onclick={searchKeys}>{m['tr.searchBtn']()}</button>
 </div>

 {#if loading}
 <PageSpinner />
 {:else}
 <!-- Translation table -->
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th class="w-64">{m['common.col.key']()}</th>
 <th>{m['tr.default']()}</th>
 <th class="min-w-48">{locales.find((l) => l.code === activeLocale)?.name || activeLocale}</th>
 <th class="w-8"></th>
 </tr>
 </thead>
 <tbody>
 {#each keys as key}
 {@const translation = getTranslation(key, activeLocale)}
 {@const reviewed = isReviewed(key, activeLocale)}
 <tr class="hover">
 <td>
 <div class="font-mono text-xs font-semibold">{key.key}</div>
 {#if key.context}
 <div class="text-xs text-base-content/40">{key.context}</div>
 {/if}
 </td>
 <td class="text-sm text-base-content/60 max-w-48 truncate" title={key.default_value}>
 {key.default_value || '—'}
 </td>
 <td>
 {#if editingCell?.keyId === key.id && editingCell?.locale === activeLocale}
 <div class="flex gap-1">
 <input
 type="text"
 bind:value={editValue}
 class="input input-xs flex-1"
 onkeydown={(e) => {
 if (e.key === 'Enter') saveEdit();
 if (e.key === 'Escape') cancelEdit();
 }}
 />
 <button class="btn btn-ghost btn-xs text-success" onclick={saveEdit} title={m['common.save']()} aria-label={m['tr.saveTranslation']()}><Check size={12} /></button>
 <button class="btn btn-ghost btn-xs" onclick={cancelEdit} title={m['common.cancel']()} aria-label={m['tr.cancelEdit']()}><X size={12} /></button>
 </div>
 {:else}
 <button
 class="text-left w-full text-sm {translation ? '' : 'text-base-content/30 italic'} hover:bg-base-300 rounded px-1 py-0.5 transition-colors"
 onclick={() => startEdit(key.id, activeLocale, translation)}
 >
 {translation || m['tr.clickToTranslate']()}
 {#if reviewed}
 <Check size={10} class="inline ml-1 text-success" />
 {/if}
 </button>
 {/if}
 </td>
 <td>
 <button
 onclick={() => deleteKey(key.id, key.key)}
 class="btn btn-ghost btn-xs text-error"
 >
 <Trash2 size={12} />
 </button>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>

 <!-- Pagination -->
 {#if pagination.total > pagination.limit}
 <div class="flex justify-center gap-2">
 <button
 class="btn btn-sm"
 disabled={pagination.page <= 1}
 onclick={async () => { pagination.page--; await loadKeys(); }}
 >
 {m['common.prev']()}
 </button>
 <span class="btn btn-sm btn-ghost no-animation">
 {pagination.page} / {Math.ceil(pagination.total / pagination.limit)}
 </span>
 <button
 class="btn btn-sm"
 disabled={pagination.page >= Math.ceil(pagination.total / pagination.limit)}
 onclick={async () => { pagination.page++; await loadKeys(); }}
 >
 {m['common.next']()}
 </button>
 </div>
 {/if}

 {#if keys.length === 0}
 <div class="text-center py-8 text-base-content/40">
 {search ? m['tr.noMatches']() : m['tr.noKeys']()}
 </div>
 {/if}
 {/if}
</div>

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
