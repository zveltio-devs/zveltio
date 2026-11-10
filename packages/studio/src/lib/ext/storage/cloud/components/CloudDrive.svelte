<script lang="ts">
/**
 * The drive: the engine's stored files, through its own `/api/storage` as the
 * signed-in user — browse by folder, upload, download, delete, share with the
 * firm, quota. What it adds is this extension's: a new version through its
 * route, favorites in `cloud_favorites`. Every refusal is the engine's.
 */
import { onMount } from 'svelte';
import { Download, Folder, FolderPlus, History, Star, Trash2, Upload, Users } from '@lucide/svelte';
import { api } from '#lib/api.js';
import { m } from '#lib/i18n.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';

type StoredFile = { id: string; original_name: string; size: number; visibility: string; updated_at?: string; created_at: string };
type FolderRow = { id: string; name: string; parent_id: string | null };

const t = (key: string, fallback: string) => m[key]?.() ?? fallback;
const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : t('storage.cloud.error', 'Failed'));
const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

let folders = $state<FolderRow[]>([]);
let files = $state<StoredFile[]>([]);
let favorites = $state<Map<string, string>>(new Map()); // file id → favorite row id
let folderId = $state<string | null>(null);
let quota = $state<{ used_bytes: number; quota_bytes: number | null } | null>(null);
let busy = $state(false);
let uploadInput = $state<HTMLInputElement | undefined>();
let versionInput = $state<HTMLInputElement | undefined>();
let versionOf = $state<string | null>(null);

const children = $derived(folders.filter((f) => (f.parent_id ?? null) === folderId));
const trail = $derived.by(() => {
  const out: FolderRow[] = [];
  for (let f = folders.find((x) => x.id === folderId); f; f = folders.find((x) => x.id === f!.parent_id)) out.unshift(f);
  return out;
});

async function load() {
  try {
    const qs = folderId ? `?folder_id=${folderId}&limit=200` : '?limit=200';
    const [fl, fd, fav] = await Promise.all([
      api.get<{ files: StoredFile[] }>(`/api/storage${qs}`),
      api.get<{ folders: FolderRow[] }>('/api/storage/folders'),
      api.get<{ records?: Array<{ id: string; file_id: string }> }>('/api/data/cloud_favorites?limit=500').catch(() => ({ records: [] })),
    ]);
    files = fl.files;
    folders = fd.folders;
    favorites = new Map((fav.records ?? []).map((r) => [r.file_id, r.id]));
  } catch (err) {
    fail(err);
  }
  // An engine without `GET /api/storage/quota` leaves the meter hidden.
  quota = await api.get<{ used_bytes: number; quota_bytes: number | null }>('/api/storage/quota').catch(() => null);
}

async function send(path: string, file: File, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await api.fetch(path, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? body.error ?? `${res.status}`);
  }
}

async function run(fn: () => Promise<unknown>) {
  busy = true;
  try {
    await fn();
    await load();
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
  }
}

const folderField = (): Record<string, string> => (folderId ? { folder_id: folderId } : {});

function upload(list: File[]) {
  if (list.length) run(async () => { for (const f of list) await send('/api/storage/upload', f, folderField()); });
}
function newVersion(file: File | undefined) {
  const id = versionOf;
  if (id && file) run(() => send(`/ext/storage/cloud/files/${id}/versions`, file, folderField()));
}
function newFolder() {
  const name = prompt(t('storage.cloud.folderName', 'Folder name'))?.trim();
  if (name) run(() => api.post('/api/storage/folders', { name, parent_id: folderId }));
}
async function download(f: StoredFile) {
  try {
    const { url } = await api.get<{ url: string }>(`/api/storage/${f.id}/signed-url`);
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    fail(err);
  }
}
function remove(f: StoredFile) {
  if (confirm(t('storage.cloud.confirmDeleteFile', 'Delete this file?'))) run(() => api.delete(`/api/storage/${f.id}`));
}
function share(f: StoredFile) {
  run(() => api.patch(`/api/storage/${f.id}`, { visibility: f.visibility === 'tenant' ? 'personal' : 'tenant' }));
}
function favorite(f: StoredFile) {
  const row = favorites.get(f.id);
  run(() => (row ? api.delete(`/api/data/cloud_favorites/${row}`) : api.post('/api/data/cloud_favorites', { file_id: f.id })));
}

onMount(load);
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <div class="breadcrumbs text-sm flex-1 min-w-0">
      <ul>
        <li><button type="button" class="link" onclick={() => { folderId = null; load(); }}>{t('storage.cloud.root', 'Root')}</button></li>
        {#each trail as f (f.id)}
          <li><button type="button" class="link" onclick={() => { folderId = f.id; load(); }}>{f.name}</button></li>
        {/each}
      </ul>
    </div>
    {#if quota}
      <span class="text-sm opacity-70">
        {size(quota.used_bytes)} / {quota.quota_bytes == null ? t('storage.cloud.unlimited', 'unlimited') : size(quota.quota_bytes)}
      </span>
    {/if}
    <button type="button" class="btn btn-sm" disabled={busy} onclick={newFolder}><FolderPlus size={16} />{t('storage.cloud.newFolder', 'New folder')}</button>
    <button type="button" class="btn btn-sm btn-primary" disabled={busy} onclick={() => uploadInput?.click()}><Upload size={16} />{t('storage.cloud.upload', 'Upload')}</button>
    <input bind:this={uploadInput} type="file" multiple class="hidden" onchange={(e) => { upload(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />
    <input bind:this={versionInput} type="file" class="hidden" onchange={(e) => { newVersion(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
  </div>

  {#if children.length === 0 && files.length === 0}
    <p class="text-center py-8 text-sm opacity-60">{t('storage.cloud.empty.folder', 'Empty folder.')}</p>
  {:else}
    <table class="table table-sm">
      <thead>
        <tr><th>{t('common.col.name', 'Name')}</th><th>{t('storage.cloud.col.size', 'Size')}</th><th>{t('storage.cloud.col.modified', 'Modified')}</th><th></th></tr>
      </thead>
      <tbody>
        {#each children as f (f.id)}
          <tr>
            <td colspan="4"><button type="button" class="link flex items-center gap-2" onclick={() => { folderId = f.id; load(); }}><Folder size={16} />{f.name}</button></td>
          </tr>
        {/each}
        {#each files as f (f.id)}
          <tr>
            <td class="max-w-xs truncate">{f.original_name}{#if f.visibility === 'tenant'} <span class="badge badge-sm">{t('storage.cloud.shared', 'Shared')}</span>{/if}</td>
            <td>{size(f.size)}</td>
            <td>{new Date(f.updated_at ?? f.created_at).toLocaleString()}</td>
            <td class="text-right whitespace-nowrap">
              <button type="button" class="btn btn-xs btn-ghost" title={t('storage.cloud.favorite', 'Favorite')} aria-label={t('storage.cloud.favorite', 'Favorite')} onclick={() => favorite(f)}>
                <Star size={14} fill={favorites.has(f.id) ? 'currentColor' : 'none'} />
              </button>
              <button type="button" class="btn btn-xs btn-ghost" title={t('common.download', 'Download')} aria-label={t('common.download', 'Download')} onclick={() => download(f)}><Download size={14} /></button>
              <button type="button" class="btn btn-xs btn-ghost" title={t('storage.cloud.newVersion', 'New version')} aria-label={t('storage.cloud.newVersion', 'New version')} disabled={busy} onclick={() => { versionOf = f.id; versionInput?.click(); }}><History size={14} /></button>
              <button type="button" class="btn btn-xs btn-ghost" title={t('storage.cloud.share', 'Share with the firm')} aria-label={t('storage.cloud.share', 'Share with the firm')} disabled={busy} onclick={() => share(f)}><Users size={14} /></button>
              <button type="button" class="btn btn-xs btn-ghost text-error" title={t('common.delete', 'Delete')} aria-label={t('common.delete', 'Delete')} disabled={busy} onclick={() => remove(f)}><Trash2 size={14} /></button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
