<script lang="ts">
 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 interface Message {
 role: 'system' | 'user' | 'assistant';
 content: string;
 }

 let messages = $state<Message[]>([]);
 let systemPrompt = $state('You are a helpful assistant.');
 let input = $state('');
 let provider = $state('');
 let model = $state('');
 let temperature = $state(0.7);
 let loading = $state(false);
 let providers = $state<string[]>([]);
 let showSystem = $state(false);

 async function loadProviders() {
 const res = await fetch(`${engineUrl}/api/ai/providers`, { credentials: 'include' });
 const data = await res.json();
 providers = (data.providers || []).filter((p: any) => p.loaded).map((p: any) => p.name);
 if (providers.length > 0 && !provider) provider = providers[0];
 }

 loadProviders();

 async function sendMessage() {
 if (!input.trim() || loading) return;

 const userMsg: Message = { role: 'user', content: input };
 messages = [...messages, userMsg];
 input = '';
 loading = true;

 try {
 const allMessages: Message[] = [
 ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
 ...messages,
 ];

 const res = await fetch(`${engineUrl}/api/ai/chat`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 messages: allMessages,
 provider: provider || undefined,
 model: model || undefined,
 temperature,
 }),
 });

 const data = await res.json();

 if (!res.ok) {
 messages = [...messages, { role: 'assistant', content: `Error: ${data.error}` }];
 } else {
 messages = [...messages, { role: 'assistant', content: data.result.content }];
 }
 } finally {
 loading = false;
 }
 }

 function clearChat() {
 messages = [];
 }

 function handleKeydown(e: KeyboardEvent) {
 if (e.key === 'Enter' && !e.shiftKey) {
 e.preventDefault();
 sendMessage();
 }
 }
</script>

<div class="flex flex-col h-[calc(100vh-8rem)] max-w-3xl">
 <div class="flex items-center justify-between mb-4">
 <h1 class="text-2xl font-bold">AI Playground</h1>
 <div class="flex items-center gap-2">
 <select bind:value={provider} class="select select-sm">
 <option value="">Default provider</option>
 {#each providers as p}<option value={p}>{p}</option>{/each}
 </select>
 <input
 type="text"
 bind:value={model}
 placeholder="Model (optional)"
 class="input input-sm w-40"
 />
 <button class="btn btn-ghost btn-sm" onclick={() => (showSystem = !showSystem)}>
 System
 </button>
 <button class="btn btn-ghost btn-sm" onclick={clearChat}>Clear</button>
 </div>
 </div>

 {#if showSystem}
 <div class="mb-3">
 <textarea
 bind:value={systemPrompt}
 placeholder="System prompt..."
 class="textarea w-full text-sm font-mono"
 rows="3"
 ></textarea>
 </div>
 {/if}

 <!-- Chat history -->
 <div class="flex-1 overflow-y-auto space-y-3 mb-4 pr-1">
 {#if messages.length === 0}
 <div class="text-center text-base-content/40 py-12">
 <p class="text-lg">AI Playground</p>
 <p class="text-sm mt-1">Send a message to start chatting</p>
 </div>
 {/if}

 {#each messages as msg}
 <div class="chat {msg.role === 'user' ? 'chat-end' : 'chat-start'}">
 <div class="chat-bubble {msg.role === 'user' ? 'chat-bubble-primary' : 'bg-base-300 text-base-content'}">
 <pre class="whitespace-pre-wrap text-sm font-sans">{msg.content}</pre>
 </div>
 </div>
 {/each}

 {#if loading}
 <div class="chat chat-start">
 <div class="chat-bubble bg-base-300">
 <span class="loading loading-dots loading-sm"></span>
 </div>
 </div>
 {/if}
 </div>

 <!-- Input area -->
 <div class="flex gap-2">
 <textarea
 bind:value={input}
 onkeydown={handleKeydown}
 placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
 class="textarea flex-1 resize-none"
 rows="2"
 disabled={loading}
 ></textarea>
 <div class="flex flex-col gap-2">
 <button
 class="btn btn-primary h-full px-6"
 onclick={sendMessage}
 disabled={loading || !input.trim()}
 >
 Send
 </button>
 </div>
 </div>

 <div class="flex items-center gap-3 mt-2 text-xs text-base-content/40">
 <label class="flex items-center gap-1">
 Temperature:
 <input type="range" bind:value={temperature} min="0" max="2" step="0.1" class="range range-xs w-24" />
 <span>{temperature}</span>
 </label>
 </div>
</div>
