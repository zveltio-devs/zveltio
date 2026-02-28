<script lang="ts">
  import X from '@lucide/svelte/icons/x.svelte';
  import ImageIcon from '@lucide/svelte/icons/image.svelte';
  import Upload from '@lucide/svelte/icons/upload.svelte';
  import { ENGINE_URL } from '$lib/config.js';

  interface Props {
    value: string | null;
    onchange?: (url: string | null) => void;
  }

  let { value = null, onchange }: Props = $props();

  let uploading = $state(false);
  let dragOver = $state(false);
  let error = $state<string | null>(null);

  async function handleFileSelect(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await uploadFile(file);
    (e.target as HTMLInputElement).value = '';
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files[0];
    if (file?.type.startsWith('image/')) await uploadFile(file);
  }

  async function uploadFile(file: File) {
    if (file.size > 2 * 1024 * 1024) { error = 'File size must be less than 2MB'; return; }
    const allowed = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.type)) { error = 'Invalid file type. Use PNG, JPG, SVG, GIF, or WebP.'; return; }

    uploading = true;
    error = null;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${ENGINE_URL}/api/storage/upload`, {
        method: 'POST', credentials: 'include', body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      onchange?.(data.file?.url || data.url);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Upload failed. Please try again.';
    } finally {
      uploading = false;
    }
  }
</script>

<div class="form-control w-full">
  <div class="label"><span class="label-text font-medium">Company Logo</span></div>

  {#if error}
    <div class="alert alert-error mb-4"><span>{error}</span></div>
  {/if}

  {#if value}
    <div class="relative w-full max-w-md">
      <div class="border-2 border-base-300 rounded-lg p-4 bg-base-200 flex items-center justify-center min-h-32">
        <img src={value} alt="Company Logo" class="max-h-32 max-w-full object-contain" />
      </div>
      <button class="btn btn-circle btn-sm btn-error absolute top-2 right-2" onclick={() => onchange?.(null)} type="button" title="Remove logo">
        <X size={16} />
      </button>
      <label class="btn btn-sm btn-ghost mt-2 gap-2 cursor-pointer">
        <Upload size={16} /> Change Logo
        <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp" class="hidden"
          onchange={handleFileSelect} disabled={uploading} />
      </label>
    </div>
  {:else}
    <div
      class="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors {dragOver ? 'border-primary bg-primary/10' : 'border-base-300 hover:border-primary'}"
      ondragover={(e) => { e.preventDefault(); dragOver = true; }}
      ondragleave={() => (dragOver = false)}
      ondrop={handleDrop}
      onclick={() => document.getElementById('logo-upload')?.click()}
      role="button" tabindex="0"
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('logo-upload')?.click(); } }}
    >
      {#if uploading}
        <span class="loading loading-spinner loading-lg"></span>
        <p class="mt-4">Uploading...</p>
      {:else}
        <ImageIcon size={48} class="mx-auto opacity-50 mb-4" />
        <p class="font-medium mb-2">Click to upload or drag and drop</p>
        <p class="text-sm opacity-70">PNG, JPG, SVG, GIF, WebP up to 2MB</p>
      {/if}
    </div>
    <input id="logo-upload" type="file" accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp"
      class="hidden" onchange={handleFileSelect} disabled={uploading} />
  {/if}

  <div class="label">
    <span class="label-text-alt opacity-70">Recommended: SVG or PNG with transparent background (max 2MB)</span>
  </div>
</div>
