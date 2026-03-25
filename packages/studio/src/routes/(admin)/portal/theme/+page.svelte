<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { portalApi } from '$lib/api.js';
  import { ArrowLeft, Save, RefreshCw, Palette, LoaderCircle, Eye } from '@lucide/svelte';

  interface Theme {
    app_name: string;
    logo_url?: string;
    favicon_url?: string;
    color_primary: string;
    color_secondary: string;
    color_accent: string;
    color_neutral: string;
    color_base_100: string;
    color_base_200: string;
    color_base_300: string;
    font_family: string;
    font_size_base: string;
    border_radius: string;
    color_scheme: string;
    custom_css?: string;
    nav_position: string;
    footer_text?: string;
    meta_title?: string;
    meta_description?: string;
  }

  const DEFAULTS: Theme = {
    app_name:         'My App',
    logo_url:         '',
    favicon_url:      '',
    color_primary:    '#570df8',
    color_secondary:  '#f000b8',
    color_accent:     '#37cdbe',
    color_neutral:    '#3d4451',
    color_base_100:   '#ffffff',
    color_base_200:   '#f2f2f2',
    color_base_300:   '#e5e6e6',
    font_family:      'Inter, system-ui, sans-serif',
    font_size_base:   '16px',
    border_radius:    '0.5rem',
    color_scheme:     'auto',
    custom_css:       '',
    nav_position:     'top',
    footer_text:      '',
    meta_title:       '',
    meta_description: '',
  };

  let theme = $state<Theme>({ ...DEFAULTS });
  let loading = $state(true);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state('');

  onMount(load);

  async function load() {
    loading = true;
    try {
      const res = await portalApi.getTheme();
      theme = { ...DEFAULTS, ...(res.theme ?? res ?? {}) };
    } catch {
      theme = { ...DEFAULTS };
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    saved = false;
    error = '';
    try {
      await portalApi.saveTheme(theme);
      saved = true;
      setTimeout(() => (saved = false), 2500);
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  const FONT_OPTIONS = [
    'Inter, system-ui, sans-serif',
    'system-ui, sans-serif',
    'Georgia, serif',
    '"Merriweather", Georgia, serif',
    '"JetBrains Mono", monospace',
  ];

  const RADIUS_OPTIONS = [
    { value: '0px',     label: 'None' },
    { value: '0.25rem', label: 'Small' },
    { value: '0.5rem',  label: 'Medium (default)' },
    { value: '1rem',    label: 'Large' },
    { value: '9999px',  label: 'Full / Pill' },
  ];

  const COLOR_FIELDS: { key: keyof Theme; label: string }[] = [
    { key: 'color_primary',   label: 'Primary' },
    { key: 'color_secondary', label: 'Secondary' },
    { key: 'color_accent',    label: 'Accent' },
    { key: 'color_neutral',   label: 'Neutral' },
    { key: 'color_base_100',  label: 'Background' },
    { key: 'color_base_200',  label: 'Surface' },
  ];
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <a href="{base}/portal" class="btn btn-ghost btn-sm"><ArrowLeft size={16}/></a>
    <div class="flex-1">
      <h1 class="text-2xl font-bold">Theme Editor</h1>
      <p class="text-base-content/50 text-sm">Customize the look and feel of your portal</p>
    </div>
    <button class="btn btn-ghost btn-sm" onclick={load} disabled={loading}>
      <RefreshCw size={15} class={loading ? 'animate-spin' : ''}/>
    </button>
    <button class="btn btn-primary btn-sm gap-1" onclick={save} disabled={saving || loading}>
      {#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<Save size={14}/>{/if}
      {saved ? 'Saved!' : 'Save Theme'}
    </button>
  </div>

  {#if error}
    <div class="alert alert-error text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={32} class="animate-spin text-primary"/>
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left: Settings -->
      <div class="lg:col-span-2 space-y-6">

        <!-- Branding -->
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title text-base gap-2"><Palette size={16}/> Branding</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="form-control">
                <label class="label py-1"><span class="label-text">App name</span></label>
                <input type="text" class="input input-bordered" bind:value={theme.app_name}/>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Nav position</span></label>
                <select class="select select-bordered" bind:value={theme.nav_position}>
                  <option value="top">Top bar</option>
                  <option value="sidebar">Sidebar</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Logo URL</span></label>
                <input type="url" class="input input-bordered" placeholder="https://…" bind:value={theme.logo_url}/>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Favicon URL</span></label>
                <input type="url" class="input input-bordered" placeholder="https://…" bind:value={theme.favicon_url}/>
              </div>
            </div>
          </div>
        </div>

        <!-- Colors -->
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title text-base">Colors</h2>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {#each COLOR_FIELDS as cf}
                <div class="form-control">
                  <label class="label py-1"><span class="label-text text-sm">{cf.label}</span></label>
                  <div class="flex items-center gap-2">
                    <input
                      type="color"
                      class="w-10 h-9 rounded border border-base-300 cursor-pointer p-0.5 bg-base-100"
                      bind:value={(theme as any)[cf.key]}
                    />
                    <input
                      type="text"
                      class="input input-sm input-bordered flex-1 font-mono"
                      bind:value={(theme as any)[cf.key]}
                    />
                  </div>
                </div>
              {/each}
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-sm">Dark mode</span></label>
                <select class="select select-sm select-bordered" bind:value={theme.color_scheme}>
                  <option value="auto">Auto (system)</option>
                  <option value="light">Always light</option>
                  <option value="dark">Always dark</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- Typography -->
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title text-base">Typography & Shape</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="form-control sm:col-span-2">
                <label class="label py-1"><span class="label-text">Font family</span></label>
                <select class="select select-bordered" bind:value={theme.font_family}>
                  {#each FONT_OPTIONS as f}<option value={f}>{f}</option>{/each}
                </select>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Base font size</span></label>
                <select class="select select-bordered" bind:value={theme.font_size_base}>
                  <option value="14px">14px (compact)</option>
                  <option value="16px">16px (default)</option>
                  <option value="18px">18px (large)</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Border radius</span></label>
                <select class="select select-bordered" bind:value={theme.border_radius}>
                  {#each RADIUS_OPTIONS as r}<option value={r.value}>{r.label}</option>{/each}
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- SEO -->
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title text-base">SEO & Footer</h2>
            <div class="space-y-3">
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Meta title</span></label>
                <input type="text" class="input input-bordered" bind:value={theme.meta_title}
                  placeholder="My App — Welcome"/>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Meta description</span></label>
                <textarea class="textarea textarea-bordered" rows={2} bind:value={theme.meta_description}
                  placeholder="Brief description…"></textarea>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text">Footer text</span></label>
                <input type="text" class="input input-bordered" bind:value={theme.footer_text}
                  placeholder="© 2026 My App"/>
              </div>
            </div>
          </div>
        </div>

        <!-- Custom CSS -->
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title text-base">Custom CSS</h2>
            <p class="text-xs text-base-content/50 mb-2">Injected into the portal's &lt;head&gt;.</p>
            <textarea
              class="textarea textarea-bordered font-mono text-xs w-full"
              rows={8}
              placeholder="/* your custom styles */"
              bind:value={theme.custom_css}
            ></textarea>
          </div>
        </div>
      </div>

      <!-- Right: Preview -->
      <div class="space-y-4">
        <div class="sticky top-6">
          <div class="flex items-center gap-2 mb-3">
            <Eye size={15} class="text-base-content/50"/>
            <span class="text-sm font-medium">Preview</span>
          </div>

          <div class="rounded-xl border border-base-300 overflow-hidden shadow-sm"
            style="font-family: {theme.font_family}; font-size: {theme.font_size_base}; background: {theme.color_base_100}; color: {theme.color_neutral}">
            <!-- Nav -->
            <div class="px-4 py-2 flex items-center gap-3 border-b"
              style="background: {theme.color_primary}; color: white; border-color: rgba(255,255,255,0.1)">
              {#if theme.logo_url}
                <img src={theme.logo_url} alt="logo" class="h-6 w-auto"/>
              {:else}
                <div class="w-5 h-5 rounded-full bg-white/30" style="border-radius: {theme.border_radius}"/>
              {/if}
              <span class="font-semibold text-sm">{theme.app_name}</span>
            </div>

            <!-- Body -->
            <div class="p-4 space-y-3">
              <div class="rounded-lg p-3 text-center"
                style="background: {theme.color_primary}20; border-radius: {theme.border_radius}">
                <p class="font-bold text-sm">Welcome to {theme.app_name}</p>
                <p class="text-xs opacity-60">Your portal tagline</p>
                <button class="mt-2 px-3 py-1 text-xs font-medium text-white"
                  style="background: {theme.color_primary}; border-radius: {theme.border_radius}">
                  Get Started
                </button>
              </div>

              <div class="grid grid-cols-2 gap-2">
                {#each ['Item A', 'Item B'] as lbl}
                  <div class="p-2 border"
                    style="background: {theme.color_base_200}; border-color: {theme.color_base_300}; border-radius: {theme.border_radius}">
                    <div class="w-full h-8 mb-1 rounded"
                      style="background: {theme.color_primary}30; border-radius: calc({theme.border_radius} * 0.5)"/>
                    <p class="text-xs font-medium">{lbl}</p>
                    <p class="text-xs opacity-40">Description…</p>
                  </div>
                {/each}
              </div>

              {#if theme.footer_text}
                <p class="text-center text-xs opacity-40 pt-1 border-t"
                  style="border-color: {theme.color_base_300}">
                  {theme.footer_text}
                </p>
              {/if}
            </div>
          </div>

          <!-- Color chips -->
          <div class="flex gap-1.5 mt-3 flex-wrap">
            {#each COLOR_FIELDS as cf}
              <div class="w-7 h-7 rounded-full border border-base-300 shadow-sm"
                style="background: {(theme as any)[cf.key]}"
                title="{cf.label}: {(theme as any)[cf.key]}"></div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
