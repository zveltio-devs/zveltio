# Zveltio Studio — Instrucțiuni complete de optimizare UI/UX pentru Claude Code

---

## PRINCIPII GLOBALE (aplică peste tot, fără excepție)

### 1. Sistemul de design tokens

Înlocuiește toate referințele la culoarea `#069494` / `oklch(0.57 0.10 188)` cu noua paletă:

```css
/* packages/studio/src/app.css */
[data-theme="light"] {
  --color-primary: oklch(0.51 0.21 264);        /* indigo #6366f1 */
  --color-primary-content: oklch(1 0 0);
  --color-secondary: oklch(0.44 0.18 264);       /* indigo închis */
  --color-secondary-content: oklch(1 0 0);
  --color-accent: oklch(0.63 0.19 294);          /* violet */
  --color-accent-content: oklch(1 0 0);
}

[data-theme="dark"] {
  --color-primary: oklch(0.67 0.19 264);
  --color-primary-content: oklch(0.13 0.02 264);
  --color-secondary: oklch(0.55 0.16 264);
  --color-secondary-content: oklch(0.13 0.02 264);
  --color-accent: oklch(0.72 0.17 294);
  --color-accent-content: oklch(0.13 0.02 264);
}
```

### 2. PageHeader — componentă reutilizabilă (crează acum)

**Path:** `packages/studio/src/lib/components/common/PageHeader.svelte`

```svelte
<script lang="ts">
  interface Props {
    title: string;
    subtitle?: string;
    count?: number | null;
  }
  let { title, subtitle, count } = $props<Props>();
</script>

<div class="flex items-start justify-between gap-4 mb-6">
  <div>
    <div class="flex items-center gap-2.5">
      <h1 class="text-xl font-semibold text-base-content">{title}</h1>
      {#if count !== undefined && count !== null}
        <span class="badge badge-ghost badge-sm font-mono">{count.toLocaleString()}</span>
      {/if}
    </div>
    {#if subtitle}
      <p class="text-sm text-base-content/50 mt-0.5">{subtitle}</p>
    {/if}
  </div>
  <slot />
</div>
```

**Utilizare:**
```svelte
<PageHeader title="Collections" subtitle="Manage your data models" count={collections.length}>
  <button class="btn btn-primary btn-sm gap-1.5" onclick={openCreate}>
    <Plus size={14} /> New Collection
  </button>
</PageHeader>
```

**Înlocuiește TOATE instanțele de:**
```svelte
<!-- VECHI — elimină -->
<div class="flex items-center justify-between">
  <div>
    <h1 class="text-2xl font-bold">Collections</h1>
    <p class="text-base-content/60 text-sm mt-1">...</p>
  </div>
  <button ...>
```

### 3. EmptyState — componentă reutilizabilă (crează acum)

**Path:** `packages/studio/src/lib/components/common/EmptyState.svelte`

```svelte
<script lang="ts">
  import type { Component } from 'svelte';
  interface Props {
    icon: Component;
    title: string;
    description: string;
    actionLabel?: string;
    actionHref?: string;
    onaction?: () => void;
  }
  let { icon: Icon, title, description, actionLabel, actionHref, onaction } = $props();
</script>

<div class="flex flex-col items-center justify-center py-20 text-center gap-4">
  <div class="p-5 rounded-2xl bg-base-200">
    <Icon size={36} class="text-base-content/20" />
  </div>
  <div class="max-w-xs">
    <h3 class="font-medium text-base-content">{title}</h3>
    <p class="text-sm text-base-content/50 mt-1.5 leading-relaxed">{description}</p>
  </div>
  {#if actionLabel}
    {#if actionHref}
      <a href={actionHref} class="btn btn-primary btn-sm gap-1.5">
        {actionLabel}
      </a>
    {:else if onaction}
      <button class="btn btn-primary btn-sm gap-1.5" onclick={onaction}>
        {actionLabel}
      </button>
    {/if}
  {/if}
</div>
```

### 4. SectionCard — componentă pentru grupuri de conținut

**Path:** `packages/studio/src/lib/components/common/SectionCard.svelte`

```svelte
<script lang="ts">
  interface Props { title?: string; padding?: boolean }
  let { title, padding = true } = $props<Props>();
</script>

<div class="border border-base-200 rounded-xl bg-base-100 overflow-hidden">
  {#if title}
    <div class="px-4 py-3 border-b border-base-200 flex items-center justify-between">
      <h2 class="text-sm font-medium text-base-content">{title}</h2>
      <slot name="action" />
    </div>
  {/if}
  <div class="{padding ? 'p-4' : ''}">
    <slot />
  </div>
</div>
```

---

## PAGINA 1 — LAYOUT (`+layout.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/+layout.svelte`

### Problema
Sidebar cu w-64 și 20+ items vizibile simultan. Prea aglomerat.

### Fix: sidebar compact cu secțiuni colapsabile

Modifică structura sidebar-ului:

```svelte
<!-- Sidebar header — logo mai vizibil -->
<div class="flex items-center h-14 px-3 border-b border-base-300 shrink-0 gap-2">
  {#if !collapsed}
    <a href="{base}/" class="flex items-center gap-2.5 flex-1 min-w-0">
      <!-- Logo gradient — mai distinctiv -->
      <div class="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center"
           style="background: linear-gradient(135deg, #6366f1, #8b5cf6);">
        <span class="text-white font-bold text-sm leading-none">Z</span>
      </div>
      <span class="font-semibold text-sm tracking-tight text-base-content">Zveltio</span>
    </a>
  {/if}
  <!-- ... collapse toggle ... -->
</div>

<!-- Nav items: font-size 12px în loc de 13px pentru mai mult spațiu -->
<a class="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium ...">
```

### Fix: group labels mai discrete

```svelte
<!-- VECHI -->
<span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30">

<!-- NOU — mai puțin agresiv -->
<span class="text-[9px] font-medium uppercase tracking-[.12em] text-base-content/25 select-none">
```

### Fix: footer — user info mai compact

```svelte
<!-- VECHI: user info cu avatar + text + sign out = 3 elemente -->
<!-- NOU: avatar cu tooltip + sign out inline -->
<div class="shrink-0 border-t border-base-300 px-2 py-2">
  <div class="flex items-center gap-2 px-2">
    <div class="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-semibold shrink-0"
         title="{auth.user?.name} · {auth.user?.email}">
      {auth.user?.name?.charAt(0).toUpperCase() || 'U'}
    </div>
    {#if !collapsed}
      <div class="flex-1 min-w-0">
        <p class="text-[11px] font-medium truncate">{auth.user?.name}</p>
        <p class="text-[10px] text-base-content/40 truncate">{auth.user?.email}</p>
      </div>
    {/if}
    <button onclick={signOut} class="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content" title="Sign out">
      <LogOut size={12} />
    </button>
  </div>
</div>
```

---

## PAGINA 2 — DASHBOARD (`+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/+page.svelte`

### Layout actual: stats (5 cards) + activity + collections + quick actions

### Layout propus: 2 coloane asimetrice

```svelte
<!-- STRUCTURA NOUĂ -->
<div class="space-y-5">
  <PageHeader title="Dashboard" subtitle="Welcome to Zveltio Studio" />

  <!-- Stats row: MAX 4 carduri, nu 5 -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <!-- colecții, records, api calls today, webhooks active -->
  </div>

  <!-- 2 coloane: 7/5 split -->
  <div class="grid lg:grid-cols-12 gap-4">

    <!-- Stânga (7/12): Activity + Collections -->
    <div class="lg:col-span-7 space-y-4">
      <!-- Recent Activity din audit log -->
      <SectionCard title="Recent Activity">
        <!-- tabel slim cu 10 entries -->
      </SectionCard>
      <!-- Collections overview -->
      <SectionCard title="Collections">
        <!-- tabel cu name + record count + last updated -->
      </SectionCard>
    </div>

    <!-- Dreapta (5/12): Quick Actions + System Status -->
    <div class="lg:col-span-5 space-y-4">
      <SectionCard title="Quick Actions">
        <div class="grid grid-cols-2 gap-2">
          <!-- 6 butoane principale -->
        </div>
      </SectionCard>
      <SectionCard title="System Status">
        <!-- DB, Cache, Storage status inline -->
      </SectionCard>
    </div>
  </div>
</div>
```

### Quick Actions — înlocuiește cu 6 acțiuni clare

```svelte
<div class="grid grid-cols-2 gap-2">
  <a href="{base}/collections" class="btn btn-outline btn-sm justify-start gap-2">
    <Database size={13} /> New Collection
  </a>
  <a href="{base}/users" class="btn btn-outline btn-sm justify-start gap-2">
    <UserPlus size={13} /> Invite User
  </a>
  <a href="{base}/api-keys" class="btn btn-outline btn-sm justify-start gap-2">
    <Key size={13} /> API Keys
  </a>
  <a href="{base}/flows" class="btn btn-outline btn-sm justify-start gap-2">
    <Workflow size={13} /> New Flow
  </a>
  <a href="{base}/zones" class="btn btn-outline btn-sm justify-start gap-2">
    <LayoutGrid size={13} /> Zones
  </a>
  <a href="{base}/ai" class="btn btn-outline btn-sm justify-start gap-2">
    <Bot size={13} /> AI Studio
  </a>
</div>
```

---

## PAGINA 3 — COLLECTIONS LIST (`collections/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/collections/+page.svelte`

### Fix 1: Header cu PageHeader

```svelte
<PageHeader title="Collections" subtitle="Define and manage your data models" count={collections.length}>
  <button class="btn btn-primary btn-sm gap-1.5" onclick={() => showCreateModal = true}>
    <Plus size={14} /> New Collection
  </button>
</PageHeader>
```

### Fix 2: Modalul de creare — adaugă template-uri

Înaintea câmpului de nume, adaugă un selector de template:

```svelte
<!-- Template picker -->
<div class="mb-5">
  <p class="text-sm font-medium mb-2">Start from</p>
  <div class="grid grid-cols-3 gap-2">
    {#each TEMPLATES as tmpl}
      <button
        class="border rounded-lg p-2.5 text-left transition-all text-sm
               {selectedTemplate === tmpl.id
                 ? 'border-primary bg-primary/5'
                 : 'border-base-300 hover:border-primary/40'}"
        onclick={() => applyTemplate(tmpl)}
      >
        <div class="font-medium text-xs">{tmpl.label}</div>
        <div class="text-base-content/40 text-[10px] mt-0.5">{tmpl.fields.length} fields</div>
      </button>
    {/each}
    <button
      class="border rounded-lg p-2.5 text-left border-base-300 hover:border-primary/40 text-sm"
      onclick={() => selectedTemplate = null}
    >
      <div class="font-medium text-xs">Blank</div>
      <div class="text-base-content/40 text-[10px] mt-0.5">Start empty</div>
    </button>
  </div>
</div>
```

Definește templatele:

```typescript
const TEMPLATES = [
  {
    id: 'blog',
    label: 'Blog Posts',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'content', type: 'richtext' },
      { name: 'slug', type: 'slug' },
      { name: 'status', type: 'enum', options: { values: ['draft', 'published', 'archived'] } },
      { name: 'published_at', type: 'datetime' },
    ],
  },
  {
    id: 'products',
    label: 'Products',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'price', type: 'number' },
      { name: 'description', type: 'richtext' },
      { name: 'status', type: 'enum', options: { values: ['active', 'draft', 'archived'] } },
      { name: 'image', type: 'file' },
    ],
  },
  {
    id: 'team',
    label: 'Team Members',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'email', type: 'email', required: true, unique: true },
      { name: 'role', type: 'text' },
      { name: 'department', type: 'enum', options: { values: ['engineering', 'design', 'marketing', 'sales'] } },
      { name: 'avatar', type: 'file' },
    ],
  },
  {
    id: 'orders',
    label: 'Orders',
    fields: [
      { name: 'order_number', type: 'text', required: true, unique: true },
      { name: 'customer_name', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'status', type: 'enum', options: { values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] } },
      { name: 'notes', type: 'textarea' },
    ],
  },
  {
    id: 'events',
    label: 'Events',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'description', type: 'richtext' },
      { name: 'start_date', type: 'datetime', required: true },
      { name: 'end_date', type: 'datetime' },
      { name: 'location', type: 'text' },
    ],
  },
];
```

### Fix 3: Type selector în modal — înlocuiește `<select>` cu grid vizual

```svelte
<!-- ÎNLOCUIEȘTE select-ul cu: -->
<div class="form-control mb-4">
  <label class="label"><span class="label-text">Field type</span></label>
  <div class="space-y-2">
    {#each TYPE_CATEGORIES as cat}
      <div>
        <p class="text-[10px] uppercase tracking-wide text-base-content/40 mb-1">{cat.label}</p>
        <div class="flex flex-wrap gap-1">
          {#each cat.types as t}
            <button
              type="button"
              class="badge cursor-pointer transition-all
                     {field.type === t.value
                       ? 'badge-primary'
                       : 'badge-ghost hover:badge-outline'}"
              onclick={() => field.type = t.value}
            >
              {t.label}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>
```

### Fix 4: EmptyState consistent

```svelte
<EmptyState
  icon={Database}
  title="No collections yet"
  description="Collections are database tables. Create one to start storing and managing data."
  actionLabel="Create your first collection"
  onaction={() => showCreateModal = true}
/>
```

---

## PAGINA 4 — COLLECTION DETAIL (`collections/[name]/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/collections/[name]/+page.svelte`

### Fix 1: Header cu breadcrumb + acțiuni

```svelte
<Breadcrumb crumbs={[
  { label: 'Collections', href: `${base}/collections` },
  { label: collection?.display_name || collectionName },
]} />

<div class="flex items-center gap-3 mb-4">
  <h1 class="text-xl font-semibold">{collection?.display_name || collectionName}</h1>
  <span class="badge badge-ghost text-xs font-mono">{collectionName}</span>
  <div class="ml-auto flex gap-2">
    <a href="{base}/collections/{collectionName}/fields" class="btn btn-ghost btn-sm gap-1.5">
      <Settings size={13} /> Schema
    </a>
    <button class="btn btn-primary btn-sm gap-1.5" onclick={() => showInsertModal = true}>
      <Plus size={14} /> Add Record
    </button>
  </div>
</div>
```

### Fix 2: Tab-uri mai vizibile

```svelte
<!-- Tabs cu border-bottom în loc de box -->
<div class="border-b border-base-200 mb-4">
  <div class="flex gap-0">
    {#each ['data', 'schema', 'ai', 'code', 'views'] as tab}
      <button
        class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
               {activeTab === tab
                 ? 'border-primary text-primary'
                 : 'border-transparent text-base-content/50 hover:text-base-content'}"
        onclick={() => activeTab = tab}
      >
        {tab.charAt(0).toUpperCase() + tab.slice(1)}
      </button>
    {/each}
  </div>
</div>
```

### Fix 3: Inline add row în tabel (tab Data)

Adaugă la finalul tabelului un rând editabil direct:

```svelte
<!-- Ultimul rând în tbody: -->
<tr class="bg-primary/2 hover:bg-primary/5 transition-colors">
  <td class="px-3 py-2">
    <span class="text-primary/60 font-medium text-sm">+</span>
  </td>
  {#each getFields().filter(f => !f.is_system && f.type !== 'computed') as field}
    <td class="px-3 py-1.5">
      {#if ['text', 'textarea', 'email', 'url', 'number'].includes(field.type)}
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          class="input input-xs w-full bg-transparent border-base-300"
          placeholder={field.label || field.name}
          bind:value={inlineNewRow[field.name]}
        />
      {:else if field.type === 'enum'}
        <select class="select select-xs w-full bg-transparent" bind:value={inlineNewRow[field.name]}>
          <option value="">—</option>
          {#each field.options?.values || [] as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
      {:else}
        <span class="text-xs text-base-content/30 italic">use modal</span>
      {/if}
    </td>
  {/each}
  <td class="px-3 py-1.5 text-right">
    <button class="btn btn-primary btn-xs" onclick={saveInlineRow}>Save</button>
  </td>
</tr>
```

---

## PAGINA 5 — FIELDS (`collections/[name]/fields/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/collections/[name]/fields/+page.svelte`

### Starea actuală: OK — breadcrumbs exist, type grid există

### Fix 1: Câmpurile existente — add drag reorder

Adaugă `draggable` pe fiecare rând și handler de drop pentru reordonare.

### Fix 2: Schema preview lateral

Adaugă un panou lateral care arată schema curentă ca JSON sau ca tabel:

```svelte
<div class="grid lg:grid-cols-3 gap-4">
  <!-- Stânga: lista câmpurilor + add form (2/3) -->
  <div class="lg:col-span-2 space-y-4">
    <!-- câmpuri existente -->
    <!-- formular add -->
  </div>
  <!-- Dreapta: schema preview (1/3) -->
  <div class="lg:col-span-1">
    <SectionCard title="Schema Preview" padding={false}>
      <div class="p-3 font-mono text-xs text-base-content/60 overflow-auto max-h-96">
        <pre>{JSON.stringify(getFields().map(f => ({ name: f.name, type: f.type, required: f.required })), null, 2)}</pre>
      </div>
    </SectionCard>
  </div>
</div>
```

---

## PAGINA 6 — USERS (`users/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/users/+page.svelte`

### Fix: Tabel în loc de cards

Users trebuie să fie un tabel scanabil, nu cards. Adaugă:
- Avatar cu inițiale colorate
- Rol cu badge colorat (god=red, admin=orange, member=blue)
- Last active timestamp
- Acțiuni inline (Edit, Suspend, Delete)

```svelte
<table class="table table-sm w-full">
  <thead>
    <tr>
      <th>User</th>
      <th>Role</th>
      <th>Joined</th>
      <th>Last active</th>
      <th class="text-right">Actions</th>
    </tr>
  </thead>
  <tbody>
    {#each users as user}
      <tr class="hover">
        <td>
          <div class="flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
              {user.name?.charAt(0)?.toUpperCase() ?? '?'}
            </div>
            <div>
              <div class="text-sm font-medium">{user.name}</div>
              <div class="text-xs text-base-content/40">{user.email}</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge badge-sm {ROLE_BADGES[user.role] ?? 'badge-ghost'}">
            {user.role}
          </span>
        </td>
        <td class="text-xs text-base-content/50">{formatDate(user.createdAt)}</td>
        <td class="text-xs text-base-content/50">{formatRelative(user.updatedAt)}</td>
        <td class="text-right">
          <button class="btn btn-ghost btn-xs" onclick={() => openEdit(user)}>Edit</button>
          <button class="btn btn-ghost btn-xs text-error" onclick={() => confirmDelete(user)}>Delete</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
```

---

## PAGINA 7 — PERMISSIONS (`permissions/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/permissions/+page.svelte`

### Problema: Matrix cu checkbox-uri — vizual confuz la multe colecții

### Fix: Freeze header + sticky col

```svelte
<!-- Wrap tabelul în container cu overflow și sticky headers -->
<div class="overflow-auto max-h-[calc(100vh-200px)] border border-base-200 rounded-xl">
  <table class="table table-xs w-full">
    <thead class="sticky top-0 z-10 bg-base-100 shadow-sm">
      <tr>
        <th class="sticky left-0 bg-base-100 z-20 min-w-32">Role / Collection</th>
        {#each collections as col}
          <th class="text-center min-w-24 font-mono text-[10px]">{col.name}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each roles as role}
        <tr>
          <td class="sticky left-0 bg-base-100 font-medium text-sm">{role.name}</td>
          {#each collections as col}
            <td class="text-center">
              <!-- Mini checkbox cluster -->
              <div class="flex gap-0.5 justify-center">
                {#each ACTIONS as action}
                  <input type="checkbox"
                    class="checkbox checkbox-xs {ACTION_CLASSES[action]}"
                    checked={has(role.id, col.name, action)}
                    onchange={() => toggle(role.id, col.name, action)}
                    title="{action}"
                  />
                {/each}
              </div>
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<!-- Legend -->
<div class="flex gap-3 mt-2 text-xs text-base-content/50">
  <span class="flex items-center gap-1"><span class="w-3 h-3 bg-info rounded-sm"></span> view</span>
  <span class="flex items-center gap-1"><span class="w-3 h-3 bg-success rounded-sm"></span> create</span>
  <span class="flex items-center gap-1"><span class="w-3 h-3 bg-warning rounded-sm"></span> update</span>
  <span class="flex items-center gap-1"><span class="w-3 h-3 bg-error rounded-sm"></span> delete</span>
</div>
```

---

## PAGINA 8 — WEBHOOKS (`webhooks/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/webhooks/+page.svelte`

### Starea actuală: Cards cu info — OK dar needitat inline

### Fix: Tabel în loc de cards — mai scanabil

```svelte
<table class="table table-sm w-full">
  <thead>
    <tr>
      <th>Name</th>
      <th>URL</th>
      <th>Events</th>
      <th>Status</th>
      <th class="text-right">Actions</th>
    </tr>
  </thead>
  <tbody>
    {#each webhooks as wh}
      <tr class="hover group">
        <td class="font-medium">{wh.name}</td>
        <td class="font-mono text-xs text-base-content/50 max-w-48 truncate">{wh.url}</td>
        <td>
          <div class="flex flex-wrap gap-1">
            {#each (wh.events || []).slice(0, 3) as ev}
              <span class="badge badge-ghost badge-xs">{ev}</span>
            {/each}
            {#if wh.events?.length > 3}
              <span class="badge badge-ghost badge-xs">+{wh.events.length - 3}</span>
            {/if}
          </div>
        </td>
        <td>
          <span class="badge badge-sm {wh.active ? 'badge-success' : 'badge-ghost'}">
            {wh.active ? 'active' : 'paused'}
          </span>
        </td>
        <td class="text-right">
          <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" onclick={() => testWebhook(wh.id)}>
            Test
          </button>
          <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" onclick={() => openEdit(wh)}>Edit</button>
          <button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" onclick={() => remove(wh.id, wh.name)}>Del</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
```

---

## PAGINA 9 — FLOWS (`flows/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/flows/+page.svelte`

### Fix: Header cu stats rapide

```svelte
<PageHeader title="Flows" subtitle="Automation workflows triggered by events or schedule" count={flows.length}>
  <div class="flex items-center gap-2">
    <span class="text-xs text-base-content/40">{flows.filter(f => f.is_active).length} active</span>
    <button class="btn btn-primary btn-sm gap-1.5" onclick={openCreate}>
      <Plus size={14} /> New Flow
    </button>
  </div>
</PageHeader>
```

### Fix: Cards cu last run status vizibil

Adaugă pe fiecare card:
- Indicator colorat (verde = ultima rulare OK, roșu = eșec, gri = niciodată)
- `last_run_at` formatat relativ
- Buton "Run now" vizibil la hover

---

## PAGINA 10 — AI HUB (`ai/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/ai/+page.svelte`

### Problema: Tab-uri în sidebar ca `btn btn-xs` cu overflow-x — arată slab

### Fix: Tab-uri cu icoane în sidebar, nu butoane

```svelte
<!-- Înlocuiește butoanele cu nav items -->
<nav class="p-2 space-y-0.5">
  {#each AI_TABS as tab}
    <button
      class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12px] font-medium transition-colors
             {activeTab === tab.id
               ? 'bg-primary/10 text-primary'
               : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}"
      onclick={() => activeTab = tab.id}
    >
      <tab.icon size={14} class="shrink-0" />
      {tab.label}
    </button>
  {/each}
</nav>
```

### Fix: Main area — când nu e chat activ, arată un welcome screen mai util

```svelte
{#if !activeChat && activeTab === 'chat'}
  <div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
    <div class="p-4 rounded-2xl bg-primary/5">
      <Bot size={32} class="text-primary" />
    </div>
    <div class="text-center max-w-sm">
      <h2 class="font-semibold text-lg">AI Studio</h2>
      <p class="text-sm text-base-content/50 mt-1">
        Chat with your data, generate schemas, run SQL queries, and search semantically.
      </p>
    </div>
    <!-- Suggested prompts -->
    <div class="grid grid-cols-2 gap-2 w-full max-w-md">
      {#each SUGGESTED_PROMPTS as prompt}
        <button
          class="text-left p-3 rounded-lg border border-base-300 text-xs text-base-content/60 hover:border-primary/40 hover:text-base-content transition-all"
          onclick={() => { newChat(); setTimeout(() => input = prompt, 100); }}
        >
          {prompt}
        </button>
      {/each}
    </div>
    {#if providers.length === 0}
      <div class="alert alert-warning text-sm py-2 max-w-sm">
        No AI provider configured.
        <button class="underline ml-1" onclick={() => activeTab = 'settings'}>Add one →</button>
      </div>
    {/if}
  </div>
{/if}
```

---

## PAGINA 11 — STORAGE (`storage/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/storage/+page.svelte`

### Starea actuală: drag-drop upload + grid/list view — OK

### Fix 1: Drop zone mai vizibilă

```svelte
<!-- Drop zone inline, nu ascunsă -->
<div
  class="border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer
         {dragging ? 'border-primary bg-primary/5' : 'border-base-300 hover:border-primary/40'}"
  ondragover|preventDefault={() => dragging = true}
  ondragleave={() => dragging = false}
  ondrop|preventDefault={handleDrop}
  onclick={() => fileInput.click()}
>
  {#if uploading}
    <span class="loading loading-spinner loading-md text-primary"></span>
    <p class="text-sm mt-2">Uploading...</p>
  {:else}
    <Upload size={24} class="mx-auto text-base-content/30 mb-2" />
    <p class="text-sm text-base-content/50">Drop files here or <span class="text-primary">browse</span></p>
    <p class="text-xs text-base-content/30 mt-1">Max 50MB per file</p>
  {/if}
</div>
```

### Fix 2: Grid de fișiere cu selecție multiplă vizibilă

La hover pe un fișier, afișează checkbox pentru selecție multiplă (bulk delete/copy).

---

## PAGINA 12 — MEDIA (`media/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/media/+page.svelte`

### Starea actuală: 3-panel layout (folders + files + details) — bun arhitectural

### Fix: Stats bar deasupra grid-ului

```svelte
<!-- Deasupra filtrelor, arată storage usage -->
{#if stats}
  <div class="flex items-center gap-4 text-xs text-base-content/50 mb-3">
    <span>{stats.total_files} files</span>
    <span>{formatBytes(stats.total_size)}</span>
    <div class="flex-1 h-1.5 bg-base-200 rounded-full overflow-hidden max-w-32">
      <div class="h-full bg-primary rounded-full" style="width: {Math.min(stats.usage_percent, 100)}%"></div>
    </div>
    <span>{stats.usage_percent?.toFixed(1)}% used</span>
  </div>
{/if}
```

---

## PAGINA 13 — ZONES (`zones/+page.svelte` și `zones/[slug]/+page.svelte`)

**Fișiere:** Nou din Bloc 1

### Design de la zero — respectă pattern-ul

```svelte
<!-- zones/+page.svelte -->
<PageHeader title="Zones" subtitle="Configure portals and access areas">
  <button class="btn btn-primary btn-sm gap-1.5" onclick={openCreate}>
    <Plus size={14} /> New Zone
  </button>
</PageHeader>

<!-- Grid de zone — nu tabel, zone sunt "produse" -->
<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
  {#each zones as zone}
    <a href="{base}/zones/{zone.slug}"
       class="group card bg-base-100 border border-base-200 hover:border-primary/30 transition-all hover:shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-start justify-between">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm">{zone.name}</span>
              {#if zone.is_active}
                <span class="badge badge-success badge-xs">live</span>
              {:else}
                <span class="badge badge-ghost badge-xs">draft</span>
              {/if}
            </div>
            <p class="text-xs text-base-content/40 font-mono mt-0.5">{zone.base_path}</p>
          </div>
          <div class="w-8 h-8 rounded-lg flex items-center justify-center"
               style="background-color: {zone.primary_color ?? '#6366f1'}20">
            <span style="color: {zone.primary_color ?? '#6366f1'}" class="text-sm font-bold">
              {zone.name[0]}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-2 text-xs text-base-content/40">
          <span>{zone._page_count ?? 0} pages</span>
          {#if zone.access_roles?.length}
            <span>·</span>
            <span>{zone.access_roles.join(', ')}</span>
          {/if}
        </div>
      </div>
    </a>
  {/each}
</div>

<EmptyState
  icon={LayoutGrid}
  title="No zones configured"
  description="Zones are portals — Client Portal, Intranet — each with their own pages, branding, and access rules."
  actionLabel="Create first zone"
  onaction={openCreate}
/>
```

### zones/[slug]/+page.svelte — tab layout cu 3 secțiuni

```svelte
<Breadcrumb crumbs={[
  { label: 'Zones', href: `${base}/zones` },
  { label: zone?.name ?? zoneSlug },
]} />

<!-- Tab-uri: Pages | Access | Branding -->
<div class="border-b border-base-200 mb-5">
  <div class="flex gap-0">
    {#each ['pages', 'access', 'branding'] as tab}
      <button
        class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize
               {activeTab === tab ? 'border-primary text-primary' : 'border-transparent text-base-content/50 hover:text-base-content'}"
        onclick={() => activeTab = tab}
      >{tab}</button>
    {/each}
  </div>
</div>
```

---

## PAGINA 14 — VIEWS (`views/+page.svelte`)

**Fișier:** Nou din Bloc 1

### Design cu preview vizual al tipului

```svelte
<PageHeader title="Views" subtitle="Reusable data display blocks for your zones">
  <button class="btn btn-primary btn-sm gap-1.5" onclick={openCreate}>
    <Plus size={14} /> New View
  </button>
</PageHeader>

<!-- Grid: view cards cu tip icon -->
<div class="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
  {#each filtered as view}
    <div class="card bg-base-100 border border-base-200 hover:border-primary/30 transition-all group">
      <div class="card-body p-4 gap-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <!-- Icon per tip: table, kanban, calendar, etc. -->
            <div class="p-1.5 rounded-lg bg-primary/8">
              <svelte:component this={VIEW_TYPE_ICONS[view.view_type]} size={14} class="text-primary" />
            </div>
            <span class="font-medium text-sm truncate">{view.name}</span>
          </div>
          <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
            <button class="btn btn-ghost btn-xs" onclick={() => openEdit(view)}>Edit</button>
          </div>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-base-content/40">
          <span class="font-mono">{view.collection}</span>
          <span>·</span>
          <span class="capitalize">{view.view_type}</span>
          {#if view.is_public}
            <span class="badge badge-outline badge-xs ml-auto">public</span>
          {/if}
        </div>
      </div>
    </div>
  {/each}
</div>
```

---

## PAGINA 15 — SETTINGS (`settings/+page.svelte`)

**Fișier:** `packages/studio/src/routes/(admin)/settings/+page.svelte`

### Fix: Layout cu nav lateral + content area

```svelte
<div class="flex gap-6">
  <!-- Nav lateral -->
  <nav class="w-44 shrink-0">
    <div class="space-y-0.5">
      {#each SETTINGS_SECTIONS as section}
        <button
          class="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors
                 {activeSection === section.id
                   ? 'bg-primary/10 text-primary font-medium'
                   : 'text-base-content/60 hover:bg-base-200'}"
          onclick={() => activeSection = section.id}
        >
          {section.label}
        </button>
      {/each}
    </div>
  </nav>

  <!-- Content -->
  <div class="flex-1 min-w-0 space-y-4">
    <!-- Fiecare secție ca un SectionCard -->
  </div>
</div>
```

---

## COMPONENTE GLOBALE DE REMEDIAT

### A. Înlocuiește `<LoaderCircle class="animate-spin">` cu `<LoadingSkeleton>`

Peste TOT în Studio, înlocuiește:
```svelte
<!-- VECHI -->
{#if loading}
  <div class="flex justify-center py-16">
    <LoaderCircle size={32} class="animate-spin text-primary" />
  </div>
```

Cu:
```svelte
<!-- NOU -->
{#if loading}
  <LoadingSkeleton type="table" rows={5} />
```

### B. Inline error messages — înlocuiește cu toast

Oriunde există `let error = $state('')` + `<div class="alert alert-error">{error}</div>`, înlocuiește cu:
```typescript
import { toast } from '$lib/stores/toast.svelte.js';
// ...
} catch (e: any) {
  toast.error(e.message ?? 'Something went wrong');
}
```

### C. Toate paginile — adaugă `<PageHeader>`

Standardizează TOATE paginile cu `PageHeader`. Elimină toate instanțele de `text-2xl font-bold` folosite ca titlu de pagină.

### D. Paginile nested — adaugă `<Breadcrumb>`

Adaugă `Breadcrumb` pe TOATE paginile care au un context parent:
- `collections/[name]/+page.svelte`
- `collections/[name]/fields/+page.svelte`
- `collections/[name]/relations/+page.svelte`
- `zones/[slug]/+page.svelte`
- Orice altă pagină cu `[param]` în path

---

## ORDINE DE IMPLEMENTARE

```
Sprint 1 — Fundații (blochează tot restul):
  1. Crează PageHeader, EmptyState, SectionCard în $lib/components/common/
  2. Schimbă paleta de culori în app.css
  3. Aplică PageHeader pe TOATE paginile (find/replace pattern)

Sprint 2 — Paginile cu trafic mare:
  4. Collections list — template-uri + type picker
  5. Collection detail — inline add row + tabs styling
  6. Users — tabel nou
  7. Webhooks — tabel nou

Sprint 3 — Paginile noi (Bloc 1):
  8. Zones page
  9. Views page
  10. Zones/[slug] cu tab-uri

Sprint 4 — Polish:
  11. AI Hub — tab nav + welcome screen
  12. Permissions — sticky headers
  13. Storage/Media — drop zone + stats bar
  14. Dashboard — layout 2 coloane
```

---

## CONVENȚII DE COD PENTRU PAGINI NOI

1. **Header** → `<PageHeader title="..." subtitle="..." count={...}>`
2. **Loading** → `<LoadingSkeleton>` nu `<LoaderCircle>`
3. **Empty** → `<EmptyState icon={...} title="..." description="..." />`
4. **Erori** → `toast.error(...)` nu `error = e.message`
5. **Confirmare** → `<ConfirmModal>` nu `confirm()`
6. **Carduri** → `<SectionCard>` pentru grupuri de conținut
7. **Nav în pagini nested** → `<Breadcrumb crumbs={[...]}/>`
8. **Tipuri de câmpuri** → grid cu categorii, nu `<select>`
9. **Acțiuni la hover** → `opacity-0 group-hover:opacity-100 transition-opacity`
10. **Tabel scanabil** → `table table-sm` cu `hover` pe rânduri
