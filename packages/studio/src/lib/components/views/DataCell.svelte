<script lang="ts">
 // Renders a single cell value in a data table based on field type.

 interface Props {
 value: any;
 type?: string;
 maxLength?: number;
 }

 let { value, type = 'text', maxLength = 60 }: Props = $props();

 function isEmpty(v: any): boolean {
 return v === null || v === undefined || v === '';
 }

 function truncate(str: string): string {
 return str.length > maxLength ? str.substring(0, maxLength) + '…' : str;
 }

 function formatDate(v: any): string {
 if (!v) return '';
 try { return new Date(v).toLocaleDateString(); } catch { return String(v); }
 }

 function formatDateTime(v: any): string {
 if (!v) return '';
 try { return new Date(v).toLocaleString(); } catch { return String(v); }
 }

 function formatNumber(v: any): string {
 const n = Number(v);
 if (isNaN(n)) return String(v);
 return n.toLocaleString();
 }
</script>

{#if isEmpty(value)}
 <span class="opacity-30 text-xs italic">—</span>
{:else if type === 'boolean'}
 <span class="badge badge-xs {value ? 'badge-success' : 'badge-ghost'}">{value ? 'Yes' : 'No'}</span>
{:else if type === 'date'}
 <span class="text-sm">{formatDate(value)}</span>
{:else if type === 'datetime'}
 <span class="text-sm">{formatDateTime(value)}</span>
{:else if type === 'number' || type === 'integer' || type === 'float'}
 <span class="font-mono text-sm">{formatNumber(value)}</span>
{:else if type === 'color'}
 <div class="flex items-center gap-2">
 <span class="w-4 h-4 rounded-full inline-block border border-base-300" style="background-color: {value}"></span>
 <span class="font-mono text-xs">{value}</span>
 </div>
{:else if type === 'image'}
 <img src={value} alt="" class="h-8 w-8 object-cover rounded" loading="lazy" />
{:else if type === 'file'}
 <a href={value} target="_blank" rel="noopener noreferrer" class="link link-primary text-xs truncate max-w-32 block">
 {value.split('/').pop()}
 </a>
{:else if type === 'json'}
 <code class="text-xs bg-base-200 px-1 rounded opacity-70">{truncate(JSON.stringify(value))}</code>
{:else if type === 'richtext'}
 <span class="text-xs opacity-70">{truncate(String(value).replace(/<[^>]*>/g, ''))}</span>
{:else if type === 'url'}
 <a href={value} target="_blank" rel="noopener noreferrer" class="link link-primary text-sm truncate max-w-32 block">
 {truncate(value)}
 </a>
{:else if type === 'email'}
 <a href="mailto:{value}" class="link link-primary text-sm">{value}</a>
{:else if type === 'tags'}
 <div class="flex flex-wrap gap-1">
 {#each (Array.isArray(value) ? value : [value]) as tag}
 <span class="badge badge-xs badge-ghost">{tag}</span>
 {/each}
 </div>
{:else if type === 'password'}
 <span class="font-mono text-xs opacity-50">••••••••</span>
{:else}
 <span class="text-sm" title={String(value)}>{truncate(String(value))}</span>
{/if}
