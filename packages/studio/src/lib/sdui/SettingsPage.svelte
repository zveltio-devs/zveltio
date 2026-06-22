<script lang="ts">
  /**
   * SDUI SPIKE — second archetype renderer: a singleton settings/config page
   * (auth/ldap, saml, integrations, mail setup). Loads one config object,
   * renders a sectioned form (incl boolean toggle + password), saves it, and
   * runs page-level actions like "Test connection".
   */
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { m } from '$lib/i18n.svelte.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { Save, Play, LoaderCircle } from '@lucide/svelte';
  import type { SettingsSchema, FieldDef } from './types.js';

  let { schema }: { schema: SettingsSchema } = $props();

  const ICONS: Record<string, any> = { Play, Save };
  function t(s?: string): string {
    if (!s) return '';
    const fn = (m as Record<string, (() => string) | undefined>)[s];
    return typeof fn === 'function' ? fn() : s;
  }
  function getPath(obj: any, path?: string): any {
    if (!path) return obj;
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  let config = $state<Record<string, any>>({});
  let loading = $state(true);
  let saving = $state(false);
  let busyAction = $state<string | null>(null);

  function allFields(): FieldDef[] {
    const fs = [...(schema.fields ?? [])];
    for (const s of schema.sections ?? []) fs.push(...s.fields);
    return fs;
  }

  onMount(async () => {
    try {
      const res = await api.get<any>(schema.dataSource);
      const cfg = getPath(res, schema.dataPath);
      if (cfg) config = cfg;
      else for (const f of allFields()) config[f.name] = f.default ?? (f.type === 'boolean' ? false : '');
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
    } finally {
      loading = false;
    }
  });

  async function save() {
    saving = true;
    try {
      await api.post(schema.saveEndpoint, config);
      toast.success(t('common.saved'));
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
    } finally {
      saving = false;
    }
  }

  async function runAction(a: NonNullable<SettingsSchema['actions']>[number]) {
    busyAction = a.id;
    try {
      await api.post(a.endpoint, config);
      toast.success(t(`${a.label} ✓`));
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : `${t(a.label)} failed`);
    } finally {
      busyAction = null;
    }
  }
</script>

<ExtensionPageShell title={t(schema.title)} subtitle={t(schema.subtitle)}>
  <div class="max-w-2xl space-y-6">
    {#if loading}
      <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
    {:else}
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 gap-4">
          {#snippet field(f: FieldDef)}
            {#if f.type === 'boolean'}
              <div class="form-control flex-row items-center gap-3">
                <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={config[f.name]} />
                <span class="text-sm">{t(f.label)}</span>
              </div>
            {:else}
              <div class="form-control {f.colSpan === 2 ? 'col-span-2' : ''}">
                <label class="label py-0"><span class="label-text text-xs">{t(f.label)}</span></label>
                <input class="input input-sm {f.mono ? 'font-mono text-xs' : ''}" type={f.type === 'password' ? 'password' : (f.type ?? 'text')} bind:value={config[f.name]} placeholder={t(f.placeholder)} />
              </div>
            {/if}
          {/snippet}

          {#each schema.fields ?? [] as f}{@render field(f)}{/each}

          {#each schema.sections ?? [] as sec}
            <div class="divider my-0 text-xs text-base-content/30">{t(sec.title)}</div>
            <div class="grid grid-cols-2 gap-3">{#each sec.fields as f}{@render field(f)}{/each}</div>
          {/each}
        </div>
      </div>

      <div class="flex gap-3">
        {#each schema.actions ?? [] as a}
          {@const Icon = a.icon ? ICONS[a.icon] : Play}
          <button class="btn btn-outline btn-sm gap-2 {a.variant ?? ''}" onclick={() => runAction(a)} disabled={busyAction === a.id}>
            {#if busyAction === a.id}<LoaderCircle size={14} class="animate-spin" />{:else if Icon}<Icon size={14} />{/if}
            {t(a.label)}
          </button>
        {/each}
        <button class="btn btn-primary gap-2" onclick={save} disabled={saving}>
          {#if saving}<LoaderCircle size={15} class="animate-spin" />{:else}<Save size={15} />{/if}
          {t('common.save')}
        </button>
      </div>
    {/if}
  </div>
</ExtensionPageShell>
