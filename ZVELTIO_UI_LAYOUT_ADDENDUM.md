# Zveltio Studio — Addendum instrucțiuni UI/UX (pagini lipsă + patterns globale)

---

## PAGINI LIPSĂ DIN DOCUMENTUL ANTERIOR

---

## PAGINA 16 — MARKETPLACE (`marketplace/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/marketplace/+page.svelte`

### Problema actuală
Extensiile sunt listate ca un grid de carduri simple fără categorizare vizuală clară. Butoanele Install/Enable/Disable sunt pe fiecare card dar nu există filtrare pe categorie.

### Fix: Layout cu sidebar categorii + grid principal

```svelte
<div class="flex gap-5">
  <!-- Categorii sidebar -->
  <nav class="w-36 shrink-0 space-y-0.5">
    <button class="w-full text-left px-3 py-1.5 rounded-lg text-sm {cat === 'all' ? 'bg-primary/10 text-primary font-medium' : 'text-base-content/60 hover:bg-base-200'}"
            onclick={() => cat = 'all'}>
      All ({extensions.length})
    </button>
    {#each CATEGORIES as c}
      <button class="w-full text-left px-3 py-1.5 rounded-lg text-sm capitalize
                     {cat === c.id ? 'bg-primary/10 text-primary font-medium' : 'text-base-content/60 hover:bg-base-200'}"
              onclick={() => cat = c.id}>
        {c.label} ({c.count})
      </button>
    {/each}
  </nav>

  <!-- Grid extensii -->
  <div class="flex-1 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
    {#each filtered as ext}
      <div class="card bg-base-100 border border-base-200 hover:border-primary/20 transition-all">
        <div class="card-body p-4 gap-3">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm">{ext.displayName}</span>
                {#if ext.is_running}
                  <span class="badge badge-success badge-xs">active</span>
                {:else if ext.is_installed}
                  <span class="badge badge-ghost badge-xs">installed</span>
                {/if}
              </div>
              <p class="text-xs text-base-content/40 mt-0.5 line-clamp-2">{ext.description}</p>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-base-content/30 font-mono">{ext.version}</span>
            <!-- Action button -->
            {#if !ext.is_installed}
              <button class="btn btn-primary btn-xs" onclick={() => install(ext)}>Install</button>
            {:else if !ext.is_enabled}
              <button class="btn btn-outline btn-xs" onclick={() => enable(ext)}>Enable</button>
            {:else}
              <button class="btn btn-ghost btn-xs text-error" onclick={() => disable(ext)}>Disable</button>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
```

### Fix: Banner "restart needed"

```svelte
{#if restartNeeded}
  <div class="alert alert-warning py-2 mb-4 text-sm">
    <span>Some extensions require a server restart to take effect.</span>
    <a href="/api/admin/restart" class="btn btn-warning btn-xs">Restart now</a>
  </div>
{/if}
```

---

## PAGINA 17 — INSIGHTS (`insights/+page.svelte`)

### Problema actuală
Layout bun (sidebar + main) dar panelurile cu chart sunt fallback la tabel. SQL Console e un fixed bottom bar — blochează conținutul.

### Fix 1: SQL Console ca drawer lateral, nu bottom bar

```svelte
<!-- Înlocuiește fixed bottom bar cu un drawer lateral -->
{#if showAdHoc}
  <div class="fixed right-0 top-0 h-full w-96 bg-base-100 border-l border-base-300 shadow-2xl z-40 flex flex-col">
    <div class="flex items-center justify-between p-4 border-b border-base-300">
      <span class="font-semibold text-sm flex items-center gap-2">
        <Code2 size={16} /> SQL Console
      </span>
      <button class="btn btn-ghost btn-xs" onclick={() => showAdHoc = false}><X size={14} /></button>
    </div>
    <div class="flex-1 overflow-auto p-4 space-y-3">
      <textarea class="textarea textarea-sm font-mono text-xs w-full resize-none" rows="6"
                bind:value={adHocQuery} />
      <button class="btn btn-primary btn-sm w-full gap-1" onclick={runAdHoc}>
        <Play size={13} /> Run Query
      </button>
      {#if adHocResult}
        <!-- Results -->
      {/if}
    </div>
  </div>
{/if}
```

### Fix 2: Paneluri cu charting real

Adaugă Chart.js pentru panelurile de tip bar/line/pie:

```svelte
{#if p.type === 'bar' || p.type === 'line'}
  <canvas id="chart-{p.id}" height="150"></canvas>
  <!-- Inițializat cu Chart.js în $effect -->
{/if}
```

---

## PAGINA 18 — API KEYS (`api-keys/+page.svelte`)

### Fix: Tabel cu prefix + expiry + last used

```svelte
<table class="table table-sm w-full">
  <thead>
    <tr>
      <th>Name</th>
      <th>Prefix</th>
      <th>Scopes</th>
      <th>Last used</th>
      <th>Expires</th>
      <th>Status</th>
      <th class="text-right">Actions</th>
    </tr>
  </thead>
  <tbody>
    {#each keys as key}
      <tr class="hover group">
        <td class="font-medium text-sm">{key.name}</td>
        <td class="font-mono text-xs text-base-content/50">{key.key_prefix}...</td>
        <td class="text-xs">
          {#if key.scopes?.length === 0}
            <span class="badge badge-warning badge-xs">full access</span>
          {:else}
            <span class="text-base-content/50">{key.scopes?.length} collections</span>
          {/if}
        </td>
        <td class="text-xs text-base-content/50">{key.last_used_at ? formatRelative(key.last_used_at) : 'Never'}</td>
        <td class="text-xs text-base-content/50">{key.expires_at ? formatDate(key.expires_at) : '—'}</td>
        <td>
          <span class="badge badge-xs {key.is_active ? 'badge-success' : 'badge-ghost'}">
            {key.is_active ? 'active' : 'revoked'}
          </span>
        </td>
        <td class="text-right">
          <button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100"
                  onclick={() => revoke(key.id, key.name)}>Revoke</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
```

### Fix: Modalul de creare — adaugă expiry + IP whitelist

```svelte
<!-- Adaugă în form -->
<div class="grid grid-cols-2 gap-3">
  <div class="form-control">
    <label class="label"><span class="label-text text-xs">Expires (optional)</span></label>
    <input type="date" class="input input-sm" bind:value={form.expires_at} />
  </div>
  <div class="form-control">
    <label class="label"><span class="label-text text-xs">Rate limit (req/hour)</span></label>
    <input type="number" class="input input-sm" bind:value={form.rate_limit} placeholder="1000" />
  </div>
</div>
```

---

## PAGINA 19 — TENANTS (`tenants/+page.svelte`)

### Fix: Cards → Tabel cu plan badge + usage bars

```svelte
<table class="table table-sm w-full">
  <thead>
    <tr><th>Tenant</th><th>Plan</th><th>Records</th><th>API calls today</th><th>Status</th><th class="text-right">Actions</th></tr>
  </thead>
  <tbody>
    {#each tenants as t}
      <tr class="hover group">
        <td>
          <div class="font-medium text-sm">{t.name}</div>
          <div class="text-xs text-base-content/40 font-mono">{t.slug}</div>
        </td>
        <td>
          <span class="badge badge-xs {PLAN_BADGES[t.plan] ?? 'badge-ghost'} capitalize">{t.plan}</span>
        </td>
        <td>
          <div class="flex items-center gap-2">
            <div class="w-16 h-1.5 bg-base-200 rounded-full overflow-hidden">
              <div class="h-full bg-primary rounded-full"
                   style="width: {Math.min((t._record_count / t.max_records) * 100, 100)}%"></div>
            </div>
            <span class="text-xs text-base-content/50">{t._record_count?.toLocaleString()} / {t.max_records?.toLocaleString()}</span>
          </div>
        </td>
        <td class="text-xs text-base-content/50">{t._api_calls_today?.toLocaleString() ?? '—'}</td>
        <td>
          <span class="badge badge-xs {t.status === 'active' ? 'badge-success' : 'badge-error'}">{t.status}</span>
        </td>
        <td class="text-right">
          <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" onclick={() => openEdit(t)}>Edit</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
```

---

## PAGINA 20 — AUDIT LOG (`audit/+page.svelte`)

### Fix: Timeline view cu filtrare

```svelte
<!-- Filters -->
<div class="flex gap-2 mb-4 flex-wrap">
  <select class="select select-sm" bind:value={filterType}>
    <option value="">All events</option>
    <option value="auth">Auth</option>
    <option value="data">Data</option>
    <option value="admin">Admin</option>
    <option value="api_key">API Keys</option>
  </select>
  <input type="text" class="input input-sm" placeholder="Filter by user..." bind:value={filterUser} />
  <input type="date" class="input input-sm" bind:value={filterFrom} />
</div>

<!-- Timeline list -->
<div class="space-y-1">
  {#each audit as entry}
    <div class="flex gap-3 items-start py-2 px-3 rounded-lg hover:bg-base-200 group">
      <!-- Event icon -->
      <div class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5
                  {EVENT_COLORS[entry.event_type] ?? 'bg-base-300'}">
        <svelte:component this={EVENT_ICONS[entry.event_type]} size={11} />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="text-sm font-medium">{formatEventType(entry.event_type)}</span>
          <span class="text-xs text-base-content/40 font-mono">{entry.resource_type}/{entry.resource_id?.slice(0,8)}</span>
        </div>
        <div class="text-xs text-base-content/50">{entry.user_email ?? 'system'}</div>
      </div>
      <span class="text-xs text-base-content/35 shrink-0">{formatRelative(entry.created_at)}</span>
    </div>
  {/each}
</div>
```

---

## PAGINA 21 — NOTIFICATIONS (`notifications/+page.svelte`)

### Fix: Split view notificări primite vs reguli de notificare

```svelte
<!-- Tab-uri: Inbox | Rules -->
<div class="border-b border-base-200 mb-4">
  <div class="flex gap-0">
    <button class="px-4 py-2.5 text-sm font-medium border-b-2 {activeTab === 'inbox' ? 'border-primary text-primary' : 'border-transparent text-base-content/50'}"
            onclick={() => activeTab = 'inbox'}>
      Inbox
      {#if unreadCount > 0}
        <span class="badge badge-primary badge-xs ml-1">{unreadCount}</span>
      {/if}
    </button>
    <button class="px-4 py-2.5 text-sm font-medium border-b-2 {activeTab === 'rules' ? 'border-primary text-primary' : 'border-transparent text-base-content/50'}"
            onclick={() => activeTab = 'rules'}>Rules</button>
  </div>
</div>
```

---

## PAGINA 22 — APPROVALS (`approvals/+page.svelte`)

### Fix: Kanban view cu coloane pe status

```svelte
<div class="grid grid-cols-3 gap-4">
  {#each ['pending', 'in_review', 'completed'] as status}
    <div>
      <div class="flex items-center gap-2 mb-3">
        <span class="w-2 h-2 rounded-full {STATUS_COLORS[status]}"></span>
        <span class="text-sm font-medium capitalize">{status.replace('_', ' ')}</span>
        <span class="badge badge-ghost badge-xs">{countByStatus[status]}</span>
      </div>
      <div class="space-y-2">
        {#each approvals.filter(a => a.status === status) as approval}
          <div class="card bg-base-100 border border-base-200 p-3 cursor-pointer hover:border-primary/30">
            <div class="font-medium text-sm">{approval.title}</div>
            <div class="text-xs text-base-content/50 mt-1">{approval.requested_by} · {formatRelative(approval.created_at)}</div>
            {#if approval.due_date}
              <div class="text-xs text-warning mt-1">Due {formatDate(approval.due_date)}</div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
```

---

## PAGINA 23 — EDGE FUNCTIONS (`edge-functions/+page.svelte`)

### Fix: Code editor + test panel split view

```svelte
<div class="flex h-[calc(100vh-160px)] gap-0 -mx-6 border-t border-base-200">
  <!-- Functions list -->
  <div class="w-56 border-r border-base-200 flex flex-col">
    <div class="p-3 border-b border-base-200 flex items-center justify-between">
      <span class="text-xs font-medium">Functions</span>
      <button class="btn btn-ghost btn-xs" onclick={createFunction}><Plus size={12} /></button>
    </div>
    <div class="flex-1 overflow-y-auto">
      {#each functions as fn}
        <button class="w-full text-left px-3 py-2 text-xs hover:bg-base-200 flex items-center gap-2
                       {activeFunction?.id === fn.id ? 'bg-primary/10 text-primary' : 'text-base-content/60'}"
                onclick={() => selectFunction(fn)}>
          <Code size={11} class="shrink-0" />
          <span class="truncate font-mono">{fn.name}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Editor + test panel -->
  {#if activeFunction}
    <div class="flex-1 flex flex-col">
      <!-- Toolbar -->
      <div class="flex items-center gap-2 px-4 py-2 border-b border-base-200 bg-base-50">
        <span class="text-xs font-mono text-base-content/60">{activeFunction.name}</span>
        <div class="ml-auto flex gap-2">
          <button class="btn btn-ghost btn-xs gap-1" onclick={testFunction}><Play size={11} /> Test</button>
          <button class="btn btn-primary btn-xs gap-1" onclick={saveFunction}><Save size={11} /> Save</button>
        </div>
      </div>
      <!-- Monaco / textarea editor -->
      <textarea class="flex-1 font-mono text-xs p-4 bg-base-50 resize-none outline-none border-b border-base-200"
                bind:value={activeFunction.code} />
      <!-- Test output -->
      {#if testOutput}
        <div class="h-36 overflow-auto p-3 font-mono text-xs bg-base-900 text-base-content border-t border-base-200">
          <pre>{testOutput}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>
```

---

## PAGINA 24 — VIRTUAL COLLECTIONS (`virtual-collections/+page.svelte`)

### Fix: Card cu status de conectivitate live

```svelte
{#each collections as col}
  <div class="card bg-base-100 border border-base-200 p-4">
    <div class="flex items-center justify-between mb-2">
      <div>
        <span class="font-medium">{col.display_name || col.name}</span>
        <span class="text-xs text-base-content/40 font-mono ml-2">{col.name}</span>
      </div>
      <!-- Ping indicator -->
      <div class="flex items-center gap-1.5">
        {#if col._ping_ok}
          <span class="w-2 h-2 rounded-full bg-success animate-pulse"></span>
          <span class="text-xs text-success">Live</span>
        {:else}
          <span class="w-2 h-2 rounded-full bg-error"></span>
          <span class="text-xs text-error">Offline</span>
        {/if}
      </div>
    </div>
    <p class="text-xs text-base-content/40 font-mono truncate">{col.virtual_config?.source_url}</p>
    <div class="flex gap-1.5 mt-2">
      <span class="badge badge-outline badge-xs">{col.virtual_config?.auth_type}</span>
      <a href="/collections/{col.name}" class="btn btn-ghost btn-xs ml-auto">Browse data</a>
    </div>
  </div>
{/each}
```

---

## PAGINA 25 — BYOD IMPORT (`introspect/+page.svelte`)

### Fix: Stepper clar în loc de form simplu

```svelte
<!-- Stepper: Connect → Preview → Import -->
<div class="max-w-2xl mx-auto">
  <div class="steps steps-horizontal w-full mb-8">
    <div class="step {step >= 1 ? 'step-primary' : ''}">Connect DB</div>
    <div class="step {step >= 2 ? 'step-primary' : ''}">Preview Tables</div>
    <div class="step {step >= 3 ? 'step-primary' : ''}">Import</div>
  </div>

  {#if step === 1}
    <div class="card bg-base-100 border border-base-200 p-6">
      <h2 class="font-semibold mb-4">External Database Connection</h2>
      <div class="form-control mb-3">
        <label class="label"><span class="label-text">Connection string</span></label>
        <input type="text" class="input font-mono text-sm"
               placeholder="postgresql://user:pass@host:5432/dbname"
               bind:value={connectionString} />
      </div>
      <div class="form-control mb-4">
        <label class="label"><span class="label-text">Schema</span></label>
        <input type="text" class="input input-sm" placeholder="public" bind:value={schema} />
      </div>
      <button class="btn btn-primary w-full" onclick={connect} disabled={connecting}>
        {#if connecting}<span class="loading loading-spinner loading-sm"></span>{/if}
        Connect & Scan
      </button>
    </div>
  {:else if step === 2}
    <!-- Table selection -->
  {:else if step === 3}
    <!-- Import progress -->
  {/if}
</div>
```

---

## PAGINA 26 — SAVED QUERIES (`saved-queries/+page.svelte`)

### Fix: Split view list + query editor

```svelte
<div class="flex gap-4 h-[calc(100vh-160px)]">
  <!-- Lista query-urilor -->
  <div class="w-64 shrink-0 flex flex-col border border-base-200 rounded-xl overflow-hidden">
    <div class="p-3 border-b border-base-200 flex items-center justify-between">
      <span class="text-sm font-medium">Saved Queries</span>
      <button class="btn btn-ghost btn-xs" onclick={newQuery}><Plus size={12} /></button>
    </div>
    <div class="flex-1 overflow-y-auto">
      {#each queries as q}
        <button class="w-full text-left px-3 py-2.5 border-b border-base-200/50 hover:bg-base-200
                       {activeQuery?.id === q.id ? 'bg-primary/8' : ''}"
                onclick={() => activeQuery = q}>
          <div class="text-sm font-medium truncate">{q.name}</div>
          <div class="text-xs text-base-content/40 font-mono truncate">{q.sql?.slice(0, 40)}...</div>
        </button>
      {/each}
    </div>
  </div>
  <!-- Editor și rezultate -->
  <div class="flex-1 flex flex-col gap-3">
    {#if activeQuery}
      <textarea class="textarea font-mono text-xs flex-1" bind:value={activeQuery.sql} />
      <div class="flex gap-2">
        <button class="btn btn-primary btn-sm gap-1" onclick={runQuery}><Play size={13} /> Run</button>
        <button class="btn btn-ghost btn-sm" onclick={saveQuery}>Save</button>
      </div>
      <!-- Results -->
    {/if}
  </div>
</div>
```

---

## PAGINA 27 — SCHEMA BRANCHES (`schema-branches/+page.svelte`)

### Fix: Git-style branch list

```svelte
<!-- Main branch indicator -->
<div class="flex items-center gap-3 p-4 bg-primary/5 border border-primary/20 rounded-xl mb-4">
  <GitBranch size={16} class="text-primary" />
  <div>
    <span class="font-medium text-sm">main</span>
    <span class="badge badge-primary badge-xs ml-2">current</span>
  </div>
  <span class="text-xs text-base-content/50 ml-auto">Schema v{schemaVersion}</span>
</div>

<!-- Other branches -->
{#each branches as branch}
  <div class="flex items-center gap-3 p-3 border border-base-200 rounded-lg hover:border-primary/30 mb-2">
    <GitBranch size={14} class="text-base-content/40 shrink-0" />
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-mono text-sm">{branch.name}</span>
        <span class="text-xs text-base-content/40">from {branch.base_version}</span>
      </div>
      <div class="text-xs text-base-content/40">{branch.description}</div>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-xs">Switch</button>
      <button class="btn btn-outline btn-xs btn-success">Merge</button>
    </div>
  </div>
{/each}
```

---

## PAGINA 28 — BACKUP (`backup/+page.svelte`)

### Fix: Timeline backups + status clar

```svelte
<div class="space-y-3">
  {#each backups as backup}
    <div class="flex items-center gap-4 p-3 border border-base-200 rounded-xl hover:bg-base-50">
      <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0
                  {backup.status === 'completed' ? 'bg-success/10' : backup.status === 'failed' ? 'bg-error/10' : 'bg-warning/10'}">
        <DatabaseBackup size={18} class="{backup.status === 'completed' ? 'text-success' : backup.status === 'failed' ? 'text-error' : 'text-warning'}" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium text-sm">{formatDate(backup.created_at)}</span>
          <span class="badge badge-xs {backup.status === 'completed' ? 'badge-success' : backup.status === 'failed' ? 'badge-error' : 'badge-warning'}">{backup.status}</span>
          {#if backup.type === 'auto'}
            <span class="badge badge-ghost badge-xs">auto</span>
          {/if}
        </div>
        <div class="text-xs text-base-content/40">{backup.size_mb?.toFixed(1)} MB · {backup.tables_count} tables</div>
      </div>
      {#if backup.status === 'completed'}
        <button class="btn btn-ghost btn-xs" onclick={() => restore(backup)}>Restore</button>
        <a href={backup.download_url} class="btn btn-ghost btn-xs"><Download size={13} /></a>
      {/if}
    </div>
  {/each}
</div>
```

---

## PAGINA 29 — TRANSLATIONS (`translations/+page.svelte`)

### Fix: Layout cu coloane pe limbă

```svelte
<div class="overflow-auto">
  <table class="table table-sm w-full">
    <thead class="sticky top-0 bg-base-100 z-10">
      <tr>
        <th class="w-48">Key</th>
        {#each languages as lang}
          <th>
            <div class="flex items-center gap-2">
              <span>{lang.flag}</span>
              <span>{lang.name}</span>
              <span class="badge badge-ghost badge-xs">{lang.completion}%</span>
            </div>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each keys as key}
        <tr class="hover group">
          <td class="font-mono text-xs text-base-content/60">{key}</td>
          {#each languages as lang}
            <td>
              {#if editingCell === `${key}:${lang.code}`}
                <input class="input input-xs w-full"
                       bind:value={translations[lang.code][key]}
                       onblur={() => { saveTranslation(key, lang.code); editingCell = null; }} />
              {:else}
                <button class="text-left text-sm w-full hover:bg-base-200 px-1 rounded"
                        onclick={() => editingCell = `${key}:${lang.code}`}>
                  {translations[lang.code]?.[key] || <span class="text-error/60 italic">missing</span>}
                </button>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
```

---

## PAGINA 30 — MAIL CLIENT (`mail/+page.svelte`)

### Fix: Layout email client standard (3 panele)

```svelte
<div class="flex h-[calc(100vh-100px)] -mx-6 border-t border-base-200">
  <!-- Accounts + Folders -->
  <div class="w-48 border-r border-base-200 flex flex-col bg-base-50">
    {#each accounts as acc}
      <div class="px-3 py-2 border-b border-base-200">
        <div class="text-xs font-medium truncate">{acc.email}</div>
        <div class="text-[10px] text-base-content/40">{acc.provider}</div>
      </div>
      <div class="py-1">
        {#each ['Inbox', 'Sent', 'Drafts', 'Trash'] as folder}
          <button class="w-full text-left px-4 py-1.5 text-xs hover:bg-base-200 flex items-center justify-between">
            {folder}
            {#if folder === 'Inbox' && acc.unread > 0}
              <span class="badge badge-primary badge-xs">{acc.unread}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <!-- Message list -->
  <div class="w-72 border-r border-base-200 overflow-y-auto">
    {#each messages as msg}
      <button class="w-full text-left p-3 border-b border-base-200/50 hover:bg-base-100
                     {activeMessage?.id === msg.id ? 'bg-primary/5' : ''}
                     {!msg.read ? 'bg-base-50' : ''}"
              onclick={() => activeMessage = msg}>
        <div class="flex items-baseline justify-between mb-1">
          <span class="text-xs font-{msg.read ? 'normal' : 'semibold'}">{msg.from_name}</span>
          <span class="text-[10px] text-base-content/40">{formatRelative(msg.date)}</span>
        </div>
        <div class="text-xs text-base-content/70 truncate">{msg.subject}</div>
        <div class="text-[10px] text-base-content/40 truncate">{msg.preview}</div>
      </button>
    {/each}
  </div>

  <!-- Message body -->
  <div class="flex-1 overflow-y-auto p-6">
    {#if activeMessage}
      <div class="max-w-2xl">
        <h2 class="text-lg font-semibold mb-2">{activeMessage.subject}</h2>
        <div class="flex items-center gap-2 mb-4 text-sm text-base-content/60">
          <span>{activeMessage.from}</span>
          <span>→</span>
          <span>{activeMessage.to}</span>
          <span class="ml-auto">{formatDate(activeMessage.date)}</span>
        </div>
        <div class="prose prose-sm max-w-none">
          {@html activeMessage.html_body || activeMessage.text_body}
        </div>
      </div>
    {:else}
      <EmptyState icon={Mail} title="Select a message" description="Choose a message from the list to read it." />
    {/if}
  </div>
</div>
```

---

## PATTERNS GLOBALE LIPSĂ — critice

### P1 — Paginare: componentă lipsă complet

Crează `packages/studio/src/lib/components/common/Pagination.svelte`:

```svelte
<script lang="ts">
  interface Props {
    total: number;
    page: number;
    limit: number;
    onchange: (page: number) => void;
  }
  let { total, page, limit, onchange } = $props();
  const totalPages = $derived(Math.ceil(total / limit));
  const from = $derived((page - 1) * limit + 1);
  const to = $derived(Math.min(page * limit, total));
</script>

{#if totalPages > 1}
  <div class="flex items-center justify-between mt-4 text-sm">
    <span class="text-base-content/50 text-xs">{from}–{to} of {total.toLocaleString()}</span>
    <div class="join">
      <button class="join-item btn btn-xs" disabled={page === 1} onclick={() => onchange(page - 1)}>«</button>
      {#each Array.from({length: Math.min(totalPages, 7)}, (_, i) => {
        if (totalPages <= 7) return i + 1;
        if (i === 0) return 1;
        if (i === 6) return totalPages;
        if (page <= 4) return i + 1;
        if (page >= totalPages - 3) return totalPages - 6 + i;
        return page - 3 + i;
      }) as p}
        <button class="join-item btn btn-xs {p === page ? 'btn-primary' : ''}"
                onclick={() => onchange(p)}>{p}</button>
      {/each}
      <button class="join-item btn btn-xs" disabled={page === totalPages} onclick={() => onchange(page + 1)}>»</button>
    </div>
  </div>
{/if}
```

Aplică `Pagination` în: Collections data, Users, API Keys, Webhooks, Audit Log, Flows.

---

### P2 — Search + Filter: pattern unificat

Crează `packages/studio/src/lib/components/common/SearchBar.svelte`:

```svelte
<script lang="ts">
  interface Props {
    value: string;
    placeholder?: string;
    onchange: (v: string) => void;
  }
  let { value, placeholder = 'Search...', onchange } = $props();
</script>

<label class="input input-sm flex items-center gap-2 max-w-64">
  <Search size={13} class="text-base-content/40 shrink-0" />
  <input type="text" {placeholder} value={value}
         oninput={(e) => onchange((e.target as HTMLInputElement).value)}
         class="grow" />
  {#if value}
    <button onclick={() => onchange('')} class="text-base-content/30 hover:text-base-content">
      <X size={12} />
    </button>
  {/if}
</label>
```

Aplică în toate paginile cu liste (colecții, users, etc.).

---

### P3 — Modal sizing: standardizare

Toate modalele din Studio trebuie să urmeze aceste dimensiuni:

| Conținut | Clasă DaisyUI |
|---|---|
| Confirmare simplă | `max-w-sm` |
| Formular simplu (2-4 câmpuri) | `max-w-md` |
| Formular complex | `max-w-2xl` |
| Editor full (code, richtext) | `max-w-4xl` |

Verifică și aliniază TOATE modalele.

---

### P4 — Mobile responsiveness

Verifică și adaugă `lg:hidden` / `hidden lg:flex` pe:
- Sidebar complet ascuns pe mobile, deschis cu hamburger
- Coloane de tabel reduse pe mobile (ascunde coloane secundare)
- Cards restack vertical pe mobile

Pattern pentru tabel responsive:

```svelte
<!-- Ascunde coloane neesențiale pe mobile -->
<th class="hidden md:table-cell">Last active</th>
<th class="hidden lg:table-cell">Created</th>
```

---

### P5 — Success feedback: pattern unificat

Oriunde există `saved = true` + setTimeout, înlocuiește cu toast:

```svelte
// VECHI:
saved = true;
setTimeout(() => saved = false, 2000);

// NOU:
toast.success('Saved successfully');
```

---

### P6 — Form validation: feedback vizual inline

Pe toate formularele cu validare, adaugă mesaje inline sub câmp:

```svelte
<div class="form-control">
  <label class="label" for="field-name">
    <span class="label-text">Collection name</span>
  </label>
  <input id="field-name"
         class="input {nameError ? 'input-error' : ''}"
         bind:value={name}
         oninput={validateName} />
  {#if nameError}
    <div class="label">
      <span class="label-text-alt text-error text-xs">{nameError}</span>
    </div>
  {/if}
</div>
```

---

### P7 — Keyboard navigation

Adaugă pe TOATE modalele:

```svelte
<svelte:window onkeydown={(e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.metaKey) save();
}} />
```

Adaugă `tabindex` corect pe elementele interactive custom (toggle switches, badge buttons).

---

### P8 — CLIENT PORTAL pages

**Fișiere:** `packages/studio/src/routes/(client)/portal-client/*`

Pagina de login e OK. Paginile de dashboard/tickets/profile sunt stub-uri. Trebuie:
- dashboard: widget-uri cu date reale din zone (calls `/api/zones/client/render/dashboard`)
- profile: formular editare profil user
- tickets: CRUD pe o colecție de suport

---

### P9 — INTRANET pages

**Fișiere:** `packages/studio/src/routes/(intranet)/*`

Navigația e hardcodată cu 5 items fixe. Trebuie să consume `/api/zones/intranet/pages` dinamic (la fel ca client portal).

---

### P10 — LOGIN page (`login/+page.svelte`)

### Fix: design mai curat

```svelte
<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="w-full max-w-sm">
    <!-- Logo centered -->
    <div class="text-center mb-8">
      <div class="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
           style="background: linear-gradient(135deg, #6366f1, #8b5cf6)">
        <span class="text-white font-bold text-xl">Z</span>
      </div>
      <h1 class="text-2xl font-semibold">Zveltio Studio</h1>
      <p class="text-base-content/50 text-sm mt-1">Sign in to your account</p>
    </div>

    <!-- Card -->
    <div class="card bg-base-100 shadow-lg">
      <div class="card-body gap-4">
        <div class="form-control">
          <label class="label py-1"><span class="label-text text-sm">Email</span></label>
          <input type="email" class="input" placeholder="admin@example.com" bind:value={email} />
        </div>
        <div class="form-control">
          <label class="label py-1">
            <span class="label-text text-sm">Password</span>
            <a href="/forgot-password" class="label-text-alt text-primary text-xs">Forgot?</a>
          </label>
          <input type="password" class="input" bind:value={password}
                 onkeydown={(e) => e.key === 'Enter' && login()} />
        </div>
        {#if error}
          <div class="alert alert-error py-2 text-sm">{error}</div>
        {/if}
        <button class="btn btn-primary w-full" onclick={login} disabled={loading}>
          {#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
          Sign In
        </button>
      </div>
    </div>
  </div>
</div>
```

---

## ORDINE COMPLETĂ DE IMPLEMENTARE

```
SPRINT 1 — Fundații (blochează tot restul):
  PageHeader, EmptyState, SectionCard, SearchBar, Pagination
  Schimbare paletă culori (indigo)
  Aplicare PageHeader pe toate paginile

SPRINT 2 — Core pages (trafic mare zilnic):
  Collections: template-uri + type picker + inline add
  Users: tabel nou cu avatare
  Webhooks: tabel scanabil
  Flows: status vizual

SPRINT 3 — Access + Automation:
  Permissions: sticky matrix
  API Keys: tabel + expiry
  Tenants: usage bars
  Approvals: kanban view

SPRINT 4 — Developer tools:
  Edge Functions: split view
  Saved Queries: split view
  Schema Branches: git-style
  Virtual Collections: ping indicator
  BYOD Import: stepper

SPRINT 5 — Operations + Intelligence:
  Audit Log: timeline + filtre
  Backup: timeline view
  Insights: SQL drawer lateral + Chart.js
  Marketplace: categorii sidebar

SPRINT 6 — Content + Comms:
  Translations: inline edit pe coloane
  Mail: 3-panel email client
  Notifications: inbox + rules tabs

SPRINT 7 — Portals:
  Login page redesign
  Client Portal pages (reale, nu stub-uri)
  Intranet pages (navigație dinamică)

SPRINT 8 — Polish + Patterns globale:
  Paginare pe toate listele
  Keyboard shortcuts (Escape, Cmd+Enter)
  Mobile responsiveness
  Form validation inline
  Success/error feedback unificat
```

---

## SUMAR PAGINI ACOPERITE TOTAL (ambele documente)

| # | Pagină | Document |
|---|---|---|
| 1 | Layout + Sidebar | Doc 1 |
| 2 | Dashboard | Doc 1 |
| 3 | Collections List | Doc 1 |
| 4 | Collection Detail | Doc 1 |
| 5 | Fields | Doc 1 |
| 6 | Relations | Doc 1 (menționat) |
| 7 | Users | Doc 1 |
| 8 | Permissions | Doc 1 |
| 9 | API Keys | Doc 2 |
| 10 | Tenants | Doc 2 |
| 11 | Webhooks | Doc 1 |
| 12 | Flows | Doc 1 |
| 13 | Notifications | Doc 2 |
| 14 | Approvals | Doc 2 |
| 15 | AI Hub | Doc 1 |
| 16 | Insights | Doc 2 |
| 17 | Edge Functions | Doc 2 |
| 18 | Schema Branches | Doc 2 |
| 19 | Virtual Collections | Doc 2 |
| 20 | Saved Queries | Doc 2 |
| 21 | BYOD Import | Doc 2 |
| 22 | Storage | Doc 1 |
| 23 | Media | Doc 1 |
| 24 | Backup | Doc 2 |
| 25 | Audit Log | Doc 2 |
| 26 | Translations | Doc 2 |
| 27 | Mail | Doc 2 |
| 28 | Marketplace | Doc 2 |
| 29 | Zones | Doc 1 |
| 30 | Views | Doc 1 |
| 31 | Settings | Doc 1 |
| 32 | Login | Doc 2 |
| 33 | Client Portal | Doc 2 |
| 34 | Intranet | Doc 2 |
| 35 | Patterns globale (10x) | Doc 2 |
