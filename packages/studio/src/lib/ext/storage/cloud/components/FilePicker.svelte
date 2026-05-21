<script lang="ts">
import { Upload, X, File as FileIcon } from '@lucide/svelte';
 import { ENGINE_URL } from '$lib/config.js';

 interface Props {
 value?: string | null;
 accept?: string;
 readonly?: boolean;
 showPreview?: boolean;
 onupload?: (file: File) => Promise<string>;
 }

 let {
 value = $bindable<string | null>(null),
 accept = '*/*',
 readonly = false,
 showPreview = true,
 onupload,
 }: Props = $props();

 let uploading = $state(false);
 let fileInput: HTMLInputElement;

 function isImage(url: string | null): boolean {
 if (!url) return false;
 return !!url.match(/\.(jpg|jpeg|png|gif|webp|svg|avif)$/i);
 }

 async function handleFiles(files: FileList | null) {
 if (!files || files.length === 0) return;
 uploading = true;
 try {
 const file = files[0];
 if (onupload) {
 value = await onupload(file);
 } else {
 // Default: upload to engine storage
 const formData = new FormData();
 formData.append('file', file);
 const res = await fetch(`${ENGINE_URL}/api/storage/upload`, {
 method: 'POST',
 credentials: 'include',
 body: formData,
 });
 if (!res.ok) throw new Error('Upload failed');
 const data = await res.json();
 value = data.file?.url || data.url;
 }
 } catch {
 alert('Upload failed');
 } finally {
 uploading = false;
 }
 }

 let isImageFile = $derived(isImage(value));
 let fileName = $derived(value ? value.split('/').pop() : '');
 let hasValue = $derived(!!value);
</script>

<div class="file-picker">
 <input
 type="file"
 bind:this={fileInput}
 onchange={(e) => handleFiles(e.currentTarget.files)}
 {accept}
 class="hidden"
 />

 {#if hasValue}
 <div class="file-preview border border-base-300 rounded-lg p-3">
 {#if showPreview && isImageFile}
 <div class="relative">
 <img src={value!} alt="Preview" class="w-full h-48 object-cover rounded" />
 {#if !readonly}
 <button
 type="button"
 class="btn btn-sm btn-circle btn-error absolute top-2 right-2"
 onclick={() => (value = null)}
 ><X size={16} /></button>
 {/if}
 </div>
 {:else}
 <div class="flex items-center gap-3">
 <div class="p-3 bg-base-200 rounded-lg"><FileIcon size={32} /></div>
 <div class="flex-1 min-w-0">
 <a href={value!} target="_blank" rel="noopener noreferrer" class="link link-primary text-sm truncate block">
 {fileName}
 </a>
 </div>
 {#if !readonly}
 <button type="button" class="btn btn-sm btn-ghost" onclick={() => (value = null)}>
 <X size={16} />
 </button>
 {/if}
 </div>
 {/if}
 </div>
 {:else if !readonly}
 <button
 type="button"
 class="upload-zone border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors w-full"
 onclick={() => fileInput?.click()}
 >
 {#if uploading}
 <span class="loading loading-spinner loading-md"></span>
 <p class="text-sm mt-2">Uploading...</p>
 {:else}
 <Upload size={32} class="mx-auto opacity-50" />
 <p class="text-sm mt-2">Click to upload</p>
 <p class="text-xs opacity-50 mt-1">{accept === '*/*' ? 'Any file type' : accept}</p>
 {/if}
 </button>
 {/if}
</div>

<style>
 .file-picker { width: 100%; }
 .upload-zone:hover { border-color: hsl(var(--p)); }
</style>
