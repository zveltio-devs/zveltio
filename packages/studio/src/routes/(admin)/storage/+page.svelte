<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import { Upload, Trash2, Copy, Check, HardDrive, File, FileText, Image, LoaderCircle } from '@lucide/svelte';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';
 import { toast } from '$lib/stores/toast.svelte.js';

 interface MediaFile {
 id: string;
 original_name: string;
 mime_type: string;
 size: number;
 url: string;
 created_at: string;
 }

 let files = $state<MediaFile[]>([]);
 let loading = $state(true);
 let uploading = $state(false);
 let dragging = $state(false);
 let filter = $state<'all' | 'images' | 'documents'>('all');
 let copied = $state<string | null>(null);
 let selectedFiles = $state<Set<string>>(new Set());
 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

 const filtered = $derived(
 filter === 'all' ? files :
 filter === 'images' ? files.filter(f => f.mime_type.startsWith('image/')) :
 files.filter(f => !f.mime_type.startsWith('image/'))
 );

 onMount(loadFiles);

 async function loadFiles() {
 loading = true;
 try {
 const data = await api.get<{ files: MediaFile[] }>('/api/storage/');
 files = data.files || [];
 } catch { files = []; }
 finally { loading = false; }
 }

 async function upload(fileList: FileList | null) {
 if (!fileList?.length) return;
 uploading = true;
 try {
 for (const f of Array.from(fileList)) {
 const fd = new FormData();
 fd.append('file', f);
 const res = await fetch('/api/storage/upload', {
 method: 'POST', credentials: 'include', body: fd,
 });
 if (!res.ok) throw new Error(`Upload failed: ${f.name}`);
 }
 await loadFiles();
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Upload failed');
 } finally { uploading = false; }
 }

 async function deleteFile(id: string, name: string) {
 confirmState = {
 open: true,
 title: 'Delete File',
 message: `Delete "${name}"? This cannot be undone.`,
 confirmLabel: 'Delete',
 onconfirm: async () => {
 confirmState.open = false;
 try {
 await api.delete(`/api/storage/${id}`);
 files = files.filter(f => f.id !== id);
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Delete failed');
 }
 },
 };
 }

 async function bulkDelete() {
 if (selectedFiles.size === 0) return;
 for (const id of selectedFiles) {
 try {
 await api.delete(`/api/storage/${id}`);
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Delete failed');
 }
 }
 selectedFiles = new Set();
 await loadFiles();
 }

 async function copyUrl(url: string, id: string) {
 await navigator.clipboard.writeText(url);
 copied = id;
 setTimeout(() => (copied = null), 2000);
 }

 function fmt(bytes: number) {
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
 return `${(bytes / 1048576).toFixed(1)} MB`;
 }

 function isImage(mime: string) { return mime.startsWith('image/'); }
 function isPdf(mime: string) { return mime.includes('pdf'); }
</script>

<div class="space-y-6">
 <PageHeader title="Storage" subtitle="File storage and asset management" count={files.length}>
  <label class="btn btn-primary btn-sm cursor-pointer" class:loading={uploading}>
  {#if uploading}<LoaderCircle size={16} class="animate-spin" />{:else}<Upload size={16} />{/if}
  Upload
  <input type="file" class="hidden" multiple
  onchange={(e) => upload((e.target as HTMLInputElement).files)}
  disabled={uploading} />
  </label>
 </PageHeader>

 <!-- Drag & Drop zone -->
 <div
 class="border-2 border-dashed rounded-xl p-10 text-center transition-all cursor-default
 {dragging ? 'border-primary bg-primary/5 scale-[1.01]' : 'border-base-300 hover:border-base-content/20'}"
 ondragover={(e) => { e.preventDefault(); dragging = true; }}
 ondragleave={() => (dragging = false)}
 ondrop={(e) => { e.preventDefault(); dragging = false; upload(e.dataTransfer?.files || null); }}
 role="region" aria-label="File drop zone"
 >
 <HardDrive size={36} class="mx-auto mb-2 opacity-30" />
 <p class="text-sm text-base-content/50">Drop files here to upload</p>
 </div>

 <!-- Filter tabs -->
 <div class="tabs tabs-bordered">
 {#each [['all','All'], ['images','Images'], ['documents','Documents']] as [id, label]}
 <button class="tab {filter === id ? 'tab-active' : ''}" onclick={() => (filter = id as any)}>
 {label}
 <span class="ml-1 badge badge-sm badge-ghost">
 {id === 'all' ? files.length :
 id === 'images' ? files.filter(f => f.mime_type.startsWith('image/')).length :
 files.filter(f => !f.mime_type.startsWith('image/')).length}
 </span>
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-16"><LoaderCircle size={32} class="animate-spin text-primary" /></div>
 {:else if filtered.length === 0}
 <div class="text-center py-16 text-base-content/40">
 <File size={48} class="mx-auto mb-3" />
 <p class="text-sm">No {filter === 'all' ? '' : filter} files yet</p>
 </div>
 {:else}
 <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
 {#each filtered as file}
 <div class="card bg-base-200 overflow-hidden relative group {selectedFiles.has(file.id) ? 'ring-2 ring-primary' : ''}">
 <!-- Checkbox overlay -->
 <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity {selectedFiles.has(file.id) ? 'opacity-100' : ''}">
 <input type="checkbox" class="checkbox checkbox-xs checkbox-primary"
 checked={selectedFiles.has(file.id)}
 onclick={(e: MouseEvent) => {
 e.stopPropagation();
 const next = new Set(selectedFiles);
 if ((e.currentTarget as HTMLInputElement).checked) next.add(file.id);
 else next.delete(file.id);
 selectedFiles = next;
 }} />
 </div>
 <!-- Thumbnail -->
 <div class="h-36 bg-base-300 flex items-center justify-center overflow-hidden">
 {#if isImage(file.mime_type)}
 <img src={file.url} alt={file.original_name} class="w-full h-full object-cover" loading="lazy" />
 {:else if isPdf(file.mime_type)}
 <FileText size={36} class="opacity-30" />
 {:else}
 <File size={36} class="opacity-30" />
 {/if}
 </div>
 <!-- Info -->
 <div class="p-3 space-y-2">
 <div>
 <p class="text-sm font-medium truncate" title={file.original_name}>{file.original_name}</p>
 <div class="flex justify-between text-xs text-base-content/50">
 <span>{fmt(file.size)}</span>
 <span>{new Date(file.created_at).toLocaleDateString()}</span>
 </div>
 </div>
 <div class="flex gap-1">
 <button class="btn btn-ghost btn-xs flex-1 text-xs" onclick={() => copyUrl(file.url, file.id)}>
 {#if copied === file.id}<Check size={13} class="text-success" /> Copied!
 {:else}<Copy size={13} /> Copy URL{/if}
 </button>
 <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteFile(file.id, file.original_name)}>
 <Trash2 size={13} />
 </button>
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
