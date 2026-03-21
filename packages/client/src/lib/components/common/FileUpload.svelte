<script lang="ts">
  import { Upload, LoaderCircle, CheckCircle } from '@lucide/svelte';

  interface Props {
    collection?: string;
    field?: string;
    accept?: string;
    onUploaded?: (url: string) => void;
  }

  let { collection, field, accept = '*', onUploaded }: Props = $props();

  let uploading = $state(false);
  let progress = $state(0);
  let done = $state(false);

  async function upload(file: File) {
    uploading = true;
    done = false;
    progress = 0;

    try {
      const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';

      // 1. Get presigned URL from Engine
      const res = await fetch(`${engineUrl}/api/storage/presign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          collection,
          field,
        }),
      });

      if (!res.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, fileUrl } = await res.json();

      // 2. Upload directly to S3 (bypasses engine)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) progress = Math.round((e.loaded / e.total) * 100);
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });

      done = true;
      onUploaded?.(fileUrl);
    } catch (e) {
      console.error('Upload failed:', e);
    } finally {
      uploading = false;
      progress = 0;
    }
  }
</script>

<label class="flex flex-col items-center justify-center border-2 border-dashed border-base-300 rounded-xl p-6 cursor-pointer hover:border-primary transition-colors">
  <input
    type="file"
    {accept}
    onchange={(e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) upload(f);
    }}
    class="hidden"
  />

  {#if uploading}
    <LoaderCircle size={24} class="animate-spin text-primary mb-2" />
    <progress class="progress progress-primary w-48" value={progress} max="100"></progress>
    <span class="text-sm mt-1">{progress}%</span>
  {:else if done}
    <CheckCircle size={24} class="text-success mb-2" />
    <span class="text-sm text-success">Uploaded!</span>
  {:else}
    <Upload size={24} class="text-base-content/50 mb-2" />
    <span class="text-sm text-base-content/50">Click or drag to upload</span>
  {/if}
</label>
