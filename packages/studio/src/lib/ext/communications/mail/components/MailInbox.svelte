<script lang="ts">
/**
 * Mail inbox over the data API (`mail_*` collections) and the mail actions.
 * Nothing here talks to a mail server: syncing and sending are actions that
 * queue engine jobs, so this page polls the row the job updates.
 */
import { resolve } from '$app/paths';
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
import { api } from '#lib/api.js';
import { auth } from '#lib/auth.svelte.js';
import { safeMailHtml, safeMailText } from '../lib/sanitize.js';
import { m } from '#lib/i18n.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';

const DATA = '/api/data';
const ACTIONS = '/ext/communications/mail/actions';
/** While the page is open, mail is fetched this often. */
const AUTO_SYNC_MS = 5 * 60_000;
const ORDER = ['inbox', 'sent', 'drafts', 'archive', 'other', 'spam', 'trash'];

type Address = { address: string; name?: string };

type Account = {
  id: string;
  email_address: string;
  display_name?: string | null;
  is_default?: boolean;
  sync_status?: string;
  sync_error?: string | null;
  sync_more?: boolean;
  created_by?: string | null;
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

type Attachment = {
  id: string;
  filename: string;
  mime_type?: string;
  size?: number;
  file_id?: string | null;
  fetch_status?: 'queued' | 'failed' | null;
  fetch_error?: string | null;
};

/** Stored files handed to the job an action queues (ADR 0032): beside the input, checked by the engine as the caller. */
type Files = { read?: string[]; write?: { name: string; maxBytes: number } };

type MsgDetail = MsgSummary & {
  message_id?: string | null;
  references_header?: string | null;
  reply_to?: string | null;
  to_addresses?: Address[] | null;
  cc_addresses?: Address[] | null;
  body_html?: string | null;
  body_text?: string | null;
  attachments?: Attachment[];
};

type Upload = { file_id: string; filename: string; mime_type: string; size: number };

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
let composeFiles = $state<Upload[]>([]);
let sending = $state(false);
let replyTo = $state<MsgDetail | null>(null);

const t = (key: string, fallback: string) => m[key]?.() ?? fallback;
const errText = (err: unknown, key: string, fallback: string) => (err instanceof Error ? err.message : t(key, fallback));
const filter = (f: Record<string, unknown>) => encodeURIComponent(JSON.stringify(f));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const action = <T = unknown>(name: string, body: Record<string, unknown>, files?: Files) =>
  api.post<T>(`${ACTIONS}/${name}`, files ? { ...body, $files: files } : body);

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
    const r = await api.get<{ records?: Account[] }>(`${DATA}/mail_accounts?sort=name&limit=100`);
    // The inbox is the signed-in user's own mail. A sync writes its rows as the
    // user who queued it (ADR 0028): syncing a colleague's account, which an
    // administrator may see, would file that mail under the administrator.
    const me = (auth.user as { id?: string } | null)?.id;
    accounts = (r.records ?? []).filter((a) => a.created_by === me);
    if (!accountId && accounts.length) {
      accountId = accounts.find((a) => a.is_default)?.id ?? accounts[0]!.id;
    }
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.load', 'Failed to load'));
  } finally {
    loadingAccounts = false;
  }
}

async function loadFolders(keepSelection = false): Promise<void> {
  if (!accountId) {
    folders = [];
    folderId = null;
    return;
  }
  loadingFolders = true;
  try {
    const r = await api.get<{ records?: Folder[] }>(`${DATA}/mail_folders?filter=${filter({ account_id: accountId })}&limit=500`);
    folders = (r.records ?? []).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.name.localeCompare(b.name));
    if (!keepSelection || !folders.some((f) => f.id === folderId)) {
      folderId = (folders.find((f) => f.type === 'inbox') ?? folders[0])?.id ?? null;
    }
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.folders', 'Failed to load folders'));
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
  try {
    const qs = new URLSearchParams({ sort: 'received_at', order: 'desc', limit: '50' });
    if (search.trim()) qs.set('search', search.trim());
    const r = await api.get<{ records?: MsgSummary[] }>(`${DATA}/mail_messages?filter=${filter({ folder_id: folderId })}&${qs}`);
    messages = r.records ?? [];
    if (selected && !messages.some((msg) => msg.id === selected!.id)) selected = null;
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.messages', 'Failed to load messages'));
    messages = [];
  } finally {
    loadingMessages = false;
  }
}

async function openMessage(id: string): Promise<void> {
  loadingMessage = true;
  showImages = false;
  composing = false;
  try {
    const [msg, atts] = await Promise.all([
      api.get<MsgDetail>(`${DATA}/mail_messages/${id}`),
      api.get<{ records?: Attachment[] }>(`${DATA}/mail_attachments?filter=${filter({ message_id: id })}&limit=100`),
    ]);
    selected = { ...msg, attachments: atts.records ?? [] };
    if (!msg.is_read) await setFlags([id], { is_read: true });
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.message', 'Failed to load message'));
  } finally {
    loadingMessage = false;
  }
}

/** Queue a sync and wait for it; a sync that stopped at its budget (`sync_more`) is continued, a few times. */
async function syncAccount(quiet = false): Promise<void> {
  if (!accountId || syncing) return;
  syncing = true;
  const id = accountId;
  try {
    for (let round = 0; round < 5; round++) {
      await action('sync', { account_id: id });
      let acct: Account | null = null;
      for (let i = 0; i < 90; i++) {
        await sleep(2000);
        acct = await api.get<Account>(`${DATA}/mail_accounts/${id}`);
        if (acct.sync_status !== 'queued' && acct.sync_status !== 'syncing') break;
      }
      accounts = accounts.map((a) => (a.id === id && acct ? acct : a));
      if (acct?.sync_status === 'error') throw new Error(acct.sync_error || t('communications.mail.error.sync', 'Sync failed'));
      await loadFolders(true);
      await loadMessages();
      if (!acct?.sync_more) break;
    }
    if (!quiet) toast.success(t('communications.mail.ui.sync', 'Sync') + ' ✓');
  } catch (err) {
    if (!quiet) toast.error(errText(err, 'communications.mail.error.sync', 'Sync failed'));
  } finally {
    syncing = false;
  }
}

async function setFlags(ids: string[], change: { is_read?: boolean; is_starred?: boolean }): Promise<void> {
  await action('setFlags', { message_ids: ids, ...change });
  messages = messages.map((msg) => (ids.includes(msg.id) ? { ...msg, ...change } : msg));
  if (selected && ids.includes(selected.id)) selected = { ...selected, ...change };
}

async function toggleStar(msg: MsgSummary | MsgDetail): Promise<void> {
  try {
    await setFlags([msg.id], { is_starred: !msg.is_starred });
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.failed', 'Failed'));
  }
}

async function toggleRead(msg: MsgSummary): Promise<void> {
  try {
    await setFlags([msg.id], { is_read: !msg.is_read });
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.failed', 'Failed'));
  }
}

async function deleteMessage(id: string): Promise<void> {
  if (!confirm(t('communications.mail.confirmDeleteMessage', 'Delete this message?'))) return;
  try {
    await action('deleteMessages', { message_ids: [id] });
    messages = messages.filter((msg) => msg.id !== id);
    if (selected?.id === id) selected = null;
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.failed', 'Failed'));
  }
}

function startCompose(): void {
  composing = true;
  replyTo = null;
  composeTo = '';
  composeSubject = '';
  composeBody = '';
  composeFiles = [];
}

const fmtAddr = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

function parseAddresses(v: string): Address[] {
  return v
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const mm = /^(.*?)\s*<([^>]+)>$/.exec(s);
      return mm ? { address: mm[2]!.trim(), ...(mm[1] ? { name: mm[1].replace(/^"|"$/g, '') } : {}) } : { address: s };
    });
}

function startReply(type: 'reply' | 'reply_all' | 'forward'): void {
  if (!selected) return;
  const msg = selected;
  const own = (activeAccount?.email_address ?? '').toLowerCase();
  const sender: Address = { address: msg.reply_to || msg.from_address, ...(msg.from_name ? { name: msg.from_name } : {}) };
  const others = [...(msg.to_addresses ?? []), ...(msg.cc_addresses ?? [])].filter((a) => a.address.toLowerCase() !== own);
  const to = type === 'forward' ? [] : type === 'reply_all' ? [sender, ...others] : [sender];
  const subject = msg.subject ?? '';
  const prefix = type === 'forward' ? 'Fwd: ' : 'Re: ';
  const quoted = (msg.body_text ?? '').split('\n').map((l) => `> ${l}`).join('\n');
  composing = true;
  replyTo = type === 'forward' ? null : msg;
  composeTo = to.map(fmtAddr).join(', ');
  composeSubject = subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : prefix + subject;
  composeBody = `\n\n${fromLabel(msg)} — ${formatWhen(msg.received_at)}:\n${quoted}`;
  composeFiles = [];
}

async function attachFiles(ev: Event): Promise<void> {
  const input = ev.currentTarget as HTMLInputElement;
  for (const file of Array.from(input.files ?? [])) {
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api.post<{ file: { id: string } }>('/api/storage/upload', form);
      composeFiles = [...composeFiles, { file_id: r.file.id, filename: file.name, mime_type: file.type || 'application/octet-stream', size: file.size }];
    } catch (err) {
      toast.error(errText(err, 'communications.mail.error.failed', 'Failed'));
    }
  }
  input.value = '';
}

/** Save the message as a draft, ask for it to be sent, and wait for the job to delete it (sent) or mark it failed. */
async function sendMail(): Promise<void> {
  if (!accountId || sending) return;
  const to = parseAddresses(composeTo);
  if (!to.length) {
    toast.warning(t('communications.mail.error.noRecipient', 'Add at least one recipient'));
    return;
  }
  sending = true;
  try {
    const draft = await api.post<{ id: string }>(`${DATA}/mail_drafts`, {
      account_id: accountId,
      to_addresses: to,
      subject: composeSubject.trim(),
      body_text: composeBody,
      // The compose box is plain text: escaped before it becomes markup.
      body_html: `<p>${safeMailText(composeBody).replace(/\n/g, '<br>')}</p>`,
      in_reply_to: replyTo?.message_id ?? null,
      references_header: replyTo ? [replyTo.references_header, replyTo.message_id].filter(Boolean).join(' ') || null : null,
      original_message_id: replyTo?.id ?? null,
      attachments: composeFiles,
    });
    const uploads = composeFiles.map((f) => f.file_id);
    await action('send', { draft_id: draft.id }, uploads.length ? { read: uploads } : undefined);
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      let d: { send_status?: string; send_error?: string | null } | null = null;
      try {
        d = await api.get(`${DATA}/mail_drafts/${draft.id}`);
      } catch {
        d = null; // the job deletes a sent draft
      }
      if (!d) {
        // Sent: the device uploads were only the way into the job. A send that
        // never completes leaves them in the user's files, for the user to delete.
        for (const id of uploads) await api.delete(`/api/storage/${id}`).catch(() => undefined);
        toast.success(t('communications.mail.ui.sent', 'Sent'));
        composing = false;
        return;
      }
      if (d.send_status === 'failed') throw new Error(d.send_error || t('communications.mail.error.send', 'Failed to send'));
    }
    toast.warning(t('communications.mail.ui.sendPending', 'Still sending; the draft stays in Drafts until it goes.'));
    composing = false;
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.send', 'Failed to send'));
  } finally {
    sending = false;
  }
}

let downloading = $state<string | null>(null);

/**
 * Open an attachment. One not yet downloaded is fetched from the mail server by
 * a job, into the user's own files, under its name and at most its part's size.
 */
async function downloadAttachment(att: Attachment): Promise<void> {
  if (downloading) return;
  downloading = att.id;
  try {
    let fileId = att.file_id ?? null;
    if (!fileId) {
      await action('fetchAttachment', { attachment_id: att.id }, { write: { name: att.filename, maxBytes: Math.max(1, att.size ?? 0) } });
      for (let i = 0; i < 90 && !fileId; i++) {
        await sleep(2000);
        const row = await api.get<Attachment>(`${DATA}/mail_attachments/${att.id}`);
        if (row.fetch_status === 'failed') throw new Error(row.fetch_error || t('communications.mail.error.download', 'Download failed'));
        fileId = row.file_id ?? null;
      }
      if (!fileId) throw new Error(t('communications.mail.error.download', 'Download failed'));
      att.file_id = fileId;
    }
    const r = await api.get<{ url: string }>(`/api/storage/${fileId}/signed-url`);
    const a = document.createElement('a');
    a.href = r.url;
    a.download = att.filename || 'attachment';
    a.rel = 'noopener';
    a.click();
  } catch (err) {
    toast.error(errText(err, 'communications.mail.error.download', 'Download failed'));
  } finally {
    downloading = null;
  }
}

const safeBody = $derived.by(() => {
  if (!selected) return '';
  // The engine stores body_html sanitized (jobs.ts → cleanHtml); this second
  // pass is Studio's own, and the one that blocks remote images until asked.
  if (selected.body_html) return safeMailHtml(selected.body_html, showImages);
  return `<pre style="white-space:pre-wrap;font:inherit">${safeMailText(selected.body_text)}</pre>`;
});

$effect(() => {
  void loadAccounts();
});

$effect(() => {
  void accountId;
  void loadFolders().then(() => syncAccount(true));
  const timer = setInterval(() => void syncAccount(true), AUTO_SYNC_MS);
  return () => clearInterval(timer);
});

$effect(() => {
  void folderId;
  selected = null;
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
        <a href={resolve('mail')} class="btn btn-primary btn-xs w-full">
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
      <a href={resolve('mail')} class="link link-hover">Accounts & signatures →</a>
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
        <div class="flex flex-wrap gap-2 items-center text-xs">
          <label class="btn btn-ghost btn-xs gap-1">
            <Paperclip size={12} /> {t('communications.mail.ui.attach', 'Attach')}
            <input type="file" multiple class="hidden" onchange={(e) => void attachFiles(e)} />
          </label>
          {#each composeFiles as f (f.file_id)}
            <span class="badge badge-ghost gap-1">
              {f.filename}
              <button type="button" aria-label="Remove" onclick={() => (composeFiles = composeFiles.filter((x) => x.file_id !== f.file_id))}><X size={10} /></button>
            </span>
          {/each}
        </div>
      </div>
      <div class="p-3 border-t border-base-300 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (composing = false)}>Cancel</button>
        <button type="button" class="btn btn-primary btn-sm gap-1" disabled={sending} onclick={() => void sendMail()}>
          <Send size={14} />
          {t('communications.mail.ui.send', 'Send')}
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
                disabled={downloading !== null}
                title={downloading === att.id ? t('communications.mail.ui.downloading', 'Downloading…') : ''}
                onclick={() => void downloadAttachment(att)}
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
