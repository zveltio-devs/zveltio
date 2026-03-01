<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import {
    Folder, FolderPlus, Upload, Image, Video, FileText, Trash2,
    Tag, Search, Grid3x3, List, Download, X, Plus,
  } from '@lucide/svelte';

  let folders = $state<any[]>([]);
  let files = $state<any[]>([]);
  let tags = $state<any[]>([]);
  let selectedFolder = $state<string | null>(null);
  let selectedFolderName = $state<string>('All Files');
  let viewMode = $state<'grid' | 'list'>('grid');
  let searchQuery = $state('');
  let selectedTag = $state<string | null>(null);
  let selectedFiles = $state<Set<string>>(new Set());

  let showUploadModal = $state(false);
  let uploadingFiles = $state<File[]>([]);
  let uploading = $state(false);
  let uploadProgress = $state(0);

  let showFolderModal = $state(false);
  let folderName = $state('');

  let showTagModal = $state(false);
  let tagName = $state('');
  let tagColor = $state('#3b82f6');

  let showFileDetails = $state<any>(null);
  let stats = $state<any>(null);
  let error = $state('');

  onMount(async () => {
    await Promise.all([loadFolders(), loadFiles(), loadTags(), loadStats()]);
  });

  async function loadFolders() {
    try {
      const data = await api.get<{ folders: any[] }>('/api/media/folders');
      folders = data.folders || [];
    } catch (e: any) { error = e.message; }
  }

  async function loadFiles() {
    try {
      const params = new URLSearchParams();
      if (selectedFolder) params.set('folder_id', selectedFolder);
      if (searchQuery) params.set('search', searchQuery);
      if (selectedTag) params.set('tag', selectedTag);
      params.set('limit', '100');
      const data = await api.get<{ files: any[] }>(`/api/media/files?${params}`);
      files = data.files || [];
    } catch (e: any) { error = e.message; }
  }

  async function loadTags() {
    try {
      const data = await api.get<{ tags: any[] }>('/api/media/tags');
      tags = data.tags || [];
    } catch (e: any) { error = e.message; }
  }

  async function loadStats() {
    try {
      stats = await api.get('/api/media/stats');
    } catch { /* non-critical */ }
  }

  function selectFolder(folderId: string | null, name = 'All Files') {
    selectedFolder = folderId;
    selectedFolderName = name;
    selectedFiles = new Set();
    loadFiles();
  }

  async function createFolder() {
    if (!folderName.trim()) return;
    try {
      await api.post('/api/media/folders', { name: folderName, parent_id: selectedFolder });
      showFolderModal = false;
      folderName = '';
      await loadFolders();
    } catch (e: any) { alert(e.message); }
  }

  async function deleteFolder(id: string) {
    if (!confirm('Delete this folder?')) return;
    try {
      await api.delete(`/api/media/folders/${id}`);
      await loadFolders();
      if (selectedFolder === id) selectFolder(null);
    } catch (e: any) { alert(e.message); }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      uploadingFiles = Array.from(input.files);
      showUploadModal = true;
    }
  }

  async function uploadFiles() {
    if (uploadingFiles.length === 0) return;
    uploading = true;
    uploadProgress = 0;
    let uploaded = 0;
    for (const file of uploadingFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        if (selectedFolder) formData.append('folder_id', selectedFolder);
        await fetch('/api/media/upload', { method: 'POST', body: formData, credentials: 'include' });
        uploaded++;
        uploadProgress = Math.round((uploaded / uploadingFiles.length) * 100);
      } catch (e) { console.error('Upload failed for', file.name, e); }
    }
    uploading = false;
    showUploadModal = false;
    uploadingFiles = [];
    uploadProgress = 0;
    await loadFiles();
    await loadStats();
  }

  async function deleteFile(id: string) {
    if (!confirm('Delete this file?')) return;
    try {
      await api.delete(`/api/media/files/${id}`);
      await loadFiles();
      await loadStats();
      if (showFileDetails?.id === id) showFileDetails = null;
    } catch (e: any) { alert(e.message); }
  }

  async function deleteSelectedFiles() {
    if (selectedFiles.size === 0) return;
    if (!confirm(`Delete ${selectedFiles.size} selected files?`)) return;
    try {
      await api.post('/api/media/files/batch-delete', { ids: Array.from(selectedFiles) });
      selectedFiles = new Set();
      await loadFiles();
      await loadStats();
    } catch (e: any) { alert(e.message); }
  }

  async function createTag() {
    if (!tagName.trim()) return;
    try {
      await api.post('/api/media/tags', { name: tagName, color: tagColor });
      showTagModal = false;
      tagName = '';
      await loadTags();
    } catch (e: any) { alert(e.message); }
  }

  async function addTagToFile(fileId: string, tagId: string) {
    try {
      await api.post(`/api/media/files/${fileId}/tags`, { tag_id: tagId });
      await loadFiles();
    } catch (e) { console.error('Failed to add tag:', e); }
  }

  async function removeTagFromFile(fileId: string, tagId: string) {
    try {
      await api.delete(`/api/media/files/${fileId}/tags/${tagId}`);
      await loadFiles();
    } catch (e) { console.error('Failed to remove tag:', e); }
  }

  function toggleFileSelection(id: string) {
    const next = new Set(selectedFiles);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedFiles = next;
  }

  function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDate(s: string): string {
    return new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  let isAllSelected = $derived(files.length > 0 && selectedFiles.size === files.length);
</script>

<div class="h-[calc(100vh-4rem)] flex">
  <!-- Sidebar -->
  <div class="w-64 bg-base-200 border-r border-base-300 p-4 overflow-y-auto flex flex-col shrink-0">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-sm uppercase opacity-60">Folders</h3>
      <button class="btn btn-xs btn-ghost btn-square" onclick={() => { folderName = ''; showFolderModal = true; }}>
        <FolderPlus size={14} />
      </button>
    </div>

    <div class="space-y-1 mb-6">
      <button
        class="btn btn-sm w-full justify-start {selectedFolder === null ? 'btn-primary' : 'btn-ghost'}"
        onclick={() => selectFolder(null)}
      >
        <Folder size={14} /> All Files
        {#if stats}<span class="ml-auto text-xs opacity-60">{stats.totalFiles}</span>{/if}
      </button>

      {#each folders as folder}
        <div class="group flex items-center rounded-lg {selectedFolder === folder.id ? 'bg-primary/10' : ''}">
          <button
            class="btn btn-sm flex-1 justify-start {selectedFolder === folder.id ? 'btn-primary' : 'btn-ghost'}"
            onclick={() => selectFolder(folder.id, folder.name)}
          >
            <Folder size={14} />
            <span class="truncate">{folder.name}</span>
          </button>
          <button
            class="btn btn-xs btn-ghost btn-square opacity-0 group-hover:opacity-100"
            onclick={() => deleteFolder(folder.id)}
          >
            <Trash2 size={12} class="text-error" />
          </button>
        </div>
      {/each}
    </div>

    <div class="divider my-2"></div>

    <div class="flex items-center justify-between mb-2">
      <h3 class="font-bold text-sm uppercase opacity-60">Tags</h3>
      <button class="btn btn-xs btn-ghost btn-square" onclick={() => { tagName = ''; tagColor = '#3b82f6'; showTagModal = true; }}>
        <Plus size={14} />
      </button>
    </div>

    <div class="flex flex-wrap gap-1 mb-6">
      {#each tags as tag}
        <button
          class="badge badge-sm cursor-pointer hover:badge-outline {selectedTag === tag.name ? 'badge-primary' : ''}"
          style="border-color: {tag.color}; color: {selectedTag === tag.name ? '' : tag.color}"
          onclick={() => { selectedTag = selectedTag === tag.name ? null : tag.name; loadFiles(); }}
        >
          {tag.name}
        </button>
      {/each}
    </div>

    {#if stats}
      <div class="mt-auto">
        <div class="card bg-base-100 border border-base-300 p-3">
          <h4 class="font-bold text-sm mb-2">Storage</h4>
          <p class="text-2xl font-bold">{formatFileSize(stats.totalSize)}</p>
          <p class="text-xs opacity-60">{stats.totalFiles} files</p>
        </div>
      </div>
    {/if}
  </div>

  <!-- Main Content -->
  <div class="flex-1 flex flex-col overflow-hidden">
    <!-- Toolbar -->
    <div class="h-16 bg-base-100 border-b border-base-300 flex items-center justify-between px-4 shrink-0">
      <div class="flex items-center gap-2">
        <h2 class="font-bold text-lg">{selectedFolderName}</h2>
        {#if selectedTag}<span class="badge badge-primary">Tag: {selectedTag}</span>{/if}
      </div>

      <div class="flex items-center gap-2">
        <label class="input input-sm input-bordered flex items-center gap-2 w-56">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search..."
            bind:value={searchQuery}
            onkeyup={(e) => e.key === 'Enter' && loadFiles()}
            class="grow"
          />
        </label>

        <div class="join">
          <button class="btn btn-sm join-item {viewMode === 'grid' ? 'btn-active' : ''}" onclick={() => (viewMode = 'grid')}>
            <Grid3x3 size={14} />
          </button>
          <button class="btn btn-sm join-item {viewMode === 'list' ? 'btn-active' : ''}" onclick={() => (viewMode = 'list')}>
            <List size={14} />
          </button>
        </div>

        {#if selectedFiles.size > 0}
          <button class="btn btn-sm btn-error gap-1" onclick={deleteSelectedFiles}>
            <Trash2 size={14} /> Delete ({selectedFiles.size})
          </button>
        {/if}

        <label class="btn btn-primary btn-sm gap-1">
          <Upload size={14} /> Upload
          <input type="file" multiple class="hidden" onchange={handleFileSelect} />
        </label>
      </div>
    </div>

    {#if error}
      <div class="alert alert-error text-sm m-4">{error}</div>
    {/if}

    <!-- Files Grid/List -->
    <div class="flex-1 overflow-y-auto p-4">
      {#if viewMode === 'grid'}
        <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {#each files as file}
            <div
              class="card bg-base-100 border border-base-300 hover:shadow-lg transition-shadow cursor-pointer {selectedFiles.has(file.id) ? 'ring-2 ring-primary' : ''}"
              onclick={() => toggleFileSelection(file.id)}
              ondblclick={() => (showFileDetails = file)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && toggleFileSelection(file.id)}
            >
              <figure class="aspect-square bg-base-200 flex items-center justify-center overflow-hidden">
                {#if file.thumbnail_url}
                  <img src={file.thumbnail_url} alt={file.filename} class="w-full h-full object-cover" />
                {:else if file.mime_type?.startsWith('image/')}
                  <Image size={48} class="opacity-30" />
                {:else if file.mime_type?.startsWith('video/')}
                  <Video size={48} class="opacity-30" />
                {:else}
                  <FileText size={48} class="opacity-30" />
                {/if}
              </figure>
              <div class="card-body p-2">
                <p class="text-xs font-medium truncate">{file.original_filename}</p>
                <p class="text-xs opacity-50">{formatFileSize(file.size_bytes)}</p>
                {#if file.tags?.length > 0}
                  <div class="flex flex-wrap gap-0.5 mt-1">
                    {#each file.tags.slice(0, 2) as tag}
                      <span class="badge badge-xs" style="background: {tag.color}20; color: {tag.color}">{tag.name}</span>
                    {/each}
                    {#if file.tags.length > 2}
                      <span class="badge badge-xs">+{file.tags.length - 2}</span>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="space-y-2">
          <div class="flex items-center gap-2 p-2 bg-base-200 rounded-lg mb-2">
            <input
              type="checkbox"
              class="checkbox checkbox-sm"
              checked={isAllSelected}
              onchange={() => {
                if (isAllSelected) { selectedFiles = new Set(); }
                else { selectedFiles = new Set(files.map(f => f.id)); }
              }}
            />
            <span class="text-sm">Select all ({files.length})</span>
          </div>

          {#each files as file}
            <div
              class="card bg-base-100 border border-base-300 flex flex-row items-center p-2 gap-3 hover:bg-base-200 cursor-pointer {selectedFiles.has(file.id) ? 'ring-2 ring-primary' : ''}"
              onclick={() => toggleFileSelection(file.id)}
              ondblclick={() => (showFileDetails = file)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && toggleFileSelection(file.id)}
            >
              <input type="checkbox" class="checkbox checkbox-sm" checked={selectedFiles.has(file.id)}
                onclick={(e) => e.stopPropagation()} onchange={() => toggleFileSelection(file.id)} />

              <div class="w-12 h-12 bg-base-200 rounded flex items-center justify-center overflow-hidden shrink-0">
                {#if file.thumbnail_url}
                  <img src={file.thumbnail_url} alt={file.filename} class="w-full h-full object-cover" />
                {:else if file.mime_type?.startsWith('image/')}
                  <Image size={24} class="opacity-30" />
                {:else if file.mime_type?.startsWith('video/')}
                  <Video size={24} class="opacity-30" />
                {:else}
                  <FileText size={24} class="opacity-30" />
                {/if}
              </div>

              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">{file.original_filename}</p>
                <p class="text-xs opacity-50">{formatFileSize(file.size_bytes)} · {file.mime_type} · {formatDate(file.created_at)}</p>
              </div>

              {#if file.tags?.length > 0}
                <div class="flex gap-1">
                  {#each file.tags as tag}
                    <span class="badge badge-sm" style="background: {tag.color}20; color: {tag.color}">{tag.name}</span>
                  {/each}
                </div>
              {/if}

              <div class="flex gap-1 shrink-0">
                <a href={file.url} target="_blank" class="btn btn-xs btn-ghost" onclick={(e) => e.stopPropagation()}>
                  <Download size={12} />
                </a>
                <button class="btn btn-xs btn-ghost text-error" onclick={(e) => { e.stopPropagation(); deleteFile(file.id); }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if files.length === 0}
        <div class="text-center py-16 opacity-50">
          <Image size={48} class="mx-auto mb-4 opacity-40" />
          <p>No files found</p>
          <p class="text-sm">Upload files or change filters</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Upload Modal -->
{#if showUploadModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">Upload Files</h3>
      <div class="space-y-2 mb-4 max-h-64 overflow-y-auto">
        {#each uploadingFiles as file}
          <div class="flex items-center justify-between p-2 bg-base-200 rounded">
            <span class="text-sm truncate flex-1">{file.name}</span>
            <span class="text-xs opacity-50 ml-2">{formatFileSize(file.size)}</span>
          </div>
        {/each}
      </div>
      {#if uploading}
        <div class="mb-4">
          <progress class="progress progress-primary w-full" value={uploadProgress} max="100"></progress>
          <p class="text-center text-sm mt-1">{uploadProgress}%</p>
        </div>
      {/if}
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showUploadModal = false)} disabled={uploading}>Cancel</button>
        <button class="btn btn-primary" onclick={uploadFiles} disabled={uploading}>
          {#if uploading}<span class="loading loading-spinner loading-sm"></span>{/if}
          Upload {uploadingFiles.length} file{uploadingFiles.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => !uploading && (showUploadModal = false)}
      onkeydown={(e) => e.key === 'Escape' && !uploading && (showUploadModal = false)} tabindex="0" aria-label="Close"></button>
  </div>
{/if}

<!-- Folder Modal -->
{#if showFolderModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New Folder</h3>
      <div class="form-control">
        <label class="label" for="folder-name"><span class="label-text">Folder Name</span></label>
        <input id="folder-name" type="text" class="input input-bordered" bind:value={folderName} placeholder="My Folder" />
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showFolderModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createFolder}>Create</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showFolderModal = false)}
      onkeydown={(e) => e.key === 'Escape' && (showFolderModal = false)} tabindex="0" aria-label="Close"></button>
  </div>
{/if}

<!-- Tag Modal -->
{#if showTagModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New Tag</h3>
      <div class="form-control mb-4">
        <label class="label" for="tag-name"><span class="label-text">Name</span></label>
        <input id="tag-name" type="text" class="input input-bordered" bind:value={tagName} placeholder="Important" />
      </div>
      <div class="form-control">
        <label class="label" for="tag-color"><span class="label-text">Color</span></label>
        <input id="tag-color" type="color" class="input input-bordered h-12" bind:value={tagColor} />
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showTagModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createTag}>Create</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showTagModal = false)}
      onkeydown={(e) => e.key === 'Escape' && (showTagModal = false)} tabindex="0" aria-label="Close"></button>
  </div>
{/if}

<!-- File Details Modal -->
{#if showFileDetails}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-start justify-between mb-4">
        <h3 class="font-bold text-lg truncate flex-1">{showFileDetails.original_filename}</h3>
        <button class="btn btn-sm btn-ghost btn-square" onclick={() => (showFileDetails = null)}>
          <X size={16} />
        </button>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="bg-base-200 rounded-lg aspect-square flex items-center justify-center overflow-hidden">
          {#if showFileDetails.url && showFileDetails.mime_type?.startsWith('image/')}
            <img src={showFileDetails.url} alt={showFileDetails.filename} class="max-w-full max-h-full object-contain" />
          {:else if showFileDetails.mime_type?.startsWith('video/')}
            <Video size={64} class="opacity-30" />
          {:else}
            <FileText size={64} class="opacity-30" />
          {/if}
        </div>

        <div class="space-y-3">
          <div>
            <div class="text-xs opacity-60">Type</div>
            <p class="text-sm">{showFileDetails.mime_type}</p>
          </div>
          <div>
            <div class="text-xs opacity-60">Size</div>
            <p class="text-sm">{formatFileSize(showFileDetails.size_bytes)}</p>
          </div>
          {#if showFileDetails.width && showFileDetails.height}
            <div>
              <div class="text-xs opacity-60">Dimensions</div>
              <p class="text-sm">{showFileDetails.width} × {showFileDetails.height}</p>
            </div>
          {/if}
          <div>
            <div class="text-xs opacity-60">Uploaded</div>
            <p class="text-sm">{formatDate(showFileDetails.created_at)}</p>
          </div>

          <div>
            <div class="text-xs opacity-60 mb-1">Tags</div>
            <div class="flex flex-wrap gap-1">
              {#each showFileDetails.tags || [] as tag}
                <button
                  type="button"
                  class="badge badge-sm cursor-pointer"
                  style="background: {tag.color}20; color: {tag.color}"
                  onclick={() => removeTagFromFile(showFileDetails.id, tag.id)}
                >
                  {tag.name} <X size={10} class="ml-1" />
                </button>
              {/each}
              {#each tags as tag}
                {#if !showFileDetails.tags?.find((t: any) => t.id === tag.id)}
                  <button
                    type="button"
                    class="badge badge-sm badge-ghost cursor-pointer"
                    onclick={() => addTagToFile(showFileDetails.id, tag.id)}
                  >
                    + {tag.name}
                  </button>
                {/if}
              {/each}
            </div>
          </div>
        </div>
      </div>

      <div class="modal-action">
        <a href={showFileDetails.url} target="_blank" class="btn btn-ghost gap-2">
          <Download size={16} /> Download
        </a>
        <button class="btn btn-error gap-2" onclick={() => deleteFile(showFileDetails.id)}>
          <Trash2 size={16} /> Delete
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showFileDetails = null)}
      onkeydown={(e) => e.key === 'Escape' && (showFileDetails = null)} tabindex="0" aria-label="Close"></button>
  </div>
{/if}
