<script lang="ts">
/**
 * AI chat workspace — Tier-3 (request/response; streaming needs engine later).
 *
 * Uses `/ext/ai/chats` session API. Prefill via `?q=` from the topbar prompt.
 */
import { page } from '$app/state';
import { base } from '$app/paths';
import { goto } from '$app/navigation';
import { MessageSquarePlus, Send, Trash2, Bot, User } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';

type ChatSummary = {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  updated_at: string;
};

type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

let chats = $state<ChatSummary[]>([]);
let activeId = $state<string | null>(null);
let messages = $state<ChatMessage[]>([]);
let draft = $state('');
let loadingList = $state(true);
let loadingChat = $state(false);
let sending = $state(false);
let listError = $state<string | null>(null);
let prefillDone = $state(false);

const activeTitle = $derived(
  chats.find((c) => c.id === activeId)?.title ??
    (m['ai.chat.newChat']?.() ?? 'New Chat'),
);

async function loadChats(): Promise<void> {
  loadingList = true;
  listError = null;
  try {
    const r = await api.get<{ chats?: ChatSummary[] }>('/ext/ai/chats');
    chats = r.chats ?? [];
  } catch (err) {
    listError = err instanceof Error ? err.message : 'Failed to load chats';
    chats = [];
  } finally {
    loadingList = false;
  }
}

async function openChat(id: string): Promise<void> {
  if (sending) return;
  activeId = id;
  loadingChat = true;
  messages = [];
  try {
    const r = await api.get<{ chat?: { messages?: ChatMessage[] } }>(`/ext/ai/chats/${id}`);
    messages = (r.chat?.messages ?? []).filter((msg) => msg.role !== 'system');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to open chat');
    activeId = null;
  } finally {
    loadingChat = false;
  }
}

async function createChat(firstMessage?: string): Promise<string | null> {
  try {
    const r = await api.post<{ chat?: ChatSummary }>('/ext/ai/chats', {
      title: firstMessage?.slice(0, 60) || undefined,
    });
    const id = r.chat?.id;
    if (!id) throw new Error('No chat id returned');
    await loadChats();
    activeId = id;
    messages = [];
    return id;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not create chat');
    return null;
  }
}

async function deleteChat(id: string): Promise<void> {
  const ok = confirm(m['ai.chat.deleteMessage']?.() ?? 'Delete this chat permanently?');
  if (!ok) return;
  try {
    await api.delete(`/ext/ai/chats/${id}`);
    if (activeId === id) {
      activeId = null;
      messages = [];
    }
    await loadChats();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Delete failed');
  }
}

async function send(): Promise<void> {
  const content = draft.trim();
  if (!content || sending) return;

  sending = true;
  draft = '';
  let id = activeId;
  try {
    if (!id) {
      id = await createChat(content);
      if (!id) return;
    }
    messages = [...messages, { role: 'user', content }];
    const r = await api.post<{ message?: ChatMessage }>(`/ext/ai/chats/${id}/messages`, {
      content,
    });
    if (r.message) {
      messages = [...messages, r.message];
    }
    await loadChats();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Send failed');
    // Keep the user message visible; they can retry.
  } finally {
    sending = false;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

$effect(() => {
  void loadChats();
});

// One-shot prefill from topbar `?q=`
$effect(() => {
  const q = page.url.searchParams.get('q')?.trim();
  if (!q || prefillDone) return;
  prefillDone = true;
  draft = q;
  // Drop the query so refresh doesn't resend.
  void goto(`${base}/ai/chat`, { replaceState: true, keepFocus: true });
});
</script>

<div class="flex h-[calc(100vh-8rem)] min-h-[28rem] gap-0 border border-base-300 rounded-xl overflow-hidden bg-base-100">
  <!-- Session list -->
  <aside class="w-64 shrink-0 border-r border-base-300 flex flex-col bg-base-200/40">
    <div class="p-3 border-b border-base-300 flex items-center justify-between gap-2">
      <h2 class="font-semibold text-sm truncate">{m['ai.tab.chat']?.() ?? 'Chat'}</h2>
      <button
        type="button"
        class="btn btn-ghost btn-xs gap-1"
        aria-label={m['ai.action.newChat']?.() ?? 'New chat'}
        onclick={() => {
          activeId = null;
          messages = [];
          draft = '';
        }}
      >
        <MessageSquarePlus size={14} />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if loadingList}
        <div class="p-4 text-sm opacity-60">…</div>
      {:else if listError}
        <div class="p-4 text-sm text-error">{listError}</div>
      {:else if chats.length === 0}
        <div class="p-4 text-sm opacity-60">{m['ai.chat.emptyChats']?.() ?? 'No chats yet'}</div>
      {:else}
        <ul class="menu menu-sm p-2 gap-0.5">
          {#each chats as chat (chat.id)}
            <li>
              <div
                class="flex items-center gap-1 {activeId === chat.id ? 'active' : ''}"
              >
                <button
                  type="button"
                  class="flex-1 text-left truncate min-w-0"
                  onclick={() => void openChat(chat.id)}
                >
                  {chat.title || (m['ai.chat.newChat']?.() ?? 'New Chat')}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs text-error shrink-0"
                  aria-label={m['ai.chat.deleteAria']?.() ?? 'Delete chat'}
                  onclick={(e) => {
                    e.stopPropagation();
                    void deleteChat(chat.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="p-2 border-t border-base-300 text-xs opacity-50">
      <a href="{base}/ai" class="link link-hover">Templates & history →</a>
    </div>
  </aside>

  <!-- Thread -->
  <section class="flex-1 flex flex-col min-w-0">
    <header class="px-4 py-3 border-b border-base-300 flex items-center gap-2">
      <Bot size={16} class="text-primary shrink-0" />
      <h1 class="font-medium text-sm truncate">{activeTitle}</h1>
      {#if sending}
        <span class="loading loading-spinner loading-xs ml-auto"></span>
      {/if}
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      {#if loadingChat}
        <div class="flex justify-center py-12">
          <span class="loading loading-spinner loading-md opacity-40"></span>
        </div>
      {:else if messages.length === 0}
        <div class="flex flex-col items-center justify-center h-full gap-2 text-center opacity-60 px-8">
          <Bot size={32} class="opacity-40" />
          <p class="text-sm">
            {m['ai.chat.startConversation']?.() ?? 'Send a message to start the conversation'}
          </p>
        </div>
      {:else}
        {#each messages as msg, i (i)}
          <div class="flex gap-3 {msg.role === 'user' ? 'justify-end' : ''}">
            {#if msg.role === 'assistant'}
              <div class="avatar placeholder shrink-0">
                <div class="bg-primary/15 text-primary rounded-full w-8 h-8 flex items-center justify-center">
                  <Bot size={14} />
                </div>
              </div>
            {/if}
            <div
              class="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words
                {msg.role === 'user'
                ? 'bg-primary text-primary-content'
                : 'bg-base-200'}"
            >
              {msg.content}
            </div>
            {#if msg.role === 'user'}
              <div class="avatar placeholder shrink-0">
                <div class="bg-base-300 rounded-full w-8 h-8 flex items-center justify-center">
                  <User size={14} />
                </div>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <form
      class="p-3 border-t border-base-300 flex gap-2 items-end"
      onsubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        class="textarea textarea-bordered flex-1 min-h-[2.75rem] max-h-40 text-sm leading-snug"
        rows="2"
        placeholder={m['ai.chat.messagePlaceholder']?.() ?? 'Type a message…'}
        bind:value={draft}
        onkeydown={onKeydown}
        disabled={sending}
      ></textarea>
      <button
        type="submit"
        class="btn btn-primary gap-1 shrink-0"
        disabled={sending || !draft.trim()}
        aria-label={m['ai.action.sendMessage']?.() ?? 'Send message'}
      >
        <Send size={16} />
      </button>
    </form>
  </section>
</div>
