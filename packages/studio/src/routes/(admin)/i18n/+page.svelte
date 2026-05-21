<script lang="ts">
  import { onMount } from 'svelte';
  import { Languages, Plus, X, Globe, Key } from '@lucide/svelte';

  const engineUrl = (window as any).__zveltio?.engineUrl ?? '';
  let tab = $state<'translations' | 'locales' | 'glossary'>('translations');
  let translations = $state<any[]>([]);
  let locales = $state<any[]>([]);
  let glossary = $state<any[]>([]);
  let selectedLocale = $state('en');
  let q = $state('');
  let error = $state('');

  let showLocaleForm = $state(false);
  let saving = $state(false);
  let localeForm = $state({ code: '', name: '', is_active: true });

  async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${engineUrl}${path}`, { credentials: 'include', ...init });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json as T;
  }

  async function loadTranslations() {
    try {
      const params = new URLSearchParams({ locale: selectedLocale });
      if (q) params.set('q', q);
      const r = await api(`/ext/i18n/translations/keys?${params}`);
      translations = r.data ?? [];
    } catch (e: any) { error = e.message; }
  }
  async function loadLocales() { try { const r = await api('/ext/i18n/translations/locales'); locales = r.data ?? []; } catch (e: any) { error = e.message; } }
  async function loadGlossary() { try { const r = await api('/ext/i18n/translations/glossary'); glossary = r.data ?? []; } catch (e: any) { error = e.message; } }

  async function saveTranslation(key: string, value: string) {
    try {
      await api('/ext/i18n/translations/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, locale: selectedLocale, value }) });
    } catch (e: any) { error = e.message; }
  }

  async function createLocale() {
    saving = true; error = '';
    try {
      await api('/ext/i18n/translations/locales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(localeForm) });
      showLocaleForm = false;
      localeForm = { code: '', name: '', is_active: true };
      await loadLocales();
    } catch (e: any) { error = e.message; } finally { saving = false; }
  }

  $effect(() => {
    if (tab === 'translations') loadTranslations();
    else if (tab === 'locales') loadLocales();
    else loadGlossary();
  });

  onMount(() => { loadTranslations(); loadLocales(); });
</script>

<div class="p-6 space-y-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold flex items-center gap-2"><Languages class="h-6 w-6" /> Translations</h1>
    {#if tab === 'locales'}<button class="btn btn-primary btn-sm gap-2" onclick={() => (showLocaleForm = true)}><Plus class="h-4 w-4" /> Add locale</button>{/if}
  </header>
  {#if error}<div class="alert alert-error">{error}</div>{/if}

  <div role="tablist" class="tabs tabs-bordered">
    <button role="tab" class:tab-active={tab === 'translations'} class="tab gap-2" onclick={() => (tab = 'translations')}><Key class="h-4 w-4" /> Keys</button>
    <button role="tab" class:tab-active={tab === 'locales'} class="tab gap-2" onclick={() => (tab = 'locales')}><Globe class="h-4 w-4" /> Locales</button>
    <button role="tab" class:tab-active={tab === 'glossary'} class="tab" onclick={() => (tab = 'glossary')}>Glossary</button>
  </div>

  {#if tab === 'translations'}
    <div class="flex gap-3">
      <select class="select select-sm select-bordered" bind:value={selectedLocale} onchange={loadTranslations}>
        {#each locales as l (l.code)}<option value={l.code}>{l.name} ({l.code})</option>{/each}
      </select>
      <div class="join">
        <input class="input input-sm input-bordered join-item" placeholder="Search keys..." bind:value={q} onkeydown={(e) => e.key === 'Enter' && loadTranslations()} />
        <button class="btn btn-sm join-item" onclick={loadTranslations}>Search</button>
      </div>
    </div>
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>Key</th><th>Value</th><th>Notes</th></tr></thead>
        <tbody>
          {#if translations.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/60">No keys.</td></tr>
          {:else}{#each translations as t (t.key)}
            <tr>
              <td class="font-mono text-xs">{t.key}</td>
              <td><input class="input input-xs input-bordered w-full" value={t.value ?? ''} onblur={(e) => saveTranslation(t.key, (e.target as HTMLInputElement).value)} /></td>
              <td class="text-xs text-base-content/60">{t.context ?? ''}</td>
            </tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'locales'}
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>Code</th><th>Name</th><th>Active</th></tr></thead>
        <tbody>
          {#if locales.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/60">No locales.</td></tr>
          {:else}{#each locales as l (l.code)}
            <tr><td class="font-mono">{l.code}</td><td>{l.name}</td><td>{l.is_active ? '✓' : '—'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>Term</th><th>Translation</th><th>Locale</th><th>Context</th></tr></thead>
        <tbody>
          {#if glossary.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/60">Glossary empty.</td></tr>
          {:else}{#each glossary as g (g.id)}
            <tr><td>{g.term}</td><td>{g.translation}</td><td><span class="badge badge-sm">{g.locale}</span></td><td>{g.context ?? '—'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showLocaleForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showLocaleForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-sm">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">New locale</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showLocaleForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div><label class="label label-text">Code (e.g. ro, en, de)</label><input class="input input-bordered w-full font-mono" maxlength="5" bind:value={localeForm.code} /></div>
        <div><label class="label label-text">Name</label><input class="input input-bordered w-full" bind:value={localeForm.name} /></div>
      </div>
      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showLocaleForm = false)}>Cancel</button><button class="btn btn-primary" disabled={saving || !localeForm.code} onclick={createLocale}>{saving ? 'Saving…' : 'Add'}</button></div>
    </div>
  </div>
{/if}
