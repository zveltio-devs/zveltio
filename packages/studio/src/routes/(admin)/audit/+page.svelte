<script lang="ts">
 import { onMount } from 'svelte';
 import { ClipboardList, Filter } from '@lucide/svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';
 import Pagination from '$lib/components/common/Pagination.svelte';

 const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || '';

 let revisions = $state<any[]>([]);
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

 const res = await fetch(`${engineUrl}/api/admin/revisions?${params}`, { credentials: 'include' }).then((r) => r.json());
 revisions = (res.revisions || []).filter((r: any) => !filterOp || r.operation === filterOp);
 total = res.total ?? (revisions.length < limit ? (page - 1) * limit + revisions.length : page * limit + 1);
 loading = false;
 }

 function applyFilters() {
 page = 1;
 load();
 }

 function opBadge(op: string): string {
 const map: Record<string, string> = { insert: 'badge-success', update: 'badge-info', delete: 'badge-error' };
 return map[op] || 'badge-ghost';
 }

 function formatDiff(before: any, after: any): string[] {
 if (!before && after) return ['Created'];
 if (before && !after) return ['Deleted'];
 const changes: string[] = [];
 const b = typeof before === 'string' ? JSON.parse(before) : before;
 const a = typeof after === 'string' ? JSON.parse(after) : after;
 for (const key of Object.keys({ ...b, ...a })) {
 if (JSON.stringify(b?.[key]) !== JSON.stringify(a?.[key])) {
 changes.push(key);
 }
 }
 return changes.length ? changes : ['No changes detected'];
 }

 let expandedId = $state<string | null>(null);
</script>

<div class="space-y-6">
 <PageHeader title="Audit Log" subtitle="Track all system events" />

 <!-- Filters -->
 <div class="card bg-base-200">
 <div class="card-body p-4">
 <div class="flex flex-wrap gap-3">
 <div class="form-control">
 <div class="label py-0"><span class="label-text text-xs">Collection</span></div>
 <input
 type="text"
 bind:value={filterCollection}
 placeholder="e.g. orders"
 class="input input-sm w-40"
 />
 </div>
 <div class="form-control">
 <div class="label py-0"><span class="label-text text-xs">User ID</span></div>
 <input
 type="text"
 bind:value={filterUserId}
 placeholder="User ID"
 class="input input-sm w-48"
 />
 </div>
 <div class="form-control">
 <div class="label py-0"><span class="label-text text-xs">Operation</span></div>
 <select bind:value={filterOp} class="select select-sm">
 <option value="">All</option>
 <option value="insert">Insert</option>
 <option value="update">Update</option>
 <option value="delete">Delete</option>
 </select>
 </div>
 <div class="flex items-end">
 <button class="btn btn-sm btn-primary gap-2" onclick={applyFilters}>
 <Filter size={14} />Apply
 </button>
 </div>
 </div>
 </div>
 </div>

 <div class="flex gap-2 mb-4 flex-wrap">
  <select class="select select-sm" bind:value={filterType} onchange={load}>
    <option value="">All events</option>
    <option value="auth">Auth</option>
    <option value="data">Data</option>
    <option value="admin">Admin</option>
    <option value="api_key">API Keys</option>
  </select>
  <input type="text" class="input input-sm max-w-40" placeholder="Filter by user..." bind:value={filterUser} onblur={load} />
  <input type="date" class="input input-sm" bind:value={filterFrom} onchange={load} />
  {#if filterType || filterUser || filterFrom}
    <button class="btn btn-ghost btn-sm" onclick={() => { filterType = ''; filterUser = ''; filterFrom = ''; load(); }}>Clear</button>
  {/if}
 </div>

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if revisions.length === 0}
 <div class="card bg-base-200 text-center py-16">
 <ClipboardList size={40} class="mx-auto text-base-content/30 mb-3" />
 <p class="text-base-content/60">No audit entries found</p>
 </div>
 {:else}
 <div class="card bg-base-200">
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>Time</th>
 <th>Collection</th>
 <th>Record ID</th>
 <th>Operation</th>
 <th>Changed Fields</th>
 <th>User</th>
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
 {new Date(rev.created_at).toLocaleString()}
 </td>
 <td><code class="text-xs">{rev.collection}</code></td>
 <td><code class="text-xs text-base-content/60">{rev.record_id?.substring(0, 8)}…</code></td>
 <td>
 <span class="badge badge-sm {opBadge(rev.operation)}">{rev.operation}</span>
 </td>
 <td class="text-xs text-base-content/70">
 {formatDiff(rev.before_data, rev.after_data).join(', ')}
 </td>
 <td class="text-xs text-base-content/60 font-mono">{rev.user_id?.substring(0, 8) || 'system'}…</td>
 <td class="text-xs text-base-content/40">{expandedId === rev.id ? '▲' : '▼'}</td>
 </tr>
 {#if expandedId === rev.id}
 <tr class="bg-base-300">
 <td colspan="7" class="p-4">
 <div class="grid grid-cols-2 gap-4">
 {#if rev.before_data}
 <div>
 <p class="text-xs font-semibold mb-1 text-base-content/60">Before</p>
 <pre class="text-xs bg-base-200 p-2 rounded overflow-auto max-h-48">{JSON.stringify(
 typeof rev.before_data === 'string' ? JSON.parse(rev.before_data) : rev.before_data,
 null, 2,
 )}</pre>
 </div>
 {/if}
 {#if rev.after_data}
 <div>
 <p class="text-xs font-semibold mb-1 text-base-content/60">After</p>
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
