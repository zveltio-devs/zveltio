<script lang="ts">
  import { ENGINE_URL } from '$lib/config.js';
  import {
    Mail, Send, Inbox, Star, Trash2, Archive, RefreshCw, Plus, Search,
    Reply, ReplyAll, Forward, Wand2, X, Paperclip, Filter,
    ChevronDown, Settings, FileText, Users, Check, AlertCircle
  } from '@lucide/svelte';

  // ── Types ─────────────────────────────────────────────────────────────────
  type Tab = 'mail' | 'drafts' | 'contacts' | 'signatures' | 'filters';

  // ── State ─────────────────────────────────────────────────────────────────
  let activeTab = $state<Tab>('mail');
  let accounts = $state<any[]>([]);
  let selectedAccount = $state<any>(null);
  let folders = $state<any[]>([]);
  let selectedFolder = $state<any>(null);
  let messages = $state<any[]>([]);
  let selectedMessage = $state<any>(null);
  let selectedIds = $state<Set<string>>(new Set());
  let searchQuery = $state('');
  let loading = $state(false);
  let syncing = $state(false);
  let error = $state('');
  let stats = $state<any>({});

  // Compose
  let showCompose = $state(false);
  let draftId = $state<string | null>(null);
  let composeTo = $state('');
  let composeCc = $state('');
  let composeBcc = $state('');
  let composeSubject = $state('');
  let composeBody = $state('');
  let composePriority = $state('normal');
  let composeRequestReceipt = $state(false);
  let sendingMail = $state(false);
  let replyToMessageId = $state<string | null>(null);
  let autoSaveTimer: any = null;

  // Contact autocomplete
  let toSuggestions = $state<any[]>([]);
  let showToSuggestions = $state(false);

  // AI
  let summary = $state('');
  let summarizing = $state(false);
  let aiDraftLoading = $state(false);

  // Add account modal
  let showAddAccount = $state(false);
  let newAccount = $state({
    name: '', email_address: '', display_name: '',
    imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_password: '',
    smtp_host: '', smtp_port: 587, smtp_secure: true, smtp_user: '', smtp_password: '',
    is_default: false,
  });
  let addingAccount = $state(false);

  // Drafts
  let drafts = $state<any[]>([]);

  // Contacts
  let contacts = $state<any[]>([]);
  let contactSearch = $state('');

  // Signatures
  let signatures = $state<any[]>([]);
  let editSig = $state<any | null>(null);
  let sigName = $state('');
  let sigHtml = $state('');
  let sigDefault = $state(false);

  // Filters
  let filters = $state<any[]>([]);
  let showFilterModal = $state(false);
  let newFilter = $state({
    name: '',
    conditions: [{ field: 'from', operator: 'contains', value: '' }],
    actions: [{ type: 'mark_read' }],
    is_active: true,
  });

  // Bulk
  let showBulkMenu = $state(false);

  // ── API ───────────────────────────────────────────────────────────────────
  async function apiFetch(path: string, opts: RequestInit = {}) {
    const res = await fetch(`${ENGINE_URL}${path}`, {
      credentials: 'include',
      headers: opts.body && !(opts.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {},
      ...opts,
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  async function loadAll() {
    loading = true; error = '';
    try {
      const r = await apiFetch('/api/mail/accounts');
      accounts = r.accounts ?? [];
      if (accounts.length > 0 && !selectedAccount) {
        await selectAccount(accounts.find((a: any) => a.is_default) ?? accounts[0]);
      }
      await loadStats();
    } catch (e: any) { error = e.message; }
    finally { loading = false; }
  }

  async function loadStats() {
    try { const r = await apiFetch('/api/mail/stats'); stats = r.stats ?? {}; } catch { /* ignore */ }
  }

  async function selectAccount(account: any) {
    selectedAccount = account; selectedFolder = null; selectedMessage = null;
    messages = []; folders = []; summary = '';
    loading = true;
    try {
      const r = await apiFetch(`/api/mail/accounts/${account.id}/folders`);
      folders = r.folders ?? [];
      const inbox = folders.find((f: any) => f.type === 'inbox') ?? folders[0];
      if (inbox) await selectFolder(inbox);
    } catch (e: any) { error = e.message; }
    finally { loading = false; }
  }

  async function selectFolder(folder: any) {
    selectedFolder = folder; selectedMessage = null; summary = '';
    selectedIds = new Set();
    messages = []; loading = true;
    try {
      const r = await apiFetch(`/api/mail/folders/${folder.id}/messages?limit=50`);
      messages = r.messages ?? [];
    } catch (e: any) { error = e.message; }
    finally { loading = false; }
  }

  async function selectMessage(msg: any) {
    summary = ''; loading = true;
    try {
      const r = await apiFetch(`/api/mail/messages/${msg.id}`);
      selectedMessage = r.message;
      messages = messages.map((m: any) => m.id === msg.id ? { ...m, is_read: true } : m);
    } catch (e: any) { error = e.message; }
    finally { loading = false; }
  }

  async function syncAccount() {
    if (!selectedAccount) return;
    syncing = true; error = '';
    try {
      await apiFetch(`/api/mail/accounts/${selectedAccount.id}/sync`, { method: 'POST' });
      if (selectedFolder) await selectFolder(selectedFolder);
      await loadStats();
    } catch (e: any) { error = e.message; }
    finally { syncing = false; }
  }

  // ── Message actions ───────────────────────────────────────────────────────
  async function toggleStar(msg: any) {
    await apiFetch(`/api/mail/messages/${msg.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_starred: !msg.is_starred }),
    });
    messages = messages.map((m: any) => m.id === msg.id ? { ...m, is_starred: !m.is_starred } : m);
  }

  async function deleteMessage(msg: any) {
    await apiFetch(`/api/mail/messages/${msg.id}`, { method: 'DELETE' });
    messages = messages.filter((m: any) => m.id !== msg.id);
    if (selectedMessage?.id === msg.id) selectedMessage = null;
  }

  async function downloadEml() {
    if (!selectedMessage) return;
    const res = await fetch(`${ENGINE_URL}/api/mail/messages/${selectedMessage.id}/eml`, { credentials: 'include' });
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${selectedMessage.subject || 'message'}.eml`; a.click();
  }

  // Bulk
  async function bulkAction(action: string, targetFolderId?: string) {
    if (selectedIds.size === 0) return;
    await apiFetch('/api/mail/bulk', {
      method: 'POST',
      body: JSON.stringify({
        message_ids: [...selectedIds],
        action,
        target_folder_id: targetFolderId,
      }),
    });
    if (action === 'delete' || action === 'spam' || action === 'move') {
      messages = messages.filter((m: any) => !selectedIds.has(m.id));
    } else {
      const isRead = action === 'mark_read';
      const isStarred = action === 'star';
      messages = messages.map((m: any) => {
        if (!selectedIds.has(m.id)) return m;
        if (action === 'mark_read' || action === 'mark_unread') return { ...m, is_read: isRead };
        if (action === 'star' || action === 'unstar') return { ...m, is_starred: isStarred };
        return m;
      });
    }
    selectedIds = new Set();
    showBulkMenu = false;
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
  }

  // ── Compose ───────────────────────────────────────────────────────────────
  function openCompose(preset?: Partial<{ to: string; subject: string; body: string; replyId: string }>) {
    composeTo = preset?.to ?? '';
    composeCc = '';
    composeBcc = '';
    composeSubject = preset?.subject ?? '';
    composeBody = preset?.body ?? '';
    replyToMessageId = preset?.replyId ?? null;
    draftId = null;
    showCompose = true;
  }

  async function openReplyContext(type: 'reply' | 'reply_all' | 'forward') {
    if (!selectedMessage) return;
    try {
      const ctx = await apiFetch(`/api/mail/messages/${selectedMessage.id}/reply-context`, {
        method: 'POST', body: JSON.stringify({ type }),
      });
      composeTo = (ctx.to ?? []).map((a: any) => a.address).join(', ');
      composeCc = (ctx.cc ?? []).map((a: any) => a.address).join(', ');
      composeSubject = ctx.subject ?? '';
      composeBody = ctx.bodyText ?? '';
      replyToMessageId = selectedMessage.id;
      draftId = null;
      showCompose = true;
    } catch (e: any) { error = e.message; }
  }

  async function autoSaveDraft() {
    if (!selectedAccount || !showCompose) return;
    try {
      const r = await apiFetch('/api/mail/drafts', {
        method: 'POST',
        body: JSON.stringify({
          draft_id: draftId,
          account_id: selectedAccount.id,
          to: composeTo.split(',').map((s: string) => ({ address: s.trim() })).filter((a: any) => a.address),
          cc: composeCc ? composeCc.split(',').map((s: string) => ({ address: s.trim() })) : [],
          bcc: composeBcc ? composeBcc.split(',').map((s: string) => ({ address: s.trim() })) : [],
          subject: composeSubject,
          body_html: `<p>${composeBody.replace(/\n/g, '<br/>')}</p>`,
          body_text: composeBody,
          priority: composePriority,
          request_read_receipt: composeRequestReceipt,
          reply_type: replyToMessageId ? 'reply' : null,
          original_msg_id: replyToMessageId,
        }),
      });
      draftId = r.draft_id;
    } catch { /* non-critical */ }
  }

  async function sendEmail() {
    if (!selectedAccount || !composeTo.trim() || !composeSubject.trim()) return;
    sendingMail = true; error = '';
    try {
      if (draftId) {
        // Update draft then send it
        await autoSaveDraft();
        await apiFetch(`/api/mail/drafts/${draftId}/send`, { method: 'POST' });
      } else {
        await apiFetch('/api/mail/send', {
          method: 'POST',
          body: JSON.stringify({
            account_id: selectedAccount.id,
            to: composeTo.split(',').map((s: string) => s.trim()).filter(Boolean),
            cc: composeCc ? composeCc.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
            bcc: composeBcc ? composeBcc.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
            subject: composeSubject,
            body_html: `<p>${composeBody.replace(/\n/g, '<br/>')}</p>`,
            body_text: composeBody,
            reply_to_message_id: replyToMessageId ?? undefined,
          }),
        });
      }
      showCompose = false;
      if (selectedFolder?.type === 'sent') await selectFolder(selectedFolder);
      await loadStats();
    } catch (e: any) { error = e.message; }
    finally { sendingMail = false; }
  }

  // Contacts autocomplete
  async function fetchSuggestions(q: string) {
    if (q.length < 2) { toSuggestions = []; return; }
    try {
      const r = await apiFetch(`/api/mail/contacts?q=${encodeURIComponent(q)}&limit=8`);
      toSuggestions = r.contacts ?? [];
    } catch { toSuggestions = []; }
  }

  function pickSuggestion(contact: any) {
    const parts = composeTo.split(',');
    parts[parts.length - 1] = contact.display_name ? `${contact.display_name} <${contact.email}>` : contact.email;
    composeTo = parts.join(', ') + ', ';
    toSuggestions = [];
    showToSuggestions = false;
  }

  // ── AI ────────────────────────────────────────────────────────────────────
  async function summarizeMessage() {
    if (!selectedMessage) return;
    summarizing = true; summary = '';
    try {
      const r = await apiFetch(`/api/mail/messages/${selectedMessage.id}/summarize`, { method: 'POST' });
      summary = r.summary ?? '';
    } catch (e: any) { error = e.message; }
    finally { summarizing = false; }
  }

  async function generateAiDraft() {
    if (!selectedMessage) return;
    aiDraftLoading = true;
    try {
      const r = await apiFetch(`/api/mail/messages/${selectedMessage.id}/reply-draft`, { method: 'POST' });
      if (r.draft) openReplyContext('reply').then(() => { composeBody = r.draft; });
    } catch (e: any) { error = e.message; }
    finally { aiDraftLoading = false; }
  }

  // ── Drafts tab ────────────────────────────────────────────────────────────
  async function loadDrafts() {
    try { const r = await apiFetch('/api/mail/drafts'); drafts = r.drafts ?? []; } catch { /* ignore */ }
  }

  async function deleteDraft(id: string) {
    await apiFetch(`/api/mail/drafts/${id}`, { method: 'DELETE' });
    drafts = drafts.filter((d: any) => d.id !== id);
  }

  async function openDraft(draft: any) {
    const r = await apiFetch(`/api/mail/drafts/${draft.id}`);
    const d = r.draft;
    const parseAddrs = (v: any) => {
      try { return (Array.isArray(v) ? v : JSON.parse(v)).map((a: any) => a.address).join(', '); }
      catch { return ''; }
    };
    composeTo = parseAddrs(d.to_addresses);
    composeCc = parseAddrs(d.cc_addresses);
    composeBcc = parseAddrs(d.bcc_addresses);
    composeSubject = d.subject;
    composeBody = d.body_text || d.body_html?.replace(/<[^>]*>/g, '') || '';
    draftId = d.id;
    activeTab = 'mail';
    showCompose = true;
  }

  // ── Contacts tab ──────────────────────────────────────────────────────────
  async function loadContacts() {
    try { const r = await apiFetch(`/api/mail/contacts?q=${encodeURIComponent(contactSearch)}&limit=50`); contacts = r.contacts ?? []; } catch { /* ignore */ }
  }

  // ── Signatures tab ────────────────────────────────────────────────────────
  async function loadSignatures() {
    try { const r = await apiFetch('/api/mail/signatures'); signatures = r.signatures ?? []; } catch { /* ignore */ }
  }

  async function saveSignature() {
    if (!sigName.trim()) return;
    const method = editSig ? 'PUT' : 'POST';
    const path = editSig ? `/api/mail/signatures/${editSig.id}` : '/api/mail/signatures';
    await apiFetch(path, { method, body: JSON.stringify({ name: sigName, body_html: sigHtml, is_default: sigDefault }) });
    editSig = null; sigName = ''; sigHtml = ''; sigDefault = false;
    await loadSignatures();
  }

  async function deleteSignature(id: string) {
    await apiFetch(`/api/mail/signatures/${id}`, { method: 'DELETE' });
    await loadSignatures();
  }

  // ── Filters tab ───────────────────────────────────────────────────────────
  async function loadFilters() {
    if (!selectedAccount) return;
    try { const r = await apiFetch(`/api/mail/accounts/${selectedAccount.id}/filters`); filters = r.filters ?? []; } catch { /* ignore */ }
  }

  async function saveFilter() {
    if (!selectedAccount || !newFilter.name) return;
    await apiFetch(`/api/mail/accounts/${selectedAccount.id}/filters`, {
      method: 'POST', body: JSON.stringify(newFilter),
    });
    showFilterModal = false;
    newFilter = { name: '', conditions: [{ field: 'from', operator: 'contains', value: '' }], actions: [{ type: 'mark_read' }], is_active: true };
    await loadFilters();
  }

  async function toggleFilter(filter: any) {
    await apiFetch(`/api/mail/accounts/${selectedAccount.id}/filters/${filter.id}`, {
      method: 'PATCH', body: JSON.stringify({ is_active: !filter.is_active }),
    });
    await loadFilters();
  }

  async function deleteFilter(id: string) {
    await apiFetch(`/api/mail/accounts/${selectedAccount.id}/filters/${id}`, { method: 'DELETE' });
    filters = filters.filter((f: any) => f.id !== id);
  }

  // ── Tab effects ───────────────────────────────────────────────────────────
  $effect(() => {
    loadAll();
  });

  $effect(() => {
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    if (showCompose) {
      autoSaveTimer = setInterval(autoSaveDraft, 30_000);
    }
    return () => clearInterval(autoSaveTimer);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function folderIcon(type: string) {
    return { inbox: Inbox, sent: Send, trash: Trash2, archive: Archive, spam: AlertCircle }[type] ?? Mail;
  }

  function formatDate(d: string) {
    const dt = new Date(d); const now = new Date();
    if (dt.toDateString() === now.toDateString()) return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  const hasSelection = $derived(selectedIds.size > 0);
</script>

<div class="flex h-[calc(100vh-64px)] overflow-hidden">

  <!-- ═══ SIDEBAR ═══ -->
  <div class="w-56 shrink-0 border-r border-base-300 bg-base-200 flex flex-col">
    <div class="p-3 border-b border-base-300 flex items-center justify-between">
      <span class="font-semibold text-sm flex items-center gap-1">
        <Mail class="w-4 h-4"/>
        Mail
        {#if stats.unread_inbox > 0}
          <span class="badge badge-primary badge-xs">{stats.unread_inbox}</span>
        {/if}
      </span>
      <div class="flex gap-1">
        <button class="btn btn-xs btn-ghost" onclick={syncAccount} disabled={syncing || !selectedAccount} title="Sync">
          <RefreshCw class="w-3 h-3 {syncing ? 'animate-spin' : ''}"/>
        </button>
        <button class="btn btn-xs btn-ghost" onclick={() => showAddAccount = true} title="Add Account">
          <Plus class="w-3 h-3"/>
        </button>
      </div>
    </div>

    <!-- Account switcher -->
    {#if accounts.length > 1}
      <div class="px-2 pt-2">
        <select class="select select-xs select-bordered w-full"
          onchange={(e) => { const a = accounts.find((x: any) => x.id === (e.target as HTMLSelectElement).value); if (a) selectAccount(a); }}>
          {#each accounts as a}
            <option value={a.id} selected={a.id === selectedAccount?.id}>{a.name}</option>
          {/each}
        </select>
      </div>
    {:else if accounts.length === 1}
      <div class="px-3 py-1 text-xs text-base-content/50 truncate">{accounts[0]?.email_address}</div>
    {/if}

    <!-- Folders -->
    <nav class="flex-1 overflow-y-auto py-2">
      {#if activeTab === 'mail'}
        {#each folders as folder}
          {@const Icon = folderIcon(folder.type)}
          <button
            class="flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-lg mx-1 hover:bg-base-300 transition-colors {selectedFolder?.id === folder.id ? 'bg-primary/10 text-primary font-semibold' : ''}"
            onclick={() => selectFolder(folder)}
          >
            <Icon class="w-3.5 h-3.5 shrink-0"/>
            <span class="flex-1 text-left truncate">{folder.name}</span>
            {#if folder.unread_count > 0}
              <span class="badge badge-xs badge-primary">{folder.unread_count}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </nav>

    <!-- Tab nav -->
    <div class="border-t border-base-300 py-1">
      {#each [
        { id: 'mail', icon: Inbox, label: 'Mail' },
        { id: 'drafts', icon: FileText, label: 'Drafts', badge: stats.drafts },
        { id: 'contacts', icon: Users, label: 'Contacts' },
        { id: 'signatures', icon: Settings, label: 'Signatures' },
        { id: 'filters', icon: Filter, label: 'Filters' },
      ] as tab}
        <button
          class="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-base-300 rounded-lg mx-1 transition-colors {activeTab === tab.id ? 'text-primary font-semibold' : 'text-base-content/60'}"
          onclick={() => {
            activeTab = tab.id as Tab;
            if (tab.id === 'drafts') loadDrafts();
            if (tab.id === 'contacts') loadContacts();
            if (tab.id === 'signatures') loadSignatures();
            if (tab.id === 'filters') loadFilters();
          }}
        >
          <tab.icon class="w-3.5 h-3.5 shrink-0"/>
          {tab.label}
          {#if tab.badge > 0}<span class="badge badge-xs badge-neutral ml-auto">{tab.badge}</span>{/if}
        </button>
      {/each}
    </div>

    <!-- Compose -->
    <div class="p-2 border-t border-base-300">
      <button class="btn btn-primary btn-sm w-full gap-1"
        onclick={() => openCompose()}>
        <Send class="w-3 h-3"/> Compose
      </button>
    </div>
  </div>

  <!-- ═══ MAIN AREA ═══ -->
  <div class="flex-1 flex overflow-hidden">

    <!-- ─── MAIL TAB ─── -->
    {#if activeTab === 'mail'}
      <!-- Message list -->
      <div class="w-80 shrink-0 border-r border-base-300 flex flex-col bg-base-100">
        <!-- Search + bulk -->
        <div class="p-2 border-b border-base-300 space-y-1">
          <div class="join w-full">
            <input class="input input-bordered input-sm join-item flex-1" placeholder="Search..." bind:value={searchQuery}
              onkeydown={(e) => e.key === 'Enter' && apiFetch(`/api/mail/search?q=${encodeURIComponent(searchQuery)}`).then(r => messages = r.messages)}/>
            <button class="btn btn-sm join-item" onclick={() => apiFetch(`/api/mail/search?q=${encodeURIComponent(searchQuery)}`).then(r => messages = r.messages)}>
              <Search class="w-3 h-3"/>
            </button>
          </div>

          {#if hasSelection}
            <div class="flex items-center gap-1">
              <span class="text-xs text-base-content/60">{selectedIds.size} selected</span>
              <div class="dropdown dropdown-bottom ml-auto">
                <button class="btn btn-xs btn-ghost gap-1" onclick={() => showBulkMenu = !showBulkMenu}>
                  Actions <ChevronDown class="w-3 h-3"/>
                </button>
                {#if showBulkMenu}
                  <ul class="dropdown-content menu menu-xs bg-base-100 shadow-lg rounded-lg z-50 w-36">
                    <li><button onclick={() => bulkAction('mark_read')}>Mark read</button></li>
                    <li><button onclick={() => bulkAction('mark_unread')}>Mark unread</button></li>
                    <li><button onclick={() => bulkAction('star')}>Star</button></li>
                    <li><button onclick={() => bulkAction('delete')}>Delete</button></li>
                    <li><button onclick={() => bulkAction('spam')}>Spam</button></li>
                  </ul>
                {/if}
              </div>
              <button class="btn btn-xs btn-ghost" onclick={() => selectedIds = new Set()}><X class="w-3 h-3"/></button>
            </div>
          {/if}
        </div>

        <div class="flex-1 overflow-y-auto divide-y divide-base-200">
          {#if loading && messages.length === 0}
            <div class="flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>
          {:else if messages.length === 0}
            <div class="flex flex-col items-center justify-center py-12 text-base-content/40 gap-2">
              <Inbox class="w-8 h-8"/><p class="text-sm">No messages</p>
            </div>
          {:else}
            {#each messages as msg}
              <div class="flex items-start group hover:bg-base-200 transition-colors {selectedMessage?.id === msg.id ? 'bg-primary/10' : ''}">
                <input type="checkbox" class="checkbox checkbox-xs m-3 mt-4 shrink-0 opacity-0 group-hover:opacity-100 {selectedIds.has(msg.id) ? 'opacity-100' : ''}"
                  checked={selectedIds.has(msg.id)}
                  onchange={() => toggleSelect(msg.id)}/>
                <button class="flex-1 text-left px-2 py-2.5 min-w-0" onclick={() => selectMessage(msg)}>
                  <div class="flex items-center justify-between gap-1">
                    <span class="text-xs font-semibold truncate {!msg.is_read ? 'text-primary' : 'text-base-content/70'}">
                      {msg.from_name || msg.from_address}
                    </span>
                    <span class="text-xs text-base-content/40 shrink-0">{formatDate(msg.received_at)}</span>
                  </div>
                  <p class="text-xs font-medium truncate {!msg.is_read ? '' : 'text-base-content/60'}">{msg.subject || '(no subject)'}</p>
                  <p class="text-xs text-base-content/40 truncate">{msg.snippet || ''}</p>
                </button>
                <div class="flex flex-col items-center gap-1 p-1 shrink-0">
                  {#if !msg.is_read}<span class="w-1.5 h-1.5 bg-primary rounded-full"></span>{/if}
                  <button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-xs p-0.5" onclick={() => toggleStar(msg)}>
                    <Star class="w-3 h-3 {msg.is_starred ? 'fill-yellow-400 text-yellow-400' : ''}"/>
                  </button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Message detail -->
      <div class="flex-1 flex flex-col overflow-hidden">
        {#if selectedMessage}
          <div class="p-4 border-b border-base-300 bg-base-100">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <h2 class="text-lg font-semibold">{selectedMessage.subject || '(no subject)'}</h2>
                <div class="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-sm text-base-content/60">
                  <span>From: <strong>{selectedMessage.from_name || selectedMessage.from_address}</strong></span>
                  {#if selectedMessage.to_addresses?.length}
                    <span>To: {selectedMessage.to_addresses.map((t: any) => t.name || t.address).join(', ')}</span>
                  {/if}
                  <span>{new Date(selectedMessage.received_at).toLocaleString()}</span>
                  {#if selectedMessage.priority === 'high'}
                    <span class="badge badge-xs badge-error">High priority</span>
                  {/if}
                </div>
              </div>
              <div class="flex gap-1 shrink-0 flex-wrap justify-end">
                <button class="btn btn-xs btn-ghost gap-1" onclick={() => openReplyContext('reply')} title="Reply">
                  <Reply class="w-3.5 h-3.5"/>
                </button>
                <button class="btn btn-xs btn-ghost gap-1" onclick={() => openReplyContext('reply_all')} title="Reply All">
                  <ReplyAll class="w-3.5 h-3.5"/>
                </button>
                <button class="btn btn-xs btn-ghost gap-1" onclick={() => openReplyContext('forward')} title="Forward">
                  <Forward class="w-3.5 h-3.5"/>
                </button>
                <button class="btn btn-xs btn-ghost gap-1" onclick={downloadEml} title="Download .eml">
                  <Paperclip class="w-3.5 h-3.5"/>
                </button>
                <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteMessage(selectedMessage)}>
                  <Trash2 class="w-3.5 h-3.5"/>
                </button>
              </div>
            </div>

            <!-- AI actions -->
            <div class="flex gap-2 mt-3 flex-wrap">
              <button class="btn btn-xs btn-outline gap-1" onclick={summarizeMessage} disabled={summarizing}>
                {#if summarizing}<span class="loading loading-spinner loading-xs"></span>{:else}<Wand2 class="w-3 h-3"/>{/if}
                Summarize
              </button>
              <button class="btn btn-xs btn-outline gap-1" onclick={generateAiDraft} disabled={aiDraftLoading}>
                {#if aiDraftLoading}<span class="loading loading-spinner loading-xs"></span>{:else}<Wand2 class="w-3 h-3"/>{/if}
                AI Reply
              </button>
            </div>

            {#if summary}
              <div class="mt-2 p-2 bg-primary/5 border border-primary/20 rounded-lg text-sm whitespace-pre-wrap">{summary}</div>
            {/if}
          </div>

          <div class="flex-1 overflow-y-auto p-4">
            {#if selectedMessage.body_html}
              <iframe srcdoc={selectedMessage.body_html} class="w-full min-h-96 border-0 bg-white rounded-lg"
                title="Email body" sandbox="allow-same-origin"></iframe>
            {:else if selectedMessage.body_text}
              <pre class="whitespace-pre-wrap text-sm font-sans">{selectedMessage.body_text}</pre>
            {:else}
              <div class="flex items-center justify-center h-32 text-base-content/40 text-sm">
                <span class="loading loading-spinner loading-sm mr-2"></span> Loading...
              </div>
            {/if}

            {#if selectedMessage.attachments?.length > 0}
              <div class="mt-4 border-t border-base-200 pt-4">
                <p class="text-sm font-semibold mb-2 flex items-center gap-1"><Paperclip class="w-3.5 h-3.5"/> Attachments</p>
                <div class="flex flex-wrap gap-2">
                  {#each selectedMessage.attachments as att}
                    <div class="badge badge-outline gap-1 p-3 text-xs">
                      <Paperclip class="w-3 h-3"/> {att.filename}
                      <span class="opacity-40">({(att.size_bytes / 1024).toFixed(1)} KB)</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>

        {:else if accounts.length === 0 && !loading}
          <div class="flex-1 flex flex-col items-center justify-center gap-4 text-base-content/40">
            <Mail class="w-16 h-16"/>
            <div class="text-center">
              <p class="text-lg font-semibold">No mail accounts</p>
              <p class="text-sm">Add an IMAP/SMTP account to get started.</p>
            </div>
            <button class="btn btn-primary gap-2" onclick={() => showAddAccount = true}>
              <Plus class="w-4 h-4"/> Add Account
            </button>
          </div>
        {:else}
          <div class="flex-1 flex items-center justify-center text-base-content/30">
            <p>Select a message</p>
          </div>
        {/if}
      </div>

    <!-- ─── DRAFTS TAB ─── -->
    {:else if activeTab === 'drafts'}
      <div class="flex-1 p-6 overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-bold">Drafts</h2>
        </div>
        <div class="space-y-2">
          {#each drafts as d}
            <div class="card bg-base-200 shadow-sm">
              <div class="card-body p-4 flex-row items-center justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <p class="font-medium truncate">{d.subject || '(no subject)'}</p>
                  <p class="text-xs text-base-content/50">
                    To: {Array.isArray(d.to_addresses) ? d.to_addresses.map((a: any) => a.address).join(', ') : '—'}
                    · {d.auto_saved_at ? 'Saved ' + formatDate(d.auto_saved_at) : 'Draft'}
                  </p>
                </div>
                <div class="flex gap-2 shrink-0">
                  <button class="btn btn-xs btn-ghost" onclick={() => openDraft(d)}>Edit</button>
                  <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteDraft(d.id)}><Trash2 class="w-3 h-3"/></button>
                </div>
              </div>
            </div>
          {:else}
            <div class="text-center py-12 text-base-content/40">
              <FileText class="w-8 h-8 mx-auto mb-2"/>
              No drafts saved.
            </div>
          {/each}
        </div>
      </div>

    <!-- ─── CONTACTS TAB ─── -->
    {:else if activeTab === 'contacts'}
      <div class="flex-1 p-6 overflow-y-auto">
        <div class="flex items-center justify-between mb-4 gap-3">
          <h2 class="text-lg font-bold">Address Book</h2>
          <input class="input input-sm input-bordered w-56" placeholder="Search contacts..."
            bind:value={contactSearch} onkeydown={(e) => e.key === 'Enter' && loadContacts()}/>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Frequency</th></tr></thead>
            <tbody>
              {#each contacts as c}
                <tr>
                  <td class="font-mono text-xs">{c.email}</td>
                  <td>{c.display_name || '—'}</td>
                  <td>{c.company || '—'}</td>
                  <td><span class="badge badge-xs">{c.frequency}x</span></td>
                </tr>
              {:else}
                <tr><td colspan="4" class="text-center text-base-content/40 py-8">No contacts yet. They're collected automatically when you send emails.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>

    <!-- ─── SIGNATURES TAB ─── -->
    {:else if activeTab === 'signatures'}
      <div class="flex-1 p-6 overflow-y-auto max-w-2xl">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-bold">Signatures</h2>
          <button class="btn btn-sm btn-primary gap-1" onclick={() => { editSig = null; sigName = ''; sigHtml = ''; sigDefault = false; }}>
            <Plus class="w-3 h-3"/> New
          </button>
        </div>

        <!-- Edit form -->
        {#if editSig !== undefined}
          <div class="card bg-base-200 mb-4">
            <div class="card-body gap-3">
              <h3 class="font-semibold text-sm">{editSig ? 'Edit Signature' : 'New Signature'}</h3>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-sm">Name</span></label>
                <input class="input input-sm input-bordered" bind:value={sigName} placeholder="Work, Personal..."/>
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-sm">Signature HTML</span></label>
                <textarea class="textarea textarea-bordered min-h-24 font-mono text-xs" bind:value={sigHtml} placeholder="<p>Your signature here...</p>"></textarea>
              </div>
              <label class="label cursor-pointer justify-start gap-2">
                <input type="checkbox" class="checkbox checkbox-sm" bind:checked={sigDefault}/>
                <span class="label-text text-sm">Set as default</span>
              </label>
              <div class="flex gap-2">
                <button class="btn btn-sm btn-primary" onclick={saveSignature} disabled={!sigName.trim()}>Save</button>
                <button class="btn btn-sm btn-ghost" onclick={() => (editSig = undefined as any)}>Cancel</button>
              </div>
            </div>
          </div>
        {/if}

        <div class="space-y-2">
          {#each signatures as sig}
            <div class="card bg-base-200 shadow-sm">
              <div class="card-body p-4 flex-row items-center justify-between">
                <div>
                  <p class="font-medium">{sig.name} {#if sig.is_default}<span class="badge badge-xs badge-primary ml-1">Default</span>{/if}</p>
                  <p class="text-xs text-base-content/50 mt-0.5">{sig.body_html.replace(/<[^>]*>/g, '').slice(0, 80)}...</p>
                </div>
                <div class="flex gap-2 shrink-0">
                  <button class="btn btn-xs btn-ghost" onclick={() => { editSig = sig; sigName = sig.name; sigHtml = sig.body_html; sigDefault = sig.is_default; }}>Edit</button>
                  <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteSignature(sig.id)}><Trash2 class="w-3 h-3"/></button>
                </div>
              </div>
            </div>
          {:else}
            <div class="text-center py-12 text-base-content/40">No signatures yet.</div>
          {/each}
        </div>
      </div>

    <!-- ─── FILTERS TAB ─── -->
    {:else if activeTab === 'filters'}
      <div class="flex-1 p-6 overflow-y-auto max-w-3xl">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-bold">Mail Filters</h2>
          <button class="btn btn-sm btn-primary gap-1" onclick={() => showFilterModal = true} disabled={!selectedAccount}>
            <Plus class="w-3 h-3"/> New Filter
          </button>
        </div>
        {#if !selectedAccount}
          <div class="alert alert-warning text-sm">Select a mail account first to manage filters.</div>
        {:else}
          <div class="space-y-2">
            {#each filters as f}
              <div class="card bg-base-200 shadow-sm">
                <div class="card-body p-4 flex-row items-center justify-between gap-3">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <p class="font-medium">{f.name}</p>
                      {#if !f.is_active}<span class="badge badge-xs badge-neutral">Disabled</span>{/if}
                    </div>
                    <p class="text-xs text-base-content/50 mt-0.5">
                      {(typeof f.conditions === 'string' ? JSON.parse(f.conditions) : f.conditions).length} condition(s) →
                      {(typeof f.actions === 'string' ? JSON.parse(f.actions) : f.actions).map((a: any) => a.type).join(', ')}
                    </p>
                  </div>
                  <div class="flex gap-2 shrink-0">
                    <input type="checkbox" class="toggle toggle-sm" checked={f.is_active} onchange={() => toggleFilter(f)}/>
                    <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteFilter(f.id)}><Trash2 class="w-3 h-3"/></button>
                  </div>
                </div>
              </div>
            {:else}
              <div class="text-center py-12 text-base-content/40">
                <Filter class="w-8 h-8 mx-auto mb-2"/>
                No filters configured.
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if error}
  <div class="toast toast-end toast-bottom z-50">
    <div class="alert alert-error shadow-lg max-w-sm">
      <X class="w-4 h-4 shrink-0" onclick={() => error = ''}/>
      <span class="text-sm">{error}</span>
    </div>
  </div>
{/if}

<!-- ═══ COMPOSE MODAL ═══ -->
{#if showCompose}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-bold text-lg">{replyToMessageId ? 'Reply' : draftId ? 'Draft' : 'New Message'}</h3>
        <div class="flex gap-2 items-center">
          {#if draftId}<span class="text-xs text-base-content/40">Draft saved</span>{/if}
          <button class="btn btn-sm btn-ghost" onclick={() => showCompose = false}><X class="w-4 h-4"/></button>
        </div>
      </div>

      <div class="space-y-2">
        <!-- To field with autocomplete -->
        <div class="form-control relative">
          <label class="label py-1"><span class="label-text text-sm">To</span></label>
          <input class="input input-bordered input-sm" bind:value={composeTo}
            oninput={(e) => { fetchSuggestions((e.target as HTMLInputElement).value.split(',').pop()?.trim() ?? ''); showToSuggestions = true; }}
            onblur={() => setTimeout(() => showToSuggestions = false, 200)}
            placeholder="email@example.com, ..."/>
          {#if showToSuggestions && toSuggestions.length > 0}
            <ul class="absolute top-full left-0 right-0 bg-base-100 shadow-lg border border-base-300 rounded-lg z-50 max-h-40 overflow-y-auto">
              {#each toSuggestions as c}
                <li>
                  <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-base-200" onclick={() => pickSuggestion(c)}>
                    {c.display_name ? `${c.display_name} <${c.email}>` : c.email}
                    <span class="text-xs text-base-content/40 ml-1">{c.frequency}x</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Cc</span></label>
          <input class="input input-bordered input-sm" bind:value={composeCc} placeholder="Optional"/>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Bcc</span></label>
          <input class="input input-bordered input-sm" bind:value={composeBcc} placeholder="Optional"/>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Subject</span></label>
          <input class="input input-bordered input-sm" bind:value={composeSubject} placeholder="Subject"/>
        </div>

        <!-- Priority + Receipt -->
        <div class="flex gap-4 items-center text-xs text-base-content/60">
          <label class="flex items-center gap-1">
            Priority:
            <select class="select select-xs select-bordered" bind:value={composePriority}>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" class="checkbox checkbox-xs" bind:checked={composeRequestReceipt}/>
            Read receipt
          </label>
        </div>

        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Message</span></label>
          <textarea class="textarea textarea-bordered min-h-48" bind:value={composeBody} placeholder="Write your message..."></textarea>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={autoSaveDraft}>Save Draft</button>
        <button class="btn btn-ghost" onclick={() => showCompose = false}>Discard</button>
        <button class="btn btn-primary gap-2"
          onclick={sendEmail}
          disabled={sendingMail || !composeTo.trim() || !composeSubject.trim()}>
          {#if sendingMail}<span class="loading loading-spinner loading-sm"></span>{:else}<Send class="w-4 h-4"/>{/if}
          Send
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => showCompose = false}></button>
  </dialog>
{/if}

<!-- ═══ ADD ACCOUNT MODAL ═══ -->
{#if showAddAccount}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-xl max-h-[90vh] overflow-y-auto">
      <h3 class="font-bold text-lg mb-4">Add Mail Account</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-sm">Account Name</span></label>
            <input class="input input-bordered input-sm" bind:value={newAccount.name} placeholder="Work, Personal..."/>
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-sm">Email Address</span></label>
            <input class="input input-bordered input-sm" type="email" bind:value={newAccount.email_address}/>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Display Name</span></label>
          <input class="input input-bordered input-sm" bind:value={newAccount.display_name} placeholder="Optional"/>
        </div>
        <div class="divider text-xs">IMAP (Incoming)</div>
        <div class="grid grid-cols-3 gap-2">
          <div class="form-control col-span-2">
            <label class="label py-1"><span class="label-text text-sm">Host</span></label>
            <input class="input input-bordered input-sm" bind:value={newAccount.imap_host} placeholder="imap.gmail.com"/>
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-sm">Port</span></label>
            <input class="input input-bordered input-sm" type="number" bind:value={newAccount.imap_port}/>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-sm">Username</span></label>
            <input class="input input-bordered input-sm" bind:value={newAccount.imap_user}/>
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-sm">Password</span></label>
            <input class="input input-bordered input-sm" type="password" bind:value={newAccount.imap_password}/>
          </div>
        </div>
        <label class="label cursor-pointer justify-start gap-2">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={newAccount.imap_secure}/>
          <span class="label-text text-sm">Use SSL/TLS</span>
        </label>
        <div class="divider text-xs">SMTP (Outgoing)</div>
        <div class="grid grid-cols-3 gap-2">
          <div class="form-control col-span-2">
            <label class="label py-1"><span class="label-text text-sm">Host</span></label>
            <input class="input input-bordered input-sm" bind:value={newAccount.smtp_host} placeholder="smtp.gmail.com"/>
          </div>
          <div class="form-control">
            <label class="label py-1"><span class="label-text text-sm">Port</span></label>
            <input class="input input-bordered input-sm" type="number" bind:value={newAccount.smtp_port}/>
          </div>
        </div>
        <label class="label cursor-pointer justify-start gap-2">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={newAccount.is_default}/>
          <span class="label-text text-sm">Set as default account</span>
        </label>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => showAddAccount = false}>Cancel</button>
        <button class="btn btn-primary gap-2"
          onclick={async () => {
            addingAccount = true; error = '';
            try {
              await apiFetch('/api/mail/accounts', { method: 'POST', body: JSON.stringify(newAccount) });
              showAddAccount = false;
              newAccount = { name: '', email_address: '', display_name: '', imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_password: '', smtp_host: '', smtp_port: 587, smtp_secure: true, smtp_user: '', smtp_password: '', is_default: false };
              await loadAll();
            } catch (e: any) { error = e.message; }
            finally { addingAccount = false; }
          }}
          disabled={addingAccount || !newAccount.email_address || !newAccount.imap_host}>
          {#if addingAccount}<span class="loading loading-spinner loading-sm"></span>{/if}
          Add Account
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => showAddAccount = false}></button>
  </dialog>
{/if}

<!-- ═══ NEW FILTER MODAL ═══ -->
{#if showFilterModal}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-4">New Mail Filter</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Filter Name</span></label>
          <input class="input input-bordered input-sm" bind:value={newFilter.name} placeholder="Block newsletters..."/>
        </div>

        <div>
          <p class="text-sm font-semibold mb-2">Conditions (all must match)</p>
          {#each newFilter.conditions as cond, i}
            <div class="flex gap-2 mb-2 items-center">
              <select class="select select-xs select-bordered" bind:value={cond.field}>
                <option value="from">From</option><option value="to">To</option>
                <option value="subject">Subject</option><option value="body">Body</option>
              </select>
              <select class="select select-xs select-bordered" bind:value={cond.operator}>
                <option value="contains">contains</option><option value="is">is exactly</option>
                <option value="begins_with">starts with</option><option value="ends_with">ends with</option>
              </select>
              <input class="input input-xs input-bordered flex-1" bind:value={cond.value} placeholder="value..."/>
              <button class="btn btn-xs btn-ghost text-error" onclick={() => newFilter.conditions = newFilter.conditions.filter((_: any, j: number) => j !== i)}>
                <X class="w-3 h-3"/>
              </button>
            </div>
          {/each}
          <button class="btn btn-xs btn-ghost gap-1" onclick={() => newFilter.conditions = [...newFilter.conditions, { field: 'from', operator: 'contains', value: '' }]}>
            <Plus class="w-3 h-3"/> Add Condition
          </button>
        </div>

        <div>
          <p class="text-sm font-semibold mb-2">Actions</p>
          {#each newFilter.actions as action, i}
            <div class="flex gap-2 mb-2 items-center">
              <select class="select select-xs select-bordered" bind:value={action.type}>
                <option value="mark_read">Mark as read</option>
                <option value="mark_starred">Star</option>
                <option value="move">Move to folder</option>
                <option value="delete">Delete</option>
                <option value="forward">Forward to</option>
                <option value="stop">Stop processing</option>
              </select>
              {#if action.type === 'move'}
                <input class="input input-xs input-bordered flex-1" bind:value={(action as any).folder} placeholder="INBOX.Newsletter"/>
              {:else if action.type === 'forward'}
                <input class="input input-xs input-bordered flex-1" bind:value={(action as any).address} placeholder="forward@example.com" type="email"/>
              {/if}
              <button class="btn btn-xs btn-ghost text-error" onclick={() => newFilter.actions = newFilter.actions.filter((_: any, j: number) => j !== i)}>
                <X class="w-3 h-3"/>
              </button>
            </div>
          {/each}
          <button class="btn btn-xs btn-ghost gap-1" onclick={() => newFilter.actions = [...newFilter.actions, { type: 'mark_read' }]}>
            <Plus class="w-3 h-3"/> Add Action
          </button>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => showFilterModal = false}>Cancel</button>
        <button class="btn btn-primary" onclick={saveFilter} disabled={!newFilter.name || !newFilter.conditions.length}>
          Save Filter
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => showFilterModal = false}></button>
  </dialog>
{/if}
