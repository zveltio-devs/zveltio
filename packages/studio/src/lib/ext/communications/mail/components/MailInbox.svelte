<script lang="ts">
/**
 * Mail inbox — Tier-3 client over existing /ext/communications/mail APIs.
 */
import { base } from '$app/paths';
import {
  Inbox,
  RefreshCw,
  Send,
  Star,
  Trash2,
  Mail,
  Reply,
  ReplyAll,
  PenSquare,
  Paperclip,
  X,
} from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';

const API = '/ext/communications/mail';

type Account = {
  id: string;
  email_address: string;
  display_name?: string | null;
  is_default?: boolean;
};

type Folder = {
  id: string;
  name: string;
  path: string;
  type: string;
  unread_count?: number;
  total_count?: number;
};

type MsgSummary = {
  id: string;
  from_address: string;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  is_read: boolean;
  is_starred: boolean;
  has_attachments: boolean;
  received_at?: string | null;
};

type MsgDetail = MsgSummary & {
  to_addresses?: unknown;
  body_html?: string | null;
  body_text?: string | null;
  attachments?: Array<{ id: string; filename: string; mime_type?: string; size_bytes?: number }>;
};

let accounts = $state<Account[]>([]);
let accountId = $state<string | null>(null);
let folders = $state<Folder[]>([]);
let folderId = $state<string | null>(null);
let messages = $state<MsgSummary[]>([]);
let selected = $state<MsgDetail | null>(null);
let search = $state('');
let loadingAccounts = $state(true);
let loadingFolders = $state(false);
let loadingMessages = $state(false);
let loadingMessage = $state(false);
let syncing = $state(false);
let showImages = $state(false);

let composing = $state(false);
let composeTo = $state('');
let composeSubject = $state('');
let composeBody = $state('');
let sending = $state(false);
let replyToId = $state<string | null>(null);

const t = (key: string, fallback: string) => m[key]?.() ?? fallback;

const activeAccount = $derived(accounts.find((a) => a.id === accountId) ?? null);
const activeFolder = $derived(folders.find((f) => f.id === folderId) ?? null);

function formatWhen(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fromLabel(msg: MsgSummary): string {
  return msg.from_name?.trim() || msg.from_address || '—';
}

async function loadAccounts(): Promise<void> {
  loadingAccounts = true;
  try {
    const r = await api.get<{ accounts?: Account[] }>(`${API}/accounts`);
    accounts = r.accounts ?? [];
    if (!accountId && accounts.length) {
      accountId = accounts.find((a) => a.is_default)?.id ?? accounts[0]!.id;
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.load', 'Failed to load'));
  } finally {
    loadingAccounts = false;
  }
}

async function loadFolders(): Promise<void> {
  if (!accountId) {
    folders = [];
    folderId = null;
    return;
  }
  loadingFolders = true;
  try {
    const r = await api.get<{ folders?: Folder[] }>(`${API}/accounts/${accountId}/folders`);
    folders = r.folders ?? [];
    const inbox = folders.find((f) => f.type === 'inbox') ?? folders[0];
    folderId = inbox?.id ?? null;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.folders', 'Failed to load folders'));
    folders = [];
  } finally {
    loadingFolders = false;
  }
}

async function loadMessages(): Promise<void> {
  if (!folderId) {
    messages = [];
    return;
  }
  loadingMessages = true;
  selected = null;
  try {
    const qs = new URLSearchParams({ limit: '50' });
    if (search.trim()) qs.set('search', search.trim());
    const r = await api.get<{ messages?: MsgSummary[] }>(
      `${API}/folders/${folderId}/messages?${qs}`,
    );
    messages = r.messages ?? [];
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.messages', 'Failed to load messages'));
    messages = [];
  } finally {
    loadingMessages = false;
  }
}

async function openMessage(id: string): Promise<void> {
  loadingMessage = true;
  showImages = false;
  try {
    const r = await api.get<{ message?: MsgDetail }>(`${API}/messages/${id}`);
    selected = r.message ?? null;
    messages = messages.map((msg) => (msg.id === id ? { ...msg, is_read: true } : msg));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.message', 'Failed to load message'));
  } finally {
    loadingMessage = false;
  }
}

async function syncAccount(): Promise<void> {
  if (!accountId || syncing) return;
  syncing = true;
  try {
    await api.post(`${API}/accounts/${accountId}/sync`, {});
    await loadFolders();
    await loadMessages();
    toast.success(t('communications.mail.ui.sync', 'Sync') + ' ✓');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.sync', 'Sync failed'));
  } finally {
    syncing = false;
  }
}

async function toggleStar(msg: MsgSummary | MsgDetail): Promise<void> {
  const next = !msg.is_starred;
  try {
    await api.patch(`${API}/messages/${msg.id}`, { is_starred: next });
    messages = messages.map((m) => (m.id === msg.id ? { ...m, is_starred: next } : m));
    if (selected?.id === msg.id) selected = { ...selected, is_starred: next };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.failed', 'Failed'));
  }
}

async function toggleRead(msg: MsgSummary): Promise<void> {
  const next = !msg.is_read;
  try {
    await api.patch(`${API}/messages/${msg.id}`, { is_read: next });
    messages = messages.map((m) => (m.id === msg.id ? { ...m, is_read: next } : m));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.failed', 'Failed'));
  }
}

async function deleteMessage(id: string): Promise<void> {
  if (!confirm('Delete this message?')) return;
  try {
    await api.delete(`${API}/messages/${id}`);
    messages = messages.filter((m) => m.id !== id);
    if (selected?.id === id) selected = null;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.failed', 'Failed'));
  }
}

function startCompose(): void {
  composing = true;
  replyToId = null;
  composeTo = '';
  composeSubject = '';
  composeBody = '';
}

async function startReply(type: 'reply' | 'reply_all' | 'forward'): Promise<void> {
  if (!selected) return;
  try {
    const r = await api.post<{
      to?: string[];
      cc?: string[];
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
    }>(`${API}/messages/${selected.id}/reply-context`, { type });
    composing = true;
    replyToId = selected.id;
    composeTo = [...(r.to ?? []), ...(type === 'reply_all' ? (r.cc ?? []) : [])].join(', ');
    composeSubject = r.subject ?? '';
    composeBody = r.bodyText ?? r.bodyHtml?.replace(/<[^>]+>/g, '') ?? '';
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.failed', 'Failed'));
  }
}

async function sendMail(): Promise<void> {
  if (!accountId || sending) return;
  const to = composeTo
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length || !composeSubject.trim()) {
    toast.warning('To and subject are required');
    return;
  }
  sending = true;
  try {
    await api.post(`${API}/send`, {
      account_id: accountId,
      to,
      subject: composeSubject.trim(),
      body_html: `<p>${composeBody.replace(/\n/g, '<br>')}</p>`,
      body_text: composeBody,
      reply_to_message_id: replyToId ?? undefined,
    });
    toast.success('Sent');
    composing = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.send', 'Failed to send'));
  } finally {
    sending = false;
  }
}

async function downloadAttachment(attId: string, filename: string): Promise<void> {
  try {
    const res = await api.fetch(`${API}/attachments/${attId}`);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'attachment';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('communications.mail.error.failed', 'Failed'));
  }
}

const safeBody = $derived.by(() => {
  if (!selected) return '';
  if (selected.body_html) {
    // Strip scripts; optionally neutralize remote images until user opts in.
    let html = selected.body_html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    if (!showImages) {
      html = html.replace(/\s(src|srcset)=["']https?:\/\/[^"']+["']/gi, ' data-blocked-$1="$2"');
    }
    return html;
  }
  return `<pre style="white-space:pre-wrap;font:inherit">${(selected.body_text ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</pre>`;
});

$effect(() => {
  void loadAccounts();
});

$effect(() => {
  void accountId;
  void loadFolders();
});

$effect(() => {
  void folderId;
  void loadMessages();
});
</script>

<div class="flex h-[calc(100vh-8rem)] min-h-[28rem] border border-base-300 rounded-xl overflow-hidden bg-base-100">
  <!-- Folders -->
  <aside class="w-52 shrink-0 border-r border-base-300 flex flex-col bg-base-200/40">
    <div class="p-3 border-b border-base-300 space-y-2">
      {#if loadingAccounts}
        <span class="loading loading-spinner loading-xs"></span>
      {:else if accounts.length === 0}
        <p class="text-xs opacity-60">{t('communications.mail.ui.no_mail_accounts', 'No mail accounts')}</p>
        <a href="{base}/mail" class="btn btn-primary btn-xs w-full">
          {t('communications.mail.ui.addAccount', 'Add account')}
        </a>
      {:else}
        <select class="select select-bordered select-xs w-full" bind:value={accountId}>
          {#each accounts as a (a.id)}
            <option value={a.id}>{a.display_name || a.email_address}</option>
          {/each}
        </select>
        <div class="flex gap-1">
          <button type="button" class="btn btn-ghost btn-xs flex-1 gap-1" disabled={syncing || !accountId} onclick={() => void syncAccount()}>
            <RefreshCw size={12} class={syncing ? 'animate-spin' : ''} />
            {t('communications.mail.ui.sync', 'Sync')}
          </button>
          <button type="button" class="btn btn-primary btn-xs gap-1" disabled={!accountId} onclick={startCompose}>
            <PenSquare size={12} />
          </button>
        </div>
      {/if}
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if loadingFolders}
        <div class="p-3 text-xs opacity-50">…</div>
      {:else}
        <ul class="menu menu-sm p-2">
          {#each folders as f (f.id)}
            <li>
              <button
                type="button"
                class={folderId === f.id ? 'active' : ''}
                onclick={() => {
                  folderId = f.id;
                }}
              >
                <Inbox size={14} />
                <span class="truncate flex-1 text-left">{f.name}</span>
                {#if (f.unread_count ?? 0) > 0}
                  <span class="badge badge-xs">{f.unread_count}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="p-2 border-t border-base-300 text-xs opacity-50">
      <a href="{base}/mail" class="link link-hover">Accounts & signatures →</a>
    </div>
  </aside>

  <!-- Message list -->
  <div class="w-80 shrink-0 border-r border-base-300 flex flex-col">
    <div class="p-2 border-b border-base-300">
      <form
        class="flex gap-1"
        onsubmit={(e) => {
          e.preventDefault();
          void loadMessages();
        }}
      >
        <input
          class="input input-bordered input-xs flex-1"
          placeholder={t('communications.mail.ui.search', 'Search…')}
          bind:value={search}
        />
      </form>
      <div class="text-xs opacity-50 mt-1 px-1 truncate">
        {activeFolder?.name ?? '—'} · {messages.length}
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if loadingMessages}
        <div class="flex justify-center py-8"><span class="loading loading-spinner loading-sm opacity-40"></span></div>
      {:else if messages.length === 0}
        <p class="p-4 text-sm opacity-50">{t('communications.mail.ui.noMessages', 'No messages')}</p>
      {:else}
        {#each messages as msg (msg.id)}
          <button
            type="button"
            class="w-full text-left px-3 py-2.5 border-b border-base-200 hover:bg-base-200/60 transition-colors
              {selected?.id === msg.id ? 'bg-primary/10' : ''}
              {!msg.is_read ? 'font-semibold' : 'opacity-80'}"
            onclick={() => void openMessage(msg.id)}
          >
            <div class="flex items-center gap-1 text-xs mb-0.5">
              <span class="truncate flex-1">{fromLabel(msg)}</span>
              {#if msg.has_attachments}<Paperclip size={10} class="opacity-50 shrink-0" />{/if}
              <span class="opacity-50 shrink-0">{formatWhen(msg.received_at)}</span>
            </div>
            <div class="text-sm truncate">{msg.subject || t('communications.mail.ui.noSubject', '(no subject)')}</div>
            <div class="text-xs opacity-50 truncate">{msg.snippet ?? ''}</div>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- Detail / compose -->
  <section class="flex-1 flex flex-col min-w-0">
    {#if composing}
      <header class="px-4 py-3 border-b border-base-300 flex items-center justify-between">
        <h2 class="font-medium text-sm">{t('communications.mail.ui.newMessage', 'New message')}</h2>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (composing = false)} aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <div class="flex-1 overflow-y-auto p-4 space-y-3">
        <label class="form-control">
          <span class="label-text text-xs">{t('communications.mail.ui.toLabel', 'To:')}</span>
          <input class="input input-bordered input-sm" bind:value={composeTo} />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">{t('communications.mail.ui.subject', 'Subject')}</span>
          <input class="input input-bordered input-sm" bind:value={composeSubject} />
        </label>
        <textarea
          class="textarea textarea-bordered w-full min-h-[12rem] text-sm"
          placeholder={t('communications.mail.ui.write_your_message', 'Write your message…')}
          bind:value={composeBody}
        ></textarea>
      </div>
      <div class="p-3 border-t border-base-300 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (composing = false)}>Cancel</button>
        <button type="button" class="btn btn-primary btn-sm gap-1" disabled={sending} onclick={() => void sendMail()}>
          <Send size={14} />
          {t('communications.mail.compose', 'Compose')}
        </button>
      </div>
    {:else if loadingMessage}
      <div class="flex-1 flex items-center justify-center">
        <span class="loading loading-spinner loading-md opacity-40"></span>
      </div>
    {:else if !selected}
      <div class="flex-1 flex flex-col items-center justify-center gap-2 opacity-50">
        <Mail size={32} />
        <p class="text-sm">{t('communications.mail.ui.selectMessage', 'Select a message')}</p>
      </div>
    {:else}
      <header class="px-4 py-3 border-b border-base-300 space-y-2">
        <div class="flex items-start gap-2">
          <h2 class="font-medium text-base flex-1 min-w-0 break-words">
            {selected.subject || t('communications.mail.ui.noSubject', '(no subject)')}
          </h2>
          <div class="flex gap-0.5 shrink-0">
            <button type="button" class="btn btn-ghost btn-xs" title={t('communications.mail.ui.star', 'Star')} onclick={() => void toggleStar(selected!)}>
              <Star size={14} class={selected.is_starred ? 'fill-warning text-warning' : ''} />
            </button>
            <button type="button" class="btn btn-ghost btn-xs" title={t('communications.mail.ui.markUnread', 'Mark unread')} onclick={() => void toggleRead(selected!)}>
              <Mail size={14} />
            </button>
            <button type="button" class="btn btn-ghost btn-xs text-error" title="Delete" onclick={() => void deleteMessage(selected!.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        <div class="text-sm">
          <span class="opacity-60">{t('communications.mail.ui.fromLabel', 'From:')}</span>
          {fromLabel(selected)}
          <span class="opacity-40 ml-2">{formatWhen(selected.received_at)}</span>
        </div>
        <div class="flex flex-wrap gap-1">
          <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={() => void startReply('reply')}>
            <Reply size={12} /> {t('communications.mail.ui.reply', 'Reply')}
          </button>
          <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={() => void startReply('reply_all')}>
            <ReplyAll size={12} /> {t('communications.mail.ui.replyAll', 'Reply all')}
          </button>
          <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={() => void startReply('forward')}>
            {t('communications.mail.ui.forward', 'Forward')}
          </button>
        </div>
        {#if !showImages && selected.body_html?.includes('src=')}
          <div class="alert alert-warning py-2 text-xs">
            <span>{t('communications.mail.ui.imagesBlocked', 'Remote images blocked')}</span>
            <button type="button" class="btn btn-xs" onclick={() => (showImages = true)}>
              {t('communications.mail.ui.showImages', 'Show remote images')}
            </button>
          </div>
        {/if}
        {#if selected.attachments?.length}
          <div class="flex flex-wrap gap-2 text-xs items-center">
            <span class="opacity-60">{t('communications.mail.ui.attachments', 'Attachments')}:</span>
            {#each selected.attachments as att (att.id)}
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                onclick={() => void downloadAttachment(att.id, att.filename)}
              >
                <Paperclip size={10} />
                {att.filename}
              </button>
            {/each}
          </div>
        {/if}
      </header>
      <div class="flex-1 overflow-y-auto p-4 prose prose-sm max-w-none dark:prose-invert">
        {@html safeBody}
      </div>
    {/if}
  </section>
</div>
