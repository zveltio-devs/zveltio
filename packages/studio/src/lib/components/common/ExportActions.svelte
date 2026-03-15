<script lang="ts">
import { Download, ChevronDown } from '@lucide/svelte';
 import { api } from '$lib/api.js';

 interface Props {
 collection: string;
 filters?: Record<string, string>;
 label?: string;
 }

 let { collection, filters = {}, label = 'Export' }: Props = $props();

 let exporting = $state(false);

 async function exportFormat(format: 'csv' | 'json' | 'xlsx') {
 exporting = true;
 try {
 const params = new URLSearchParams({ format, ...filters });
 const res = await fetch(
 `${(await import('$lib/config.js')).ENGINE_URL}/api/export/${collection}?${params}`,
 { credentials: 'include' }
 );
 if (!res.ok) throw new Error('Export failed');

 const blob = await res.blob();
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `${collection}-export.${format}`;
 a.click();
 URL.revokeObjectURL(url);
 } catch (e) {
 alert('Export failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
 } finally {
 exporting = false;
 }
 }
</script>

<div class="dropdown dropdown-end">
 <button
 class="btn btn-sm btn-outline gap-1"
 disabled={exporting}
 tabindex="0"
 role="button"
 >
 {#if exporting}
 <span class="loading loading-spinner loading-xs"></span>
 {:else}
 <Download size={14} />
 {/if}
 {label}
 <ChevronDown size={14} />
 </button>

 <ul class="dropdown-content menu bg-base-100 rounded-box z-10 w-36 p-2 shadow-lg border border-base-300 mt-1">
 <li><button onclick={() => exportFormat('csv')}>CSV</button></li>
 <li><button onclick={() => exportFormat('json')}>JSON</button></li>
 <li><button onclick={() => exportFormat('xlsx')}>Excel (.xlsx)</button></li>
 </ul>
</div>
