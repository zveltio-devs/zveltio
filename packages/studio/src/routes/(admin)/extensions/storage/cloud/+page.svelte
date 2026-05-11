<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ENGINE_URL } from '$lib/config.js';
  import { Cloud, Folder, FileText, Upload, Trash2, Share2, ChevronRight, ArrowLeft, X, LoaderCircle } from '@lucide/svelte';

  let path = $state('/');
  let entries = $state<any[]>([]);
  let selected = $state<any | null>(null);
  let dragOver = $state(false);
  let uploading = $state(false);

  let showShareDialog = $state(false);
  let shareUrl = $state('');
  let shareForm = $state({ expires_in_hours: 24, password: '' });

  async function load() {
    try {
      const r = await api.get<{ data?: any[]; entries?: any[] }>(`/api/cloud/files?path=${encodeURIComponent(path)}`);
      entries = r.data ?? r.entries ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
  }

  function navigate(p: string) { path = p; selected = null; }
  function up() { const parts = path.split('/').filter(Boolean); parts.pop(); navigate('/' + parts.join('/')); }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    uploading = true;
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('path', path);
        const r = await fetch(`${ENGINE_URL}/api/cloud/upload`, { method: 'POST', credentials: 'include', body: fd });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
      }
      await load();
      toast.success('Uploaded.');
    } catch (e: any) { toast.error(e?.message ?? 'Upload failed'); }
    finally { uploading = false; }
  }

  async function deleteEntry(e: any) {
    if (!confirm(`Delete ${e.name}?`)) return;
    try {
      await api.delete(`/api/cloud/files/${encodeURIComponent(e.id ?? e.path)}`);
      await load();
    } catch (err: any) { toast.error(err?.message ?? 'Error'); }
  }

  function makeShare(e: any) { selected = e; shareForm = { expires_in_hours: 24, password: '' }; shareUrl = ''; showShareDialog = true; }

  async function createShare() {
    if (!selected) return;
    try {
      const r = await api.post<{ share_url?: string; token?: string }>('/api/cloud/shares', { file_id: selected.id, ...shareForm });
      shareUrl = r.share_url ?? `${ENGINE_URL}/share/${r.token}`;
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => { path; load(); });
  onMount(load);

  function fmtBytes(n: number) { if (!n) return '—'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n > 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; }
  function pathParts(p: string) { return p.split('/').filter(Boolean); }
  function isFolder(e: any) { return e.is_folder ?? e.type === 'folder'; }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Cloud size={20} /> Cloud Storage</h1>
      <p class="text-sm text-base-content/50">Files and folders</p>
    </div>
    <label class="btn btn-primary btn-sm gap-1">
      {#if uploading}<LoaderCircle size={14} class="animate-spin" />{:else}<Upload size={14} />{/if}
      {uploading ? 'Uploading…' : 'Upload'}
      <input type="file" multiple class="hidden" onchange={(e) => uploadFiles((e.target as HTMLInputElement).files)} />
    </label>
  </div>

  <div class="flex items-center gap-1 text-sm flex-wrap">
    {#if path !== '/'}<button class="btn btn-ghost btn-xs btn-square" onclick={up}><ArrowLeft size={14} /></button>{/if}
    <button class="link link-hover text-sm" onclick={() => navigate('/')}>Root</button>
    {#each pathParts(path) as part, idx (idx)}
      <ChevronRight size={12} class="text-base-content/40" />
      <button class="link link-hover text-sm" onclick={() => navigate('/' + pathParts(path).slice(0, idx + 1).join('/'))}>{part}</button>
    {/each}
  </div>

  <div
    class="card bg-base-200 border-2 {dragOver ? 'border-primary' : 'border-base-300'} transition-colors"
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => (dragOver = false)}
    ondrop={(e) => { e.preventDefault(); dragOver = false; uploadFiles(e.dataTransfer?.files ?? null); }}
  >
    {#if entries.length === 0}
      <div class="card-body items-center py-12 text-base-content/50 text-sm">
        <Folder size={40} class="mb-2 opacity-30" />
        Empty folder. Drag files here or click Upload.
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th></th><th>Name</th><th class="text-right">Size</th><th>Modified</th><th></th></tr></thead>
          <tbody>
            {#each entries as e (e.id ?? e.name)}
              <tr class="hover">
                <td class="w-8">{#if isFolder(e)}<Folder size={15} class="text-warning" />{:else}<FileText size={15} class="text-base-content/50" />{/if}</td>
                <td>
                  {#if isFolder(e)}
                    <button class="link link-hover text-sm" onclick={() => navigate(`${path === '/' ? '' : path}/${e.name}`)}>{e.name}</button>
                  {:else}
                    <a class="link link-hover text-sm" href="{ENGINE_URL}/api/cloud/files/{e.id ?? encodeURIComponent(e.path)}/download" target="_blank">{e.name}</a>
                  {/if}
                </td>
                <td class="text-right text-xs">{isFolder(e) ? '—' : fmtBytes(Number(e.size_bytes ?? e.size ?? 0))}</td>
                <td class="text-xs text-base-content/60">{e.updated_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                <td>
                  <div class="flex gap-1">
                    {#if !isFolder(e)}<button class="btn btn-ghost btn-xs btn-square" title="Share" onclick={() => makeShare(e)}><Share2 size={12} /></button>{/if}
                    <button class="btn btn-ghost btn-xs btn-square text-error" title="Delete" onclick={() => deleteEntry(e)}><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

{#if showShareDialog}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">Share {selected?.name}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showShareDialog = false)}><X size={14} /></button></div>
      {#if !shareUrl}
        <div class="space-y-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Expires (hours)</span></label><input type="number" class="input input-sm" bind:value={shareForm.expires_in_hours} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Password (optional)</span></label><input type="password" class="input input-sm" bind:value={shareForm.password} /></div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" onclick={() => (showShareDialog = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm gap-1" onclick={createShare}><Share2 size={13} /> Generate link</button>
        </div>
      {:else}
        <div class="space-y-3">
          <p class="text-sm">Link valid for {shareForm.expires_in_hours}h{shareForm.password ? ' (password required)' : ''}:</p>
          <input class="input input-sm w-full font-mono text-xs" value={shareUrl} readonly onclick={(e) => (e.target as HTMLInputElement).select()} />
        </div>
        <div class="modal-action">
          <button class="btn btn-primary btn-sm" onclick={() => { navigator.clipboard?.writeText(shareUrl); showShareDialog = false; }}>Copy & close</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
