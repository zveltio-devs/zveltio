<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import { Plus, Search, Trash2, Globe, Check, X } from '@lucide/svelte';

 let locales = $state<any[]>([]);
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

 onMount(async () => {
 await loadAll();
 });

 async function loadAll() {
 loading = true;
 const [locRes, keysRes] = await Promise.all([
 api.get<{ locales: any[] }>('/api/translations/locales'),
 loadKeys(),
 ]);
 locales = locRes.locales || [];
 if (locales.length > 0) activeLocale = locales.find((l) => l.is_default)?.code || locales[0].code;
 loading = false;
 }

 async function loadKeys() {
 const qs = new URLSearchParams({ limit: String(pagination.limit), page: String(pagination.page) });
 if (search.trim()) qs.set('search', search.trim());
 const res = await api.get<{ keys: any[]; pagination: any }>(`/api/translations?${qs}`);
 keys = res.keys || [];
 pagination = { ...pagination, ...res.pagination };
 return res;
 }

 async function addKey() {
 if (!newKey.key.trim()) return;
 saving = true;
 try {
 await api.post('/api/translations', newKey);
 await loadKeys();
 showAddKey = false;
 newKey = { key: '', context: '', default_value: '', description: '' };
 } catch (err: any) {
 alert(err.message);
 } finally {
 saving = false;
 }
 }

 async function addLocale() {
 if (!newLocale.code || !newLocale.name) return;
 saving = true;
 try {
 await api.post('/api/translations/locales', newLocale);
 const res = await api.get<{ locales: any[] }>('/api/translations/locales');
 locales = res.locales;
 showAddLocale = false;
 newLocale = { code: '', name: '', is_default: false };
 } catch (err: any) {
 alert(err.message);
 } finally {
 saving = false;
 }
 }

 async function deleteKey(id: string, key: string) {
 if (!confirm(`Delete key '${key}' and all its translations?`)) return;
 await api.delete(`/api/translations/${id}`);
 keys = keys.filter((k) => k.id !== id);
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
 await api.put(`/api/translations/${keyId}/${locale}`, {
 value: editValue,
 is_machine_translated: false,
 reviewed: false,
 });
 // Update local state
 const keyIdx = keys.findIndex((k) => k.id === keyId);
 if (keyIdx >= 0) {
 const translations = [...(keys[keyIdx].translations || [])];
 const tIdx = translations.findIndex((t: any) => t.locale === locale);
 if (tIdx >= 0) {
 translations[tIdx] = { ...translations[tIdx], value: editValue };
 } else {
 translations.push({ locale, value: editValue, reviewed: false });
 }
 keys[keyIdx] = { ...keys[keyIdx], translations };
 }
 } catch (err: any) {
 alert(err.message);
 } finally {
 saving = false;
 editingCell = null;
 }
 }

 function cancelEdit() {
 editingCell = null;
 editValue = '';
 }

 function getTranslation(key: any, locale: string): string {
 const t = (key.translations || []).find((tr: any) => tr.locale === locale);
 return t?.value || '';
 }

 function isReviewed(key: any, locale: string): boolean {
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
 <div class="flex items-center justify-between flex-wrap gap-3">
 <div>
 <h1 class="text-2xl font-bold">Translations</h1>
 <p class="text-base-content/60 text-sm">Manage your application's i18n strings</p>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm" onclick={() => (showAddLocale = !showAddLocale)}>
 <Globe size={16} />
 Add Locale
 </button>
 <button class="btn btn-primary btn-sm" onclick={() => (showAddKey = !showAddKey)}>
 <Plus size={16} />
 Add Key
 </button>
 </div>
 </div>

 <!-- Add locale form -->
 {#if showAddLocale}
 <div class="card bg-base-200 border border-primary/30">
 <div class="card-body gap-3">
 <h3 class="font-semibold">Add Locale</h3>
 <div class="grid grid-cols-3 gap-3">
 <div class="form-control">
 <label class="label" for="lc_code"><span class="label-text">Code</span></label>
 <input id="lc_code" type="text" bind:value={newLocale.code} placeholder="ro" class="input input-sm" />
 </div>
 <div class="form-control">
 <label class="label" for="lc_name"><span class="label-text">Name</span></label>
 <input id="lc_name" type="text" bind:value={newLocale.name} placeholder="Română" class="input input-sm" />
 </div>
 <div class="form-control justify-end">
 <label class="flex items-center gap-2 cursor-pointer pb-1">
 <input type="checkbox" bind:checked={newLocale.is_default} class="checkbox checkbox-sm" />
 <span class="label-text">Default</span>
 </label>
 </div>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-primary btn-sm" onclick={addLocale} disabled={saving}>Add</button>
 <button class="btn btn-ghost btn-sm" onclick={() => (showAddLocale = false)}>Cancel</button>
 </div>
 </div>
 </div>
 {/if}

 <!-- Add key form -->
 {#if showAddKey}
 <div class="card bg-base-200 border border-primary/30">
 <div class="card-body gap-3">
 <h3 class="font-semibold">New Translation Key</h3>
 <div class="grid grid-cols-2 gap-3">
 <div class="form-control">
 <label class="label" for="key_key"><span class="label-text">Key <span class="text-error">*</span></span></label>
 <input id="key_key" type="text" bind:value={newKey.key} placeholder="auth.login.title" class="input input-sm font-mono" />
 </div>
 <div class="form-control">
 <label class="label" for="key_ctx"><span class="label-text">Context</span></label>
 <input id="key_ctx" type="text" bind:value={newKey.context} placeholder="ui / email / content" class="input input-sm" />
 </div>
 <div class="form-control col-span-2">
 <label class="label" for="key_def"><span class="label-text">Default value (English fallback)</span></label>
 <input id="key_def" type="text" bind:value={newKey.default_value} placeholder="Login to your account" class="input input-sm" />
 </div>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-primary btn-sm" onclick={addKey} disabled={saving || !newKey.key}>Add Key</button>
 <button class="btn btn-ghost btn-sm" onclick={() => (showAddKey = false)}>Cancel</button>
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
 <span class="badge badge-ghost badge-xs ml-1">default</span>
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
 placeholder="Search keys…"
 class="input input-sm w-full pl-9"
 />
 </div>
 <button class="btn btn-sm" onclick={searchKeys}>Search</button>
 </div>

 {#if loading}
 <div class="flex justify-center py-12">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
 {:else}
 <!-- Translation table -->
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th class="w-64">Key</th>
 <th>Default</th>
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
 <button class="btn btn-ghost btn-xs text-success" onclick={saveEdit} title="Save"><Check size={12} /></button>
 <button class="btn btn-ghost btn-xs" onclick={cancelEdit} title="Cancel"><X size={12} /></button>
 </div>
 {:else}
 <button
 class="text-left w-full text-sm {translation ? '' : 'text-base-content/30 italic'} hover:bg-base-300 rounded px-1 py-0.5 transition-colors"
 onclick={() => startEdit(key.id, activeLocale, translation)}
 >
 {translation || 'Click to translate…'}
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
 Prev
 </button>
 <span class="btn btn-sm btn-ghost no-animation">
 {pagination.page} / {Math.ceil(pagination.total / pagination.limit)}
 </span>
 <button
 class="btn btn-sm"
 disabled={pagination.page >= Math.ceil(pagination.total / pagination.limit)}
 onclick={async () => { pagination.page++; await loadKeys(); }}
 >
 Next
 </button>
 </div>
 {/if}

 {#if keys.length === 0}
 <div class="text-center py-8 text-base-content/40">
 {search ? 'No keys matching your search.' : 'No translation keys yet. Add your first key.'}
 </div>
 {/if}
 {/if}
</div>
