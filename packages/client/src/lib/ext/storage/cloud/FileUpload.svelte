<script lang="ts" module>
  /** The engine's stored file, as `POST /api/storage/upload` answers it. */
  export interface UploadedFile {
    id: string;
    original_name: string;
    mimetype: string;
    size: number;
    visibility: 'personal' | 'tenant';
    /** A public upload's bare URL; a private one's signed URL, which expires. */
    url: string | null;
  }
</script>

<script lang="ts">
  import { Upload, LoaderCircle, CheckCircle } from '@lucide/svelte';

  interface Props {
    /** Base URL of your Zveltio engine, e.g. 'https://api.myapp.com' */
    engineUrl?: string;
    accept?: string;
    /** A folder of the signed-in user's tenant to store the file in. */
    folderId?: string;
    onUploaded?: (file: UploadedFile) => void;
  }

  let { engineUrl, accept = '*', folderId, onUploaded }: Props = $props();

  function resolveEngineUrl() {
    if (engineUrl) return engineUrl;
    // fallback: SvelteKit env var or localhost
    try { return (import.meta as any).env?.PUBLIC_ENGINE_URL || 'http://localhost:3000'; } catch { return 'http://localhost:3000'; }
  }

  let uploading = $state(false);
  let progress = $state(0);
  let done = $state(false);

  // The engine's own upload, as the signed-in user (session cookie): its size,
  // quota and type checks apply, and the file is private to them.
  async function upload(file: File) {
    uploading = true;
    done = false;
    progress = 0;

    try {
      const form = new FormData();
      form.append('file', file);
      if (folderId) form.append('folder_id', folderId);
      const stored = await new Promise<UploadedFile>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) progress = Math.round((e.loaded / e.total) * 100);
        };
        xhr.onload = () =>
          xhr.status === 201 ? resolve(JSON.parse(xhr.responseText).file) : reject(new Error(`Upload failed: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.open('POST', `${resolveEngineUrl()}/api/storage/upload`);
        xhr.withCredentials = true;
        xhr.send(form);
      });

      done = true;
      onUploaded?.(stored);
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
    <Upload size={24} class="text-base-content/65 mb-2" />
    <span class="text-sm text-base-content/65">Click or drag to upload</span>
  {/if}
</label>
