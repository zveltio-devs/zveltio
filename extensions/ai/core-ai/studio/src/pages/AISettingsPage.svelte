<script lang="ts">
  import { onMount } from 'svelte';
  import { Save, CheckCircle } from '@lucide/svelte';

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

  type ProviderName = 'openai' | 'anthropic' | 'ollama';

  interface ProviderConfig {
    name: ProviderName;
    display_name: string;
    api_key: string;
    base_url: string;
    default_model: string;
    is_default: boolean;
    is_active: boolean;
    loaded: boolean;
  }

  const PROVIDER_META: Record<ProviderName, { label: string; models: string[]; needsKey: boolean; placeholder?: string }> = {
    openai: {
      label: 'OpenAI',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      needsKey: true,
    },
    anthropic: {
      label: 'Anthropic (Claude)',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      needsKey: true,
    },
    ollama: {
      label: 'Ollama (Local)',
      models: ['llama3.2', 'mistral', 'qwen2.5-coder'],
      needsKey: false,
      placeholder: 'http://localhost:11434',
    },
  };

  let providers = $state<Record<string, ProviderConfig>>({});
  let loading = $state(true);
  let saving = $state<string | null>(null);
  let saved = $state<string | null>(null);
  let usage = $state<any[]>([]);

  onMount(async () => {
    await Promise.all([loadProviders(), loadUsage()]);
  });

  async function loadProviders() {
    loading = true;
    try {
      const res = await fetch(`${engineUrl}/api/ai/providers`, { credentials: 'include' });
      const data = await res.json();
      const map: Record<string, ProviderConfig> = {};
      for (const p of data.providers || []) {
        map[p.name] = p;
      }
      // Fill in unconfigured providers with defaults
      for (const name of Object.keys(PROVIDER_META) as ProviderName[]) {
        if (!map[name]) {
          map[name] = {
            name,
            display_name: PROVIDER_META[name].label,
            api_key: '',
            base_url: '',
            default_model: PROVIDER_META[name].models[0],
            is_default: false,
            is_active: false,
            loaded: false,
          };
        }
      }
      providers = map;
    } finally {
      loading = false;
    }
  }

  async function loadUsage() {
    const res = await fetch(`${engineUrl}/api/ai/usage?days=30`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      usage = data.usage || [];
    }
  }

  async function saveProvider(name: string) {
    saving = name;
    try {
      const p = providers[name];
      await fetch(`${engineUrl}/api/ai/providers/${name}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: p.api_key || undefined,
          base_url: p.base_url || undefined,
          default_model: p.default_model,
          is_default: p.is_default,
          is_active: p.is_active,
        }),
      });
      saved = name;
      setTimeout(() => { if (saved === name) saved = null; }, 2000);
      await loadProviders();
    } finally {
      saving = null;
    }
  }
</script>

<div class="space-y-6 max-w-2xl">
  <div>
    <h1 class="text-2xl font-bold">AI Settings</h1>
    <p class="text-base-content/60 text-sm mt-1">Configure AI providers for use across all extensions</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else}
    {#each Object.entries(PROVIDER_META) as [name, meta]}
      {@const p = providers[name]}
      <div class="card bg-base-200">
        <div class="card-body">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-3">
              <h2 class="card-title text-base">{meta.label}</h2>
              {#if p?.loaded}
                <span class="badge badge-success badge-sm">active</span>
              {/if}
            </div>
            <label class="label cursor-pointer gap-2">
              <span class="label-text text-sm">Enabled</span>
              <input
                type="checkbox"
                class="toggle toggle-sm toggle-primary"
                bind:checked={providers[name].is_active}
              />
            </label>
          </div>

          <div class="space-y-3">
            {#if meta.needsKey}
              <div class="form-control">
                <label class="label"><span class="label-text">API Key</span></label>
                <input
                  type="password"
                  bind:value={providers[name].api_key}
                  placeholder="sk-..."
                  class="input input-bordered font-mono"
                />
              </div>
            {:else}
              <div class="form-control">
                <label class="label"><span class="label-text">Base URL</span></label>
                <input
                  type="url"
                  bind:value={providers[name].base_url}
                  placeholder={meta.placeholder || ''}
                  class="input input-bordered"
                />
              </div>
            {/if}

            <div class="flex gap-3">
              <div class="form-control flex-1">
                <label class="label"><span class="label-text">Default model</span></label>
                <input
                  type="text"
                  bind:value={providers[name].default_model}
                  list="models-{name}"
                  class="input input-bordered input-sm"
                />
                <datalist id="models-{name}">
                  {#each meta.models as m}<option value={m}></option>{/each}
                </datalist>
              </div>
              <div class="form-control">
                <label class="label"><span class="label-text">Default provider</span></label>
                <input
                  type="checkbox"
                  class="checkbox mt-3"
                  bind:checked={providers[name].is_default}
                />
              </div>
            </div>
          </div>

          <div class="card-actions justify-end mt-2">
            <button class="btn btn-primary btn-sm gap-2" onclick={() => saveProvider(name)} disabled={saving === name}>
              {#if saving === name}
                <span class="loading loading-spinner loading-xs"></span>
              {:else if saved === name}
                <CheckCircle size={14} />
                Saved
              {:else}
                <Save size={14} />
                Save
              {/if}
            </button>
          </div>
        </div>
      </div>
    {/each}

    {#if usage.length > 0}
      <div class="card bg-base-200">
        <div class="card-body">
          <h2 class="card-title text-base">Usage (Last 30 days)</h2>
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead>
                <tr><th>Provider</th><th>Model</th><th>Requests</th><th>Tokens</th><th>Avg latency</th></tr>
              </thead>
              <tbody>
                {#each usage as u}
                  <tr>
                    <td>{u.provider}</td>
                    <td class="font-mono text-xs">{u.model}</td>
                    <td>{u.requests}</td>
                    <td>{(parseInt(u.prompt_tokens) + parseInt(u.response_tokens)).toLocaleString()}</td>
                    <td>{Math.round(u.avg_latency_ms)}ms</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
