<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { ClipboardList, Filter } from '@lucide/svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import Pagination from '$lib/components/common/Pagination.svelte';
import PageSpinner from '$lib/components/common/PageSpinner.svelte';
import { api } from '$lib/api.js';
// The shared formatter, which honours the instance's locale, timezone and
// date_format. `toLocaleString()` used the browser's, so the audit log was the
// one screen that disagreed with every other timestamp in the Studio.
import { fmtDateTime } from '$lib/stores/format.svelte.js';

interface Revision {
  id: string;
  collection: string;
  record_id: string | null;
  operation: string;
  user_id: string | null;
  created_at: string;
  before_data: unknown;
  after_data: unknown;
}

let revisions = $state<Revision[]>([]);
let loadError = $state('');
let loading = $state(true);
let page = $state(1);
let total = $state(0);
const limit = 25;

let filterCollection = $state('');
let filterUserId = $state('');
let filterOp = $state('');

let filterType = $state('');
let filterUser = $state('');
let filterFrom = $state('');

onMount(() => load());

async function load() {
  loading = true;
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  if (filterCollection) params.set('collection', filterCollection);
  if (filterUserId) params.set('user_id', filterUserId);
  if (filterType) params.set('event_type', filterType);
  if (filterUser) params.set('user', encodeURIComponent(filterUser));
  if (filterFrom) params.set('from', filterFrom);

  try {
    // Typed helper, not `api.fetch(...).then(r => r.json())`: that shape never
    // looked at the status, so a refusal parsed into an empty list and this
    // screen — the audit log — reported that nothing had happened. A rejected
    // fetch was worse: no catch and no finally left the spinner up for good.
    const res = await api.get<{ revisions: Revision[]; total?: number }>(
      `/api/admin/revisions?${params}`,
    );
    const rows = res.revisions ?? [];
    // The operation filter runs client-side, over one page. Counting the
    // filtered rows as the page size then fed a guessed total into the pager,
    // which put the page count somewhere between wrong and absurd. The total is
    // the server's, over the unfiltered set, and the filter says what it is.
    total = res.total ?? (page - 1) * limit + rows.length;
    revisions = rows.filter((r) => !filterOp || r.operation === filterOp);
    loadError = '';
  } catch (err) {
    revisions = [];
    total = 0;
    loadError = err instanceof Error ? err.message : m['common.loadFailed']();
  } finally {
    loading = false;
  }
}

function applyFilters() {
  page = 1;
  load();
}

function opBadge(op: string): string {
  const map: Record<string, string> = {
    insert: 'badge-success',
    update: 'badge-info',
    delete: 'badge-error',
  };
  return map[op] || 'badge-ghost';
}

function formatDiff(before: unknown, after: unknown): string[] {
  if (!before && after) return [m['audit.rowCreated']()];
  if (before && !after) return [m['audit.rowDeleted']()];
  const changes: string[] = [];
  const b = (typeof before === 'string' ? JSON.parse(before) : before) as Record<string, unknown>;
  const a = (typeof after === 'string' ? JSON.parse(after) : after) as Record<string, unknown>;
  for (const key of Object.keys({ ...b, ...a })) {
    if (JSON.stringify(b?.[key]) !== JSON.stringify(a?.[key])) {
      changes.push(key);
    }
  }
  return changes.length ? changes : [m['audit.noChangesDetected']()];
}

let expandedId = $state<string | null>(null);
</script>

<div class="space-y-6">
 <PageHeader title={m['nav.auditLog']()} subtitle={m['audit.subtitle']()} />

 <!-- Filters -->
 <div class="card bg-base-100">
 <div class="card-body p-4">
 <div class="flex flex-wrap gap-3">
 <div class="form-control">
 <div class="label py-0"><span class="label-text text-xs">{m['common.col.collection']()}</span></div>
 <input
 type="text"
 bind:value={filterCollection}
 placeholder={m['audit.collectionPlaceholder']()}
 class="input input-sm w-40"
 />
 </div>
 <div class="form-control">
 <div class="label py-0"><span class="label-text text-xs">{m['audit.userId']()}</span></div>
 <input
 type="text"
 bind:value={filterUserId}
 placeholder={m['audit.userId']()}
 class="input input-sm w-48"
 />
 </div>
 <div class="form-control">
 <div class="label py-0"><span class="label-text text-xs">{m['audit.operation']()}</span></div>
 <select bind:value={filterOp} class="select select-sm">
 <option value="">{m['common.filter.all']()}</option>
 <option value="insert">{m['common.op.insert']()}</option>
 <option value="update">{m['common.op.update']()}</option>
 <option value="delete">{m['common.op.delete']()}</option>
 </select>
 </div>
 <div class="flex items-end">
 <button class="btn btn-sm btn-primary gap-2" onclick={applyFilters}>
 <Filter size={14} />{m['rlog.apply']()}
 </button>
 </div>
 </div>
 </div>
 </div>

 <div class="flex gap-2 mb-4 flex-wrap">
  <select class="select select-sm" bind:value={filterType} onchange={load}>
    <option value="">{m['audit.allEvents']()}</option>
    <option value="auth">{m['common.filter.auth']()}</option>
    <option value="data">{m['common.filter.data']()}</option>
    <option value="admin">{m['common.filter.admin']()}</option>
    <option value="api_key">{m['nav.apiKeys']()}</option>
  </select>
  <input type="text" class="input input-sm max-w-40" placeholder={m['audit.filterByUser']()} bind:value={filterUser} onblur={load} />
  <input type="date" class="input input-sm" bind:value={filterFrom} onchange={load} />
  {#if filterType || filterUser || filterFrom}
    <button class="btn btn-ghost btn-sm" onclick={() => { filterType = ''; filterUser = ''; filterFrom = ''; load(); }}>{m['common.clear']()}</button>
  {/if}
 </div>

 {#if loading}
 <PageSpinner />
 {:else if loadError}
 <div class="alert alert-error">
 <span>{loadError}</span>
 <button class="btn btn-sm btn-ghost" onclick={load}>{m['common.retry']()}</button>
 </div>
 {:else if revisions.length === 0}
 <div class="card bg-base-100 text-center py-16">
 <ClipboardList size={40} class="mx-auto text-base-content/55 mb-3" />
 <p class="text-base-content/65">{m['audit.noEntries']()}</p>
 </div>
 {:else}
 <div class="card bg-base-100">
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>{m['common.col.time']()}</th>
 <th>{m['common.col.collection']()}</th>
 <th>{m['audit.recordId']()}</th>
 <th>{m['audit.operation']()}</th>
 <th>{m['audit.changedFields']()}</th>
 <th>{m['common.col.user']()}</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each revisions as rev}
 <tr
 class="cursor-pointer hover"
 role="button"
 tabindex="0"
 onclick={() => (expandedId = expandedId === rev.id ? null : rev.id)}
 onkeydown={(e) => e.key === 'Enter' || e.key === ' ' ? (expandedId = expandedId === rev.id ? null : rev.id) : null}
>
 <td class="text-xs font-mono whitespace-nowrap">
 {fmtDateTime(rev.created_at)}
 </td>
 <td><code class="text-xs">{rev.collection}</code></td>
 <td><code class="text-xs text-base-content/65">{rev.record_id?.substring(0, 8)}…</code></td>
 <td>
 <span class="badge badge-sm {opBadge(rev.operation)}">{rev.operation}</span>
 </td>
 <td class="text-xs text-base-content/70">
 {formatDiff(rev.before_data, rev.after_data).join(', ')}
 </td>
 <td class="text-xs text-base-content/65 font-mono">{rev.user_id ? `${rev.user_id.substring(0, 8)}…` : m['audit.systemActor']()}</td>
 <td class="text-xs text-base-content/65">{expandedId === rev.id ? '▲' : '▼'}</td>
 </tr>
 {#if expandedId === rev.id}
 <tr class="bg-base-300">
 <td colspan="7" class="p-4">
 <div class="grid grid-cols-2 gap-4">
 {#if rev.before_data}
 <div>
 <p class="text-xs font-semibold mb-1 text-base-content/65">{m['audit.before']()}</p>
 <pre class="text-xs bg-base-200 p-2 rounded overflow-auto max-h-48">{JSON.stringify(
 typeof rev.before_data === 'string' ? JSON.parse(rev.before_data) : rev.before_data,
 null, 2,
 )}</pre>
 </div>
 {/if}
 {#if rev.after_data}
 <div>
 <p class="text-xs font-semibold mb-1 text-base-content/65">{m['audit.after']()}</p>
 <pre class="text-xs bg-base-200 p-2 rounded overflow-auto max-h-48">{JSON.stringify(
 typeof rev.after_data === 'string' ? JSON.parse(rev.after_data) : rev.after_data,
 null, 2,
 )}</pre>
 </div>
 {/if}
 </div>
 </td>
 </tr>
 {/if}
 {/each}
 </tbody>
 </table>
 </div>
 </div>

 <Pagination {total} {page} {limit} onchange={(p) => { page = p; load(); }} />
 {/if}
</div>
