<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Bot, Send, Plus, Trash2, Sparkles, Settings2, BookTemplate, Search } from '@lucide/svelte';

  let providers = $state<any[]>([]);
  let chats = $state<any[]>([]);
  let templates = $state<any[]>([]);
  let activeChat = $state<any>(null);
  let loading = $state(true);
  let activeTab = $state<'chat' | 'templates' | 'settings' | 'search'>('chat');

  // Chat state
  let input = $state('');
  let sending = $state(false);
  let messages = $state<Array<{ role: string; content: string }>>([]);

  // Semantic search state
  let searchCollection = $state('');
  let searchQuery = $state('');
  let searchResults = $state<any[]>([]);
  let searching = $state(false);
  let searchError = $state('');

  // Provider form
  let showProviderForm = $state(false);
  let providerForm = $state({ name: 'openai', label: 'OpenAI', api_key: '', base_url: '', default_model: '', is_default: false });
  let savingProvider = $state(false);

  onMount(async () => {
    await loadAll();
  });

  async function loadAll() {
    loading = true;
    const [pRes, cRes, tRes] = await Promise.allSettled([
      api.get<{ providers: any[] }>('/api/ai/providers'),
      api.get<{ chats: any[] }>('/api/ai/chats'),
      api.get<{ templates: any[] }>('/api/ai/templates'),
    ]);
    if (pRes.status === 'fulfilled') providers = pRes.value.providers || [];
    if (cRes.status === 'fulfilled') chats = cRes.value.chats || [];
    if (tRes.status === 'fulfilled') templates = tRes.value.templates || [];
    loading = false;
  }

  async function newChat() {
    const res = await api.post<{ chat: any }>('/api/ai/chats', { title: 'New Chat' });
    chats = [res.chat, ...chats];
    await openChat(res.chat);
  }

  async function openChat(chat: any) {
    const res = await api.get<{ chat: any }>(`/api/ai/chats/${chat.id}`);
    activeChat = res.chat;
    messages = res.chat.messages || [];
  }

  async function sendMessage() {
    if (!input.trim() || !activeChat || sending) return;
    const userMsg = input.trim();
    input = '';
    sending = true;

    // Optimistic update
    messages = [...messages, { role: 'user', content: userMsg }];

    try {
      const res = await api.post<{ message: any }>(`/api/ai/chats/${activeChat.id}/messages`, { content: userMsg });
      messages = [...messages, res.message];

      // Update chat title in list
      const updated = chats.map((c) => c.id === activeChat.id ? { ...c, title: userMsg.slice(0, 60) } : c);
      chats = updated;
    } catch (err: any) {
      messages = messages.slice(0, -1); // remove optimistic user message
      alert('Error: ' + err.message);
    } finally {
      sending = false;
    }
  }

  async function deleteChat(id: string) {
    await api.delete(`/api/ai/chats/${id}`);
    chats = chats.filter((c) => c.id !== id);
    if (activeChat?.id === id) { activeChat = null; messages = []; }
  }

  async function saveProvider() {
    savingProvider = true;
    try {
      await api.post('/api/ai/admin/providers', providerForm);
      await loadAll();
      showProviderForm = false;
      providerForm = { name: 'openai', label: 'OpenAI', api_key: '', base_url: '', default_model: '', is_default: false };
    } catch (err: any) {
      alert(err.message);
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
      const res = await api.post<{ results: any[]; total: number }>('/api/ai/search', {
        collection: searchCollection.trim(),
        query: searchQuery.trim(),
        limit: 10,
      });
      searchResults = res.results || [];
    } catch (err: any) {
      searchError = err.message || 'Search failed';
    } finally {
      searching = false;
    }
  }

  async function runTemplate(template: any) {
    const vars: Record<string, string> = {};
    const varDefs: any[] = typeof template.variables === 'string'
      ? JSON.parse(template.variables)
      : template.variables || [];

    for (const v of varDefs) {
      const val = prompt(`Enter value for "${v.name}":`);
      if (val !== null) vars[v.name] = val;
    }

    const res = await api.post<{ result: any }>(`/api/ai/templates/${template.id}/run`, { variables: vars });
    // Open a chat with the result
    messages = [
      { role: 'user', content: `[Template: ${template.name}]\n${Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join('\n')}` },
      { role: 'assistant', content: res.result.content },
    ];
    activeChat = null;
    activeTab = 'chat';
  }
</script>

<div class="flex h-full -m-6">
  <!-- Left sidebar: chats list -->
  <aside class="w-64 border-r border-base-300 bg-base-200 flex flex-col shrink-0">
    <!-- Header with tabs -->
    <div class="p-3 border-b border-base-300">
      <div class="flex gap-1">
        <button
          class="btn btn-xs flex-1 {activeTab === 'chat' ? 'btn-primary' : 'btn-ghost'}"
          onclick={() => (activeTab = 'chat')}
        >
          <Bot size={12} />
          Chat
        </button>
        <button
          class="btn btn-xs flex-1 {activeTab === 'templates' ? 'btn-primary' : 'btn-ghost'}"
          onclick={() => (activeTab = 'templates')}
        >
          <BookTemplate size={12} />
          Templates
        </button>
        <button
          class="btn btn-xs flex-1 {activeTab === 'settings' ? 'btn-primary' : 'btn-ghost'}"
          onclick={() => (activeTab = 'settings')}
        >
          <Settings2 size={12} />
          Settings
        </button>
        <button
          class="btn btn-xs flex-1 {activeTab === 'search' ? 'btn-primary' : 'btn-ghost'}"
          onclick={() => (activeTab = 'search')}
        >
          <Search size={12} />
          Search
        </button>
      </div>
    </div>

    {#if activeTab === 'chat'}
      <div class="p-2">
        <button class="btn btn-primary btn-sm w-full gap-1" onclick={newChat}>
          <Plus size={14} /> New Chat
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-1">
        {#each chats as chat}
          <div
            class="flex items-center gap-2 p-2 rounded-lg hover:bg-base-300 cursor-pointer {activeChat?.id === chat.id ? 'bg-base-300' : ''}"
            onclick={() => openChat(chat)}
          >
            <Bot size={14} class="shrink-0 text-base-content/50" />
            <span class="flex-1 text-xs truncate">{chat.title || 'New Chat'}</span>
            <button
              class="btn btn-ghost btn-xs text-error opacity-0 hover:opacity-100 group-hover:opacity-100"
              onclick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        {/each}
        {#if chats.length === 0}
          <p class="text-xs text-center text-base-content/40 py-4">No chats yet</p>
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
                <Sparkles size={10} />
                Run
              </button>
            </div>
          </div>
        {/each}
        {#if templates.length === 0}
          <p class="text-xs text-center text-base-content/40 py-4">No templates</p>
        {/if}
      </div>

    {:else if activeTab === 'search'}
      <div class="flex-1 p-3 space-y-3">
        <p class="text-xs text-base-content/60">
          Caută semantic în colecțiile cu AI Search activat.
        </p>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Colecție</span></label>
          <input
            type="text"
            class="input input-bordered input-xs"
            placeholder="ex: articles"
            bind:value={searchCollection}
          />
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-xs">Query semantic</span></label>
          <textarea
            class="textarea textarea-bordered textarea-xs resize-none"
            rows={3}
            placeholder="ex: articole despre machine learning în producție"
            bind:value={searchQuery}
          ></textarea>
        </div>
        <button
          class="btn btn-primary btn-sm w-full"
          onclick={semanticSearch}
          disabled={searching || !searchCollection || !searchQuery}
        >
          {#if searching}
            <span class="loading loading-spinner loading-xs"></span>
          {:else}
            <Search size={12} />
          {/if}
          Caută
        </button>
      </div>

    {:else if activeTab === 'settings'}
      <div class="flex-1 overflow-y-auto p-3 space-y-3">
        <div>
          <p class="text-xs font-semibold text-base-content/60 uppercase mb-2">AI Providers</p>
          {#each providers as provider}
            <div class="card bg-base-100 shadow-sm mb-2">
              <div class="card-body p-3 gap-1">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-xs">{provider.label}</span>
                  {#if provider.isDefault}
                    <span class="badge badge-xs badge-primary">default</span>
                  {/if}
                </div>
                <p class="text-xs font-mono text-base-content/50">{provider.name}</p>
              </div>
            </div>
          {/each}
          <button class="btn btn-sm btn-outline w-full" onclick={() => (showProviderForm = !showProviderForm)}>
            <Plus size={14} />
            Add Provider
          </button>
        </div>

        {#if showProviderForm}
          <div class="card bg-base-100 shadow-sm">
            <div class="card-body p-3 gap-2">
              <select bind:value={providerForm.name} class="select select-bordered select-xs">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama (local)</option>
                <option value="custom">Custom</option>
              </select>
              {#if providerForm.name === 'custom'}
                <input type="text" bind:value={providerForm.label} placeholder="Label" class="input input-bordered input-xs" />
              {/if}
              {#if providerForm.name !== 'ollama'}
                <input type="password" bind:value={providerForm.api_key} placeholder="API Key" class="input input-bordered input-xs" />
              {/if}
              {#if providerForm.name === 'ollama' || providerForm.name === 'custom'}
                <input type="text" bind:value={providerForm.base_url} placeholder="Base URL" class="input input-bordered input-xs" />
              {/if}
              <input type="text" bind:value={providerForm.default_model} placeholder="Default model" class="input input-bordered input-xs" />
              <label class="flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" bind:checked={providerForm.is_default} class="checkbox checkbox-xs" />
                Set as default
              </label>
              <div class="flex gap-1">
                <button class="btn btn-primary btn-xs flex-1" onclick={saveProvider} disabled={savingProvider}>
                  {savingProvider ? 'Saving…' : 'Save'}
                </button>
                <button class="btn btn-ghost btn-xs" onclick={() => (showProviderForm = false)}>Cancel</button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </aside>

  <!-- Main chat area -->
  <div class="flex-1 flex flex-col bg-base-100">
    {#if !activeChat && activeTab === 'chat'}
      <div class="flex-1 flex flex-col items-center justify-center text-base-content/40 gap-3">
        <Bot size={48} class="opacity-20" />
        <p class="text-lg font-semibold">AI Assistant</p>
        <p class="text-sm">Start a new chat or select an existing one</p>
        {#if providers.length === 0}
          <p class="text-sm text-warning">No AI provider configured. Add one in Settings.</p>
        {/if}
        <button class="btn btn-primary" onclick={newChat}>
          <Plus size={16} />
          New Chat
        </button>
      </div>
    {:else if activeTab === 'chat' || !activeChat}
      <!-- Chat messages -->
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {#if messages.length === 0}
          <div class="text-center text-base-content/40 py-8">
            <Sparkles size={32} class="mx-auto mb-2 opacity-30" />
            <p>Send a message to start the conversation</p>
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

      <!-- Input area -->
      {#if activeChat}
        <div class="p-4 border-t border-base-300">
          <div class="flex gap-2 items-end">
            <textarea
              bind:value={input}
              onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
              class="textarea textarea-bordered flex-1 resize-none min-h-[44px] max-h-32 text-sm"
              rows={1}
            ></textarea>
            <button
              class="btn btn-primary btn-sm h-11"
              onclick={sendMessage}
              disabled={!input.trim() || sending}
            >
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
          <div class="flex justify-center py-12">
            <span class="loading loading-spinner loading-lg text-primary"></span>
          </div>
        {:else if searchResults.length > 0}
          <div class="space-y-3">
            <p class="text-sm text-base-content/60">{searchResults.length} rezultate pentru <strong>"{searchQuery}"</strong> în <code class="text-primary">{searchCollection}</code></p>
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
                      <div class="badge badge-primary badge-outline shrink-0 text-xs">
                        {(result._score * 100).toFixed(1)}%
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {:else if searchQuery && !searching}
          <div class="flex flex-col items-center justify-center py-16 text-base-content/40 gap-3">
            <Search size={40} class="opacity-20" />
            <p>Niciun rezultat. Verifică că AI Search e activat pe colecție.</p>
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center py-16 text-base-content/40 gap-3">
            <Search size={48} class="opacity-20" />
            <p class="text-lg font-semibold">Semantic Search</p>
            <p class="text-sm text-center max-w-sm">
              Introdu o colecție și un query în sidebar pentru a căuta semantic în recorduri.
              AI Search trebuie activat pe colecție (Collections → AI Search tab).
            </p>
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex-1 flex items-center justify-center text-base-content/40">
        <p>Select a tab on the left</p>
      </div>
    {/if}
  </div>
</div>
