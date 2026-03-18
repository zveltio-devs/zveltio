<script lang="ts">
 import { onMount } from 'svelte';
 import { ClipboardList, Filter, ChevronLeft, ChevronRight } from '@lucide/svelte';

 const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || '';

 let revisions = $state<any[]>([]);
 let loading = $state(true);
 let page = $state(1);
 const limit = 25;

 let filterCollection = $state('');
 let filterUserId = $state('');
 let filterOp = $state('');

 onMount(() => load());

 async function load() {
 loading = true;
 const params = new URLSearchParams({ limit: String(limit), page: String(page) });
 if (filterCollection) params.set('collection', filterCollection);
 if (filterUserId) params.set('user_id', filterUserId);

 const res = await fetch(`${engineUrl}/api/admin/revisions?${params}`, { credentials: 'include' }).then((r) => r.json());
 revisions = (res.revisions || []).filter((r: any) => !filterOp || r.operation === filterOp);
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
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Audit Log</h1>
 <p class="text-base-content/60 text-sm mt-1">Record change history across all collections</p>
 </div>
 </div>

 <!-- Filters -->
 <div class="card bg-base-200">
 <div class="card-body p-4">
 <div class="flex flex-wrap gap-3">
 <div class="form-control">
 <label class="label py-0"><span class="label-text text-xs">Collection</span></label>
 <input
 type="text"
 bind:value={filterCollection}
 placeholder="e.g. orders"
 class="input input-sm w-40"
 />
 </div>
 <div class="form-control">
 <label class="label py-0"><span class="label-text text-xs">User ID</span></label>
 <input
 type="text"
 bind:value={filterUserId}
 placeholder="User ID"
 class="input input-sm w-48"
 />
 </div>
 <div class="form-control">
 <label class="label py-0"><span class="label-text text-xs">Operation</span></label>
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

 <!-- Pagination -->
 <div class="flex justify-center gap-2">
 <button class="btn btn-sm btn-ghost" onclick={() => { page--; load(); }} disabled={page <= 1}>
 <ChevronLeft size={16} />Prev
 </button>
 <span class="btn btn-sm btn-ghost no-animation">Page {page}</span>
 <button class="btn btn-sm btn-ghost" onclick={() => { page++; load(); }} disabled={revisions.length < limit}>
 Next<ChevronRight size={16} />
 </button>
 </div>
 {/if}
</div>
