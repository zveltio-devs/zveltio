<script lang="ts">
  import { onMount } from 'svelte';
  import { Upload, Folder, FolderPlus, Trash2, Download, Image, File, Film, Music } from '@lucide/svelte';

  const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || '';

  let files = $state<any[]>([]);
  let folders = $state<any[]>([]);
  let currentFolderId = $state<string | null>(null);
  let loading = $state(true);
  let uploading = $state(false);
  let showNewFolder = $state(false);
  let newFolderName = $state('');
  let selectedFiles = $state<Set<string>>(new Set());

  onMount(() => loadAll());

  async function loadAll() {
    loading = true;
    const params = currentFolderId ? `?folder_id=${currentFolderId}` : '';
    const [filesRes, foldersRes] = await Promise.all([
      fetch(`${engineUrl}/api/storage${params}`, { credentials: 'include' }).then((r) => r.json()),
      fetch(`${engineUrl}/api/storage/folders`, { credentials: 'include' }).then((r) => r.json()),
    ]);
    files = filesRes.files || [];
    folders = (foldersRes.folders || []).filter((f: any) =>
      currentFolderId ? f.parent_id === currentFolderId : !f.parent_id,
    );
    loading = false;
  }

  async function uploadFile(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    uploading = true;
    try {
      for (const file of Array.from(input.files)) {
        const fd = new FormData();
        fd.append('file', file);
        if (currentFolderId) fd.append('folder_id', currentFolderId);
        await fetch(`${engineUrl}/api/storage/upload`, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });
      }
      await loadAll();
    } finally {
      uploading = false;
      input.value = '';
    }
  }

  async function deleteFile(id: string) {
    if (!confirm('Delete this file?')) return;
    await fetch(`${engineUrl}/api/storage/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadAll();
  }

  async function createFolder() {
    if (!newFolderName.trim()) return;
    await fetch(`${engineUrl}/api/storage/folders`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newFolderName, parent_id: currentFolderId }),
    });
    newFolderName = '';
    showNewFolder = false;
    await loadAll();
  }

  function fileIcon(mime: string) {
    if (mime?.startsWith('image/')) return Image;
    if (mime?.startsWith('video/')) return Film;
    if (mime?.startsWith('audio/')) return Music;
    return File;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Storage</h1>
      <p class="text-base-content/60 text-sm mt-1">Media files and folders</p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm gap-2" onclick={() => (showNewFolder = true)}>
        <FolderPlus size={16} />New Folder
      </button>
      <label class="btn btn-primary btn-sm gap-2 cursor-pointer">
        <Upload size={16} />
        {uploading ? 'Uploading...' : 'Upload'}
        <input type="file" class="hidden" multiple onchange={uploadFile} disabled={uploading} />
      </label>
    </div>
  </div>

  <!-- Breadcrumb -->
  <div class="breadcrumbs text-sm">
    <ul>
      <li><button onclick={() => { currentFolderId = null; loadAll(); }} class="link">Root</button></li>
      {#if currentFolderId}
        <li>{folders.find((f) => f.id === currentFolderId)?.name || 'Folder'}</li>
      {/if}
    </ul>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else}
    <!-- Folders -->
    {#if folders.length > 0}
      <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3 mb-2">
        {#each folders as folder}
          <button
            class="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-base-200 transition-colors"
            ondblclick={() => { currentFolderId = folder.id; loadAll(); }}
          >
            <Folder size={40} class="text-warning" />
            <span class="text-xs text-center truncate w-full">{folder.name}</span>
          </button>
        {/each}
      </div>
      <div class="divider my-2"></div>
    {/if}

    <!-- Files grid -->
    {#if files.length === 0}
      <div class="card bg-base-200 text-center py-16">
        <p class="text-base-content/60">No files here. Upload some!</p>
      </div>
    {:else}
      <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
        {#each files as file}
          {@const Icon = fileIcon(file.mimetype)}
          <div class="group relative rounded-xl overflow-hidden border border-base-300 hover:border-primary transition-colors">
            {#if file.mimetype?.startsWith('image/')}
              <img
                src={file.url}
                alt={file.original_name}
                class="w-full aspect-square object-cover"
                onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            {:else}
              <div class="w-full aspect-square flex items-center justify-center bg-base-200">
                <Icon size={40} class="text-base-content/40" />
              </div>
            {/if}
            <div class="p-2">
              <p class="text-xs font-medium truncate">{file.original_name}</p>
              <p class="text-xs text-base-content/50">{formatSize(file.size)}</p>
            </div>
            <div class="absolute top-1 right-1 hidden group-hover:flex gap-1">
              {#if file.url}
                <a href={file.url} target="_blank" class="btn btn-xs btn-circle btn-ghost bg-base-100/80">
                  <Download size={12} />
                </a>
              {/if}
              <button class="btn btn-xs btn-circle btn-ghost bg-base-100/80 text-error" onclick={() => deleteFile(file.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<!-- New folder modal -->
{#if showNewFolder}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New Folder</h3>
      <div class="form-control">
        <label class="label"><span class="label-text">Folder name</span></label>
        <input
          type="text"
          bind:value={newFolderName}
          placeholder="My Folder"
          class="input input-bordered"
          onkeydown={(e) => e.key === 'Enter' && createFolder()}
          autofocus
        />
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showNewFolder = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createFolder}>Create</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showNewFolder = false)}></button>
  </dialog>
{/if}
