<script lang="ts">
/**
 * A `file` field: stored files by id (`{ id, name, size, type }`, a list of
 * them with `options.multiple`). Shown as names that open the file through a
 * signed URL as the user; edited by uploading through the file API as the
 * user and removing. A view never carries a file's address.
 */
import { m } from '#lib/i18n.svelte.js';
import { api } from '#lib/api.js';
import { toast } from '#lib/stores/toast.svelte.js';
import { type FileValue, filesOf, openFile } from './engine.js';

interface Props {
  value: unknown;
  /** Editable with this; shown only without it. */
  onchange?: (v: FileValue | FileValue[] | null) => void;
  multiple?: boolean;
  id?: string;
}
const { value, onchange, multiple = false, id }: Props = $props();

const files = $derived(filesOf(value));
let uploading = $state(false);

function set(list: FileValue[]) {
  onchange?.(multiple ? list : (list[list.length - 1] ?? null));
}

async function add(e: Event) {
  const input = e.currentTarget as HTMLInputElement;
  const chosen = Array.from(input.files ?? []);
  input.value = '';
  if (!chosen.length) return;
  uploading = true;
  const added: FileValue[] = [];
  try {
    for (const f of chosen) {
      const form = new FormData();
      form.append('file', f, f.name);
      const { file } = await api.post<{
        file: { id: string; original_name: string; size: number | string; mimetype: string };
      }>('/api/storage/upload', form);
      added.push({
        id: file.id,
        name: file.original_name,
        size: Number(file.size),
        type: file.mimetype,
      });
    }
  } catch (err) {
    toast.error((err as Error).message || m['common.uploadFailed']());
  } finally {
    uploading = false;
    if (added.length) set(multiple ? [...files, ...added] : added);
  }
}

const remove = (fid: string) => set(files.filter((f) => f.id !== fid));
</script>

{#if files.length === 0 && !onchange}
  <span class="text-base-content/40">—</span>
{:else}
  <div class="flex flex-wrap items-center gap-2" data-testid="view-files">
    {#each files as f (f.id)}
      <span class="badge badge-outline gap-1">
        <button
          type="button"
          class="link link-hover"
          onclick={() => openFile(f.id).catch((err: Error) => toast.error(err.message))}
          >{f.name || f.id}</button
        >
        {#if onchange}
          <button
            type="button"
            class="opacity-60 hover:opacity-100"
            aria-label={m['common.remove']()}
            onclick={() => remove(f.id)}>×</button
          >
        {/if}
      </span>
    {/each}
    {#if onchange}
      <label class="btn btn-xs btn-outline">
        {uploading ? m['common.uploading']() : m['common.upload']()}
        <input {id} type="file" class="hidden" {multiple} disabled={uploading} onchange={add} />
      </label>
    {/if}
  </div>
{/if}
