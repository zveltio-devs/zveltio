<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import {
  Bot,
  Send,
  Plus,
  Trash2,
  Sparkles,
  Settings2,
  BookTemplate,
  Search,
  Code2,
  Wand2,
  MessageSquare,
  FileText,
} from '@lucide/svelte';
import { toast } from '$lib/stores/toast.svelte.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let providers = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let chats = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let templates = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let activeChat = $state<any>(null);
let activeTab = $state<'chat' | 'templates' | 'settings' | 'search' | 'query' | 'schema'>('chat');

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
const AI_TABS: Array<{ id: typeof activeTab; labelKey: string; icon: any }> = [
  { id: 'chat', labelKey: 'ai.tab.chat', icon: MessageSquare },
  { id: 'search', labelKey: 'ai.tab.search', icon: Search },
  { id: 'query', labelKey: 'ai.tab.query', icon: Code2 },
  { id: 'schema', labelKey: 'ai.tab.schema', icon: Wand2 },
  { id: 'templates', labelKey: 'ai.tab.templates', icon: BookTemplate },
  { id: 'settings', labelKey: 'ai.tab.settings', icon: Settings2 },
];

let input = $state('');
let sending = $state(false);
let messages = $state<Array<{ role: string; content: string }>>([]);

let searchCollection = $state('');
let searchQuery = $state('');
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let searchResults = $state<any[]>([]);
let searching = $state(false);
let searchError = $state('');

let queryPrompt = $state('');
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let queryResult = $state<{ sql: string; data: any[]; columns: string[] } | null>(null);
let queryRunning = $state(false);

let schemaDescription = $state('');
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let schemaResult = $state<any | null>(null);
let schemaGenerating = $state(false);

let showProviderForm = $state(false);
let providerForm = $state({
  name: 'openai',
  label: 'OpenAI',
  api_key: '',
  base_url: '',
  default_model: '',
  is_default: false,
});
let savingProvider = $state(false);

onMount(loadAll);

async function loadAll() {
  const [pRes, cRes, tRes] = await Promise.allSettled([
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    api.get<{ providers: any[] }>('/ext/ai/providers'),
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    api.get<{ chats: any[] }>('/ext/ai/chats'),
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    api.get<{ templates: any[] }>('/ext/ai/templates'),
  ]);
  if (pRes.status === 'fulfilled') providers = pRes.value.providers || [];
  if (cRes.status === 'fulfilled') chats = cRes.value.chats || [];
  if (tRes.status === 'fulfilled') templates = tRes.value.templates || [];
}

async function newChat() {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const res = await api.post<{ chat: any }>('/ext/ai/chats', { title: 'New Chat' });
  chats = [res.chat, ...chats];
  await openChat(res.chat);
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function openChat(chat: any) {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const res = await api.get<{ chat: any }>(`/ext/ai/chats/${chat.id}`);
  activeChat = res.chat;
  messages = res.chat.messages || [];
}

async function sendMessage() {
  if (!input.trim() || !activeChat || sending) return;
  const userMsg = input.trim();
  input = '';
  sending = true;
  messages = [...messages, { role: 'user', content: userMsg }];
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.post<{ message: any }>(`/ext/ai/chats/${activeChat.id}/messages`, {
      content: userMsg,
    });
    messages = [...messages, res.message];
    chats = chats.map((c) => (c.id === activeChat.id ? { ...c, title: userMsg.slice(0, 60) } : c));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    messages = messages.slice(0, -1);
    toast.error(m['ext.errorPrefix']() + err.message);
  } finally {
    sending = false;
  }
}

async function deleteChat(id: string) {
  await api.delete(`/ext/ai/chats/${id}`);
  chats = chats.filter((c) => c.id !== id);
  if (activeChat?.id === id) {
    activeChat = null;
    messages = [];
  }
}

async function saveProvider() {
  savingProvider = true;
  try {
    // Providers are upserted with PUT /providers/:name — the name is the
    // path, and empty optionals must be omitted (base_url is url-validated).
    const { name, ...rest } = providerForm;
    const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '' && v !== null));
    await api.put(`/ext/ai/providers/${encodeURIComponent(name)}`, body);
    await loadAll();
    showProviderForm = false;
    providerForm = {
      name: 'openai',
      label: 'OpenAI',
      api_key: '',
      base_url: '',
      default_model: '',
      is_default: false,
    };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message);
  } finally {
    savingProvider = false;
  }
}

async function semanticSearch() {
  if (!searchCollection.trim() || !searchQuery.trim()) return;
  searching = true;
  searchError = '';
  searchResults = [];
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.post<{ results: any[]; total: number }>('/ext/ai/search', {
      collection: searchCollection.trim(),
      query: searchQuery.trim(),
      limit: 10,
    });
    searchResults = res.results || [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    searchError = err.message || m['ai.error.searchFailed']();
  } finally {
    searching = false;
  }
}

async function runAiQuery() {
  if (!queryPrompt.trim() || queryRunning) return;
  queryRunning = true;
  queryResult = null;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.post<{ sql: string; data: any[]; columns: string[] }>('/ext/ai/query', {
      prompt: queryPrompt.trim(),
    });
    queryResult = res;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message ?? 'Query failed');
  } finally {
    queryRunning = false;
  }
}

async function generateSchema() {
  if (!schemaDescription.trim() || schemaGenerating) return;
  schemaGenerating = true;
  schemaResult = null;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.post<{ schema: any }>('/ext/ai/preview-schema', {
      description: schemaDescription.trim(),
    });
    schemaResult = res.schema;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message ?? 'Schema generation failed');
  } finally {
    schemaGenerating = false;
  }
}

async function applySchema() {
  if (!schemaResult) return;
  try {
    await api.post('/api/collections', schemaResult);
    toast.success(m['ext.saved']());
    schemaResult = null;
    schemaDescription = '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err.message ?? 'Failed to create collection');
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function runTemplate(template: any) {
  const vars: Record<string, string> = {};
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const varDefs: any[] =
    typeof template.variables === 'string'
      ? JSON.parse(template.variables)
      : template.variables || [];
  for (const v of varDefs) {
    const val = prompt(`Enter value for "${v.name}":`);
    if (val !== null) vars[v.name] = val;
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const res = await api.post<{ result: any }>(`/ext/ai/templates/${template.id}/run`, {
    variables: vars,
  });
  messages = [
    {
      role: 'user',
      content: `[Template: ${template.name}]\n${Object.entries(vars)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}`,
    },
    { role: 'assistant', content: res.result.content },
  ];
  activeChat = null;
  activeTab = 'chat';
}
</script>

<ExtensionPageShell title={m['ai.title']()} subtitle={m['ai.subtitle']()}>
<div class="flex h-[calc(100vh-10rem)] -mx-4 -mb-4">
  <aside class="w-64 border-r border-base-300 bg-base-200 flex flex-col shrink-0">
    <div class="px-2 pt-3 pb-2 space-y-0.5">
      {#each AI_TABS as tab}
        <button
          class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12px] font-medium transition-colors
                 {activeTab === tab.id ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-200 hover:text-base-content'}"
          onclick={() => (activeTab = tab.id)}
        >
          <tab.icon size={14} class="shrink-0" />
          {m[tab.labelKey]()}
        </button>
      {/each}
    </div>
    <div class="border-b border-base-300"></div>

    {#if activeTab === 'chat'}
      <div class="p-2">
        <button class="btn btn-primary btn-sm w-full gap-1" onclick={newChat}><Plus size={14} /> {m['ai.action.newChat']()}</button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-1">
        {#each chats as chat}
          <div
            class="flex items-center gap-2 p-2 rounded-lg hover:bg-base-300 cursor-pointer {activeChat?.id === chat.id ? 'bg-base-300' : ''}"
            role="button" tabindex="0"
            onclick={() => openChat(chat)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openChat(chat)}
          >
            <Bot size={14} class="shrink-0 text-base-content/50" />
            <span class="flex-1 text-xs truncate">{chat.title || m['ai.chat.newChat']()}</span>
            <button
              class="btn btn-ghost btn-xs text-error opacity-0 hover:opacity-100"
              onclick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
            ><Trash2 size={10} /></button>
          </div>
        {/each}
        {#if chats.length === 0}
          <p class="text-xs text-center text-base-content/40 py-4">{m['ai.chat.emptyChats']()}</p>
        {/if}
      </div>

    {:else if activeTab === 'templates'}
      <div class="flex-1 overflow-y-auto p-2 space-y-2">
        {#each templates as template}
          <div class="card bg-base-100 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-start justify-between gap-1">
                <div>
                  <p class="font-semibold text-xs">{template.name}</p>
                  {#if template.description}
                    <p class="text-xs text-base-content/50 mt-0.5">{template.description}</p>
                  {/if}
                </div>
                <span class="badge badge-xs badge-outline">{template.category}</span>
              </div>
              <button class="btn btn-xs btn-primary mt-1" onclick={() => runTemplate(template)}>
                <Sparkles size={10} /> {m['ai.templates.run']()}
              </button>
            </div>
          </div>
        {/each}
        {#if templates.length === 0}
          <p class="text-xs text-center text-base-content/40 py-4">{m['ai.templates.empty']()}</p>
        {/if}
      </div>

    {:else if activeTab === 'search'}
      <div class="flex-1 p-3 space-y-3">
        <p class="text-xs text-base-content/60">{m['ai.search.hint']()}</p>
        <div class="form-control">
          <label class="label py-1" for="ai-search-col"><span class="label-text text-xs">{m['ai.search.collection']()}</span></label>
          <input id="ai-search-col" type="text" class="input input-xs" placeholder={m['ai.search.placeholder']()} bind:value={searchCollection} />
        </div>
        <div class="form-control">
          <label class="label py-1" for="ai-search-q"><span class="label-text text-xs">{m['ai.search.queryLabel']()}</span></label>
          <textarea id="ai-search-q" class="textarea textarea-xs resize-none" rows={3}
            placeholder={m['ai.search.queryPlaceholder']()} bind:value={searchQuery}></textarea>
        </div>
        <button class="btn btn-primary btn-sm w-full" onclick={semanticSearch}
          disabled={searching || !searchCollection || !searchQuery}>
          {#if searching}<span class="loading loading-spinner loading-xs"></span>{:else}<Search size={12} />{/if}{m['ai.search.btn']()}
        </button>
      </div>

    {:else if activeTab === 'settings'}
      <div class="flex-1 overflow-y-auto p-3 space-y-3">
        <p class="text-xs font-semibold text-base-content/60 uppercase mb-2">{m['ai.providers.title']()}</p>
        {#each providers as provider}
          <div class="card bg-base-100 shadow-sm mb-2">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center gap-2">
                <span class="font-semibold text-xs">{provider.label}</span>
                {#if provider.isDefault}<span class="badge badge-xs badge-primary">{m['ai.providers.default']()}</span>{/if}
              </div>
              <p class="text-xs font-mono text-base-content/50">{provider.name}</p>
            </div>
          </div>
        {/each}
        <button class="btn btn-sm btn-outline w-full" onclick={() => (showProviderForm = !showProviderForm)}>
          <Plus size={14} /> {m['ai.providers.add']()}
        </button>
        {#if showProviderForm}
          <div class="card bg-base-100 shadow-sm">
            <div class="card-body p-3 gap-2">
              <select bind:value={providerForm.name} class="select select-xs">
                <option value="openai">{m['ai.provider.openai']()}</option>
                <option value="anthropic">{m['ai.provider.anthropic']()}</option>
                <option value="ollama">{m['ai.provider.ollama']()}</option>
                <option value="custom">{m['ai.provider.custom']()}</option>
              </select>
              {#if providerForm.name === 'custom'}
                <input type="text" bind:value={providerForm.label} placeholder={m['ai.provider.label']()} class="input input-xs" />
              {/if}
              {#if providerForm.name !== 'ollama'}
                <input type="password" bind:value={providerForm.api_key} placeholder={m['ai.provider.apiKey']()} class="input input-xs" />
              {/if}
              {#if providerForm.name === 'ollama' || providerForm.name === 'custom'}
                <input type="text" bind:value={providerForm.base_url} placeholder={m['ai.provider.baseUrl']()} class="input input-xs" />
              {/if}
              <input type="text" bind:value={providerForm.default_model} placeholder={m['ai.provider.defaultModel']()} class="input input-xs" />
              <label class="flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" bind:checked={providerForm.is_default} class="checkbox checkbox-xs" />
                {m['ai.providers.setDefault']()}
              </label>
              <div class="flex gap-1">
                <button class="btn btn-primary btn-xs flex-1" onclick={saveProvider} disabled={savingProvider}>
                  {savingProvider ? m['ai.providers.saving']() : m['common.save']()}}
                </button>
                <button class="btn btn-ghost btn-xs" onclick={() => (showProviderForm = false)}>{m['common.cancel']()}</button>
              </div>
            </div>
          </div>
        {/if}
      </div>

    {:else if activeTab === 'query'}
      <div class="flex-1 p-3 space-y-3">
        <p class="text-xs text-base-content/60">{m['ai.query.hint']()}</p>
        <textarea class="textarea textarea-xs w-full resize-none" rows={4}
          placeholder={m['ai.query.placeholder']()}
          bind:value={queryPrompt}
          onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAiQuery(); }}
        ></textarea>
        <button class="btn btn-primary btn-sm w-full" onclick={runAiQuery} disabled={queryRunning || !queryPrompt.trim()}>
          {#if queryRunning}<span class="loading loading-spinner loading-xs"></span>{:else}<Code2 size={12} />{/if}{m['ai.action.runQuery']()}
        </button>
      </div>

    {:else if activeTab === 'schema'}
      <div class="flex-1 p-3 space-y-3">
        <p class="text-xs text-base-content/60">{m['ai.schema.hint']()}</p>
        <textarea class="textarea textarea-xs w-full resize-none" rows={5}
          placeholder={m['ai.schema.placeholder']()}
          bind:value={schemaDescription}
        ></textarea>
        <button class="btn btn-primary btn-sm w-full" onclick={generateSchema} disabled={schemaGenerating || !schemaDescription.trim()}>
          {#if schemaGenerating}<span class="loading loading-spinner loading-xs"></span>{:else}<Wand2 size={12} />{/if}{m['ai.action.generateSchema']()}
        </button>
      </div>
    {/if}
  </aside>

  <div class="flex-1 flex flex-col bg-base-100">
    {#if activeTab === 'chat' && (!activeChat || messages.length === 0)}
      <div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
        <div class="p-4 rounded-2xl bg-primary/5"><Bot size={40} class="text-primary/60" /></div>
        <div class="text-center max-w-sm">
          <h2 class="font-semibold text-lg">{m['ai.studio.title']()}</h2>
          <p class="text-sm text-base-content/50 mt-1">{m['ai.studio.subtitle']()}</p>
          {#if providers.length === 0}
            <p class="text-sm text-warning mt-2">{m['ai.studio.noProvider']()}
              <button class="underline" onclick={() => activeTab = 'settings'}>{m['ai.studio.addProvider']()}</button>
            </p>
          {/if}
        </div>
        <div class="grid grid-cols-2 gap-2 w-full max-w-md">
          {#each [
            m['ai.prompt.collectionsCounts'](),
            m['ai.prompt.ecommerceSchema'](),
            m['ai.prompt.pendingRecords'](),
            m['ai.prompt.activeCollections']()
          ] as prompt}
            <button
              class="text-left p-3 rounded-lg border border-base-300 text-xs text-base-content/60 hover:border-primary/40 hover:text-base-content transition-all"
              onclick={async () => { if (!activeChat) await newChat(); input = prompt; }}
            >{prompt}</button>
          {/each}
        </div>
        {#if !activeChat}
          <button class="btn btn-primary btn-sm" onclick={newChat}><Plus size={14} /> {m['ai.action.newChat']()}</button>
        {/if}
      </div>

    {:else if activeTab === 'chat'}
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {#if messages.length === 0}
          <div class="text-center text-base-content/40 py-8">
            <Sparkles size={32} class="mx-auto mb-2 opacity-30" />
            <p>{m['ai.chat.startConversation']()}</p>
          </div>
        {/if}
        {#each messages as msg}
          <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2">
            {#if msg.role !== 'user'}
              <div class="w-7 h-7 bg-primary/20 rounded-full flex items-center justify-center shrink-0 mt-1">
                <Bot size={14} class="text-primary" />
              </div>
            {/if}
            <div class="max-w-xl">
              <div class="rounded-2xl px-4 py-2.5 {msg.role === 'user' ? 'bg-primary text-primary-content rounded-tr-none' : 'bg-base-200 rounded-tl-none'}">
                <p class="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          </div>
        {/each}
        {#if sending}
          <div class="flex justify-start gap-2">
            <div class="w-7 h-7 bg-primary/20 rounded-full flex items-center justify-center shrink-0">
              <Bot size={14} class="text-primary" />
            </div>
            <div class="bg-base-200 rounded-2xl rounded-tl-none px-4 py-3">
              <span class="loading loading-dots loading-sm"></span>
            </div>
          </div>
        {/if}
      </div>
      {#if activeChat}
        <div class="p-4 border-t border-base-300">
          <div class="flex gap-2 items-end">
            <textarea
              bind:value={input}
              onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder={m['ai.chat.messagePlaceholder']()}
              class="textarea flex-1 resize-none min-h-11 max-h-32 text-sm" rows={1}
            ></textarea>
            <button class="btn btn-primary btn-sm h-11" onclick={sendMessage} disabled={!input.trim() || sending}>
              <Send size={16} />
            </button>
          </div>
        </div>
      {/if}

    {:else if activeTab === 'search'}
      <div class="flex-1 overflow-y-auto p-6">
        {#if searchError}
          <div class="alert alert-error mb-4 text-sm">{searchError}</div>
        {/if}
        {#if searching}
          <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg text-primary"></span></div>
        {:else if searchResults.length > 0}
          <div class="space-y-3">
            <p class="text-sm text-base-content/60">{m['ai.search.resultsCount']().replace('{count}', String(searchResults.length))} <strong>"{searchQuery}"</strong> {m['ai.search.inCollection']()} <code class="text-primary">{searchCollection}</code></p>
            {#each searchResults as result}
              <div class="card bg-base-200 hover:bg-base-300 transition-colors">
                <div class="card-body p-4">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                      <p class="font-mono text-xs text-base-content/50 mb-1">{result.id}</p>
                      {#each Object.entries(result).filter(([k]) => !['id', 'created_at', 'updated_at', 'created_by', 'updated_by', '_score'].includes(k)) as [key, val]}
                        {#if val != null && String(val).length > 0}
                          <div class="flex gap-2 text-sm mb-0.5">
                            <span class="text-base-content/50 shrink-0 font-medium">{key}:</span>
                            <span class="truncate">{String(val).slice(0, 200)}</span>
                          </div>
                        {/if}
                      {/each}
                    </div>
                    {#if result._score != null}
                      <div class="badge badge-primary badge-outline shrink-0 text-xs">{(result._score * 100).toFixed(1)}%</div>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center py-16 text-base-content/40 gap-3">
            <Search size={48} class="opacity-20" />
            <p class="text-lg font-semibold">{m['ai.tab.search']()}</p>
            <p class="text-sm text-center max-w-sm">{m['ai.search.emptyHint']()}</p>
          </div>
        {/if}
      </div>

    {:else if activeTab === 'query'}
      <div class="flex-1 overflow-auto p-6">
        {#if queryRunning}
          <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg text-primary"></span></div>
        {:else if queryResult}
          <div class="space-y-4">
            <div class="rounded-lg bg-base-200 p-4">
              <p class="text-xs font-semibold text-base-content/50 uppercase mb-2">{m['ai.query.generatedSql']()}</p>
              <pre class="text-xs font-mono whitespace-pre-wrap text-primary">{queryResult.sql}</pre>
            </div>
            {#if queryResult.data.length > 0}
              <div class="overflow-x-auto rounded-lg border border-base-300">
                <table class="table table-xs table-zebra">
                  <thead><tr>{#each queryResult.columns as col}<th>{col}</th>{/each}</tr></thead>
                  <tbody>
                    {#each queryResult.data as row}
                      <tr>{#each queryResult.columns as col}<td class="max-w-xs truncate">{row[col] ?? ''}</td>{/each}</tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              <p class="text-xs text-base-content/40">{queryResult.data.length} {m['ai.query.rowsReturned']()}</p>
            {:else}
              <p class="text-sm text-base-content/40 text-center py-4">{m['ai.query.noRows']()}</p>
            {/if}
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center h-full text-base-content/40 gap-3">
            <Code2 size={48} class="opacity-20" />
            <p class="text-lg font-semibold">{m['ai.query.title']()}</p>
            <p class="text-sm text-center max-w-sm">{m['ai.query.emptyHint']()}</p>
          </div>
        {/if}
      </div>

    {:else if activeTab === 'schema'}
      <div class="flex-1 overflow-auto p-6">
        {#if schemaGenerating}
          <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg text-primary"></span></div>
        {:else if schemaResult}
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h2 class="font-bold text-lg">{m['ai.schema.generated']()}: <code class="text-primary">{schemaResult.name}</code></h2>
              <div class="flex gap-2">
                <button class="btn btn-ghost btn-sm" onclick={() => (schemaResult = null)}>{m['common.discard']()}</button>
                <button class="btn btn-primary btn-sm" onclick={applySchema}><Plus size={14} /> {m['ai.action.createCollection']()}</button>
              </div>
            </div>
            <div class="overflow-x-auto rounded-lg border border-base-300">
              <table class="table table-sm">
                <thead><tr><th>{m['common.col.field']()}</th><th>{m['common.col.type']()}</th><th>{m['common.col.label']()}</th><th>{m['common.col.required']()}</th><th>{m['common.col.unique']()}</th></tr></thead>
                <tbody>
                  {#each (schemaResult.fields || []) as field}
                    <tr>
                      <td class="font-mono text-xs">{field.name}</td>
                      <td><span class="badge badge-sm badge-outline">{field.type}</span></td>
                      <td class="text-sm">{field.label || ''}</td>
                      <td>{field.required ? '✓' : ''}</td>
                      <td>{field.unique ? '✓' : ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <details class="collapse collapse-arrow border border-base-300 rounded-lg">
              <summary class="collapse-title text-xs font-semibold">{m['ai.schema.rawJson']()}</summary>
              <div class="collapse-content"><pre class="text-xs font-mono whitespace-pre-wrap">{JSON.stringify(schemaResult, null, 2)}</pre></div>
            </details>
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center h-full text-base-content/40 gap-3">
            <Wand2 size={48} class="opacity-20" />
            <p class="text-lg font-semibold">{m['ai.schema.title']()}</p>
            <p class="text-sm text-center max-w-sm">{m['ai.schema.emptyHint']()}</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
</ExtensionPageShell>
