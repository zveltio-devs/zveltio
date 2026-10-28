<script lang="ts">
/**
 * The theme editor (ADR 0007): a theme is data, edited here with a live preview
 * and saved without a build. The instance's theme is the `theme` setting; a
 * tenant admin may also give their organization its own, which replaces the
 * instance's whole. A daisyUI theme can be pasted in and becomes the same data.
 */
import { onMount } from 'svelte';
import { LoaderCircle } from '@lucide/svelte';
import {
  THEME_COLORS,
  type Theme,
  importDaisyTheme,
  isThemeColor,
  isThemeLength,
  themeName,
  themeStyle,
} from '@zveltio/ui/theme';
import { api, settingsApi } from '#lib/api.js';
import { m } from '#lib/i18n.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';

type Target = 'instance' | 'tenant';

let loading = $state(true);
let saving = $state(false);
let target = $state<Target>('instance');
let saved = $state<Record<Target, Theme | null>>({ instance: null, tenant: null });
// The tenant target exists only for a tenant admin: the GET answers 403 to anyone else.
let tenantAllowed = $state(false);
let theme = $state<Theme>({});
let css = $state('');

const asTheme = (v: unknown): Theme | null => (v && typeof v === 'object' ? (v as Theme) : null);

onMount(async () => {
  const [instance, tenant] = await Promise.allSettled([
    api.get<{ value: unknown }>('/api/settings/theme'),
    api.get<{ theme: unknown }>('/api/tenants/current/theme'),
  ]);
  saved.instance = instance.status === 'fulfilled' ? asTheme(instance.value.value) : null;
  if (tenant.status === 'fulfilled') {
    tenantAllowed = true;
    saved.tenant = asTheme(tenant.value.theme);
  }
  edit('instance');
  loading = false;
});

function edit(t: Target) {
  target = t;
  // Edit a copy; the tenant starts from what it renders with today.
  theme = structuredClone(
    $state.snapshot(saved[t] ?? (t === 'tenant' ? saved.instance : null) ?? {}),
  );
}

/** A value set in a text input: an empty one is no value. */
function setColor(k: (typeof THEME_COLORS)[number], v: string) {
  const colors = { ...theme.colors };
  if (v.trim()) colors[k] = v.trim();
  else delete colors[k];
  theme.colors = colors;
}
function setRadius(k: 'selector' | 'field' | 'box', v: string) {
  const radius = { ...theme.radius };
  if (v.trim()) radius[k] = v.trim();
  else delete radius[k];
  theme.radius = radius;
}
function setOption<K extends 'scheme' | 'font' | 'density' | 'border'>(k: K, v: string) {
  if (v.trim()) theme[k] = v.trim() as Theme[K];
  else delete theme[k];
}

const invalid = $derived(
  Object.values(theme.colors ?? {}).some((v) => !isThemeColor(v)) ||
    Object.values(theme.radius ?? {}).some((v) => !isThemeLength(v)) ||
    (theme.border !== undefined && !isThemeLength(theme.border)),
);

function runImport() {
  const imported = importDaisyTheme(css);
  const count =
    Object.keys(imported.colors ?? {}).length +
    Object.keys(imported.radius ?? {}).length +
    ['scheme', 'border', 'density'].filter((k) => k in imported).length;
  if (count === 0) {
    toast.error(m['settings.theme.importNothing']());
    return;
  }
  // A daisyUI theme has no font token: the one chosen here stays.
  theme = { ...imported, ...(theme.font ? { font: theme.font } : {}) };
  css = '';
  toast.success(m['settings.theme.imported']({ count }));
}

/** Empty sections are left out: the engine stores exactly what is set. */
function clean(t: Theme): Theme {
  const out = $state.snapshot(t) as Theme;
  if (out.colors && Object.keys(out.colors).length === 0) delete out.colors;
  if (out.radius && Object.keys(out.radius).length === 0) delete out.radius;
  return out;
}

async function save(reset = false) {
  saving = true;
  try {
    if (target === 'tenant') {
      const res = await api.put<{ theme: unknown }>('/api/tenants/current/theme', {
        theme: reset ? null : clean(theme),
      });
      saved.tenant = asTheme(res.theme);
    } else {
      const value = reset ? {} : clean(theme);
      await settingsApi.update('theme', value);
      saved.instance = value;
    }
    edit(target);
    toast.success(m['settings.saved']());
  } catch (err) {
    toast.error(err instanceof Error ? err.message : m['common.saveFailed']());
  } finally {
    saving = false;
  }
}

const SELECTS = [
  {
    key: 'scheme',
    label: () => m['settings.theme.scheme'](),
    options: [
      ['light', () => m['settings.theme.schemeLight']()],
      ['dark', () => m['settings.theme.schemeDark']()],
    ],
  },
  {
    key: 'font',
    label: () => m['settings.theme.font'](),
    options: [
      ['system', () => m['settings.theme.fontSystem']()],
      ['sans', () => m['settings.theme.fontSans']()],
      ['serif', () => m['settings.theme.fontSerif']()],
      ['mono', () => m['settings.theme.fontMono']()],
    ],
  },
  {
    key: 'density',
    label: () => m['settings.theme.density'](),
    options: [
      ['compact', () => m['settings.theme.densityCompact']()],
      ['normal', () => m['settings.theme.densityNormal']()],
      ['comfortable', () => m['settings.theme.densityComfortable']()],
    ],
  },
] as const;

const RADII = [
  ['selector', () => m['settings.theme.radiusSelector']()],
  ['field', () => m['settings.theme.radiusField']()],
  ['box', () => m['settings.theme.radiusBox']()],
] as const;
</script>

<section class="space-y-4" aria-labelledby="theme-editor-title">
  <div>
    <h2 id="theme-editor-title" class="font-semibold">{m['settings.theme.title']()}</h2>
    <p class="text-sm text-base-content/65">{m['settings.theme.hint']()}</p>
  </div>

  {#if loading}
    <LoaderCircle size={20} class="animate-spin" />
  {:else}
    {#if tenantAllowed}
      <div class="form-control">
        <label class="label" for="theme-target"><span class="label-text font-medium">{m['settings.theme.target']()}</span></label>
        <select
          id="theme-target"
          class="select select-sm w-64"
          value={target}
          onchange={(e) => edit(e.currentTarget.value as Target)}
        >
          <option value="instance">{m['settings.theme.targetInstance']()}</option>
          <option value="tenant">{m['settings.theme.targetTenant']()}</option>
        </select>
      </div>
    {/if}

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#each SELECTS as sel (sel.key)}
        <div class="form-control">
          <label class="label" for="theme-{sel.key}"><span class="label-text">{sel.label()}</span></label>
          <select
            id="theme-{sel.key}"
            class="select select-sm"
            value={theme[sel.key] ?? ''}
            onchange={(e) => setOption(sel.key, e.currentTarget.value)}
          >
            <option value="">{m['settings.theme.default']()}</option>
            {#each sel.options as [v, label] (v)}
              <option value={v}>{label()}</option>
            {/each}
          </select>
        </div>
      {/each}
      <div class="form-control">
        <label class="label" for="theme-border"><span class="label-text">{m['settings.theme.border']()}</span></label>
        <input
          id="theme-border"
          class="input input-sm font-mono {theme.border !== undefined && !isThemeLength(theme.border) ? 'input-error' : ''}"
          value={theme.border ?? ''}
          placeholder="1px"
          oninput={(e) => setOption('border', e.currentTarget.value)}
        />
      </div>
      {#each RADII as [k, label] (k)}
        {@const v = theme.radius?.[k]}
        <div class="form-control">
          <label class="label" for="theme-radius-{k}"><span class="label-text">{label()}</span></label>
          <input
            id="theme-radius-{k}"
            class="input input-sm font-mono {v !== undefined && !isThemeLength(v) ? 'input-error' : ''}"
            value={v ?? ''}
            placeholder="0.5rem"
            oninput={(e) => setRadius(k, e.currentTarget.value)}
          />
        </div>
      {/each}
    </div>

    <fieldset>
      <legend class="label-text font-medium mb-2">{m['settings.theme.colors']()}</legend>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {#each THEME_COLORS as k (k)}
          {@const v = theme.colors?.[k]}
          <div class="flex items-center gap-2">
            <input
              type="color"
              class="h-8 w-10 shrink-0 cursor-pointer rounded border border-base-300 bg-transparent"
              value={v && /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'}
              oninput={(e) => setColor(k, e.currentTarget.value)}
              aria-label="{k} ({m['settings.theme.picker']()})"
            />
            <input
              class="input input-sm flex-1 font-mono {v !== undefined && !isThemeColor(v) ? 'input-error' : ''}"
              value={v ?? ''}
              placeholder={k}
              aria-label={k}
              oninput={(e) => setColor(k, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
    </fieldset>

    <div class="form-control">
      <label class="label" for="theme-import">
        <span class="label-text font-medium">{m['settings.theme.import']()}</span>
        <span class="label-text-alt text-base-content/65">{m['settings.theme.importHint']()}</span>
      </label>
      <textarea id="theme-import" class="textarea font-mono text-xs" rows="4" bind:value={css}></textarea>
      <button type="button" class="btn btn-sm mt-2 self-start" disabled={!css.trim()} onclick={runImport}>
        {m['settings.theme.importButton']()}
      </button>
    </div>

    <div>
      <p class="label-text font-medium mb-2">{m['settings.theme.preview']()}</p>
      <div
        data-testid="theme-preview"
        data-theme={themeName(theme)}
        style={themeStyle(theme)}
        class="bg-base-100 text-base-content border-base-300 rounded-box space-y-3 border p-4"
      >
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-primary btn-sm">{m['settings.theme.sample']()}</button>
          <button type="button" class="btn btn-secondary btn-sm">{m['settings.theme.sample']()}</button>
          <button type="button" class="btn btn-accent btn-sm">{m['settings.theme.sample']()}</button>
          <button type="button" class="btn btn-neutral btn-sm">{m['settings.theme.sample']()}</button>
        </div>
        <input class="input input-sm" placeholder={m['settings.theme.sample']()} aria-label={m['settings.theme.sample']()} />
        <div class="flex flex-wrap gap-2">
          <span class="badge badge-info">info</span>
          <span class="badge badge-success">success</span>
          <span class="badge badge-warning">warning</span>
          <span class="badge badge-error">error</span>
        </div>
        <div class="card bg-base-200"><div class="card-body p-3 text-sm">{m['settings.theme.hint']()}</div></div>
      </div>
    </div>

    <div class="flex gap-2">
      <button type="button" class="btn btn-primary btn-sm" disabled={saving || invalid} onclick={() => save()}>
        {#if saving}<LoaderCircle size={16} class="animate-spin" />{/if}
        {m['settings.theme.save']()}
      </button>
      <button type="button" class="btn btn-ghost btn-sm" disabled={saving} onclick={() => save(true)}>
        {target === 'tenant' ? m['settings.theme.useInstance']() : m['settings.theme.reset']()}
      </button>
    </div>
  {/if}
</section>
