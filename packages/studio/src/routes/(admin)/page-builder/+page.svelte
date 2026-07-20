<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import {
  Plus,
  Trash2,
  Save,
  LoaderCircle,
  ChevronUp,
  ChevronDown,
  FileText,
  Menu as MenuIcon,
  X,
  ArrowLeft,
} from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

type Block = { type: string; content: Record<string, unknown> };
type Page = {
  id: string;
  title: string;
  slug: string;
  blocks: Block[];
  meta_title: string | null;
  meta_description: string | null;
  og_image: string | null;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  published_at: string | null;
};
type MenuItem = { label: string; slug?: string; url?: string; external?: boolean };

let pages = $state<Page[]>([]);
let loading = $state(true);
let selected = $state<Page | null>(null);
let view = $state<'list' | 'edit' | 'menus'>('list');
let saving = $state(false);
let showNew = $state(false);
let form = $state({ title: '', slug: '' });

// Menus
let menus = $state<{ main: MenuItem[]; footer: MenuItem[] }>({ main: [], footer: [] });
let savingMenu = $state<'main' | 'footer' | null>(null);

const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'html'];

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
function extractError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object')
    return (
      (e as { message?: string; error?: string }).message ??
      (e as { error?: string }).error ??
      'Unknown error'
    );
  return String(e);
}

onMount(load);

async function load() {
  loading = true;
  try {
    const res = await api.get<{ pages: Page[] }>('/ext/content/page-builder/blocks');
    pages = res.pages ?? [];
  } catch (e) {
    toast.error(extractError(e));
  } finally {
    loading = false;
  }
}

async function createPage() {
  if (!form.title.trim() || !form.slug.trim()) return;
  saving = true;
  try {
    const res = await api.post<{ page: Page }>('/ext/content/page-builder/blocks', {
      title: form.title.trim(),
      slug: form.slug.trim(),
      blocks: [],
      status: 'draft',
    });
    pages = [res.page, ...pages];
    form = { title: '', slug: '' };
    showNew = false;
    openEdit(res.page);
  } catch (e) {
    toast.error(extractError(e));
  } finally {
    saving = false;
  }
}

function openEdit(p: Page) {
  selected = JSON.parse(JSON.stringify(p));
  view = 'edit';
}

async function savePage() {
  if (!selected) return;
  saving = true;
  try {
    const res = await api.put<{ page: Page }>(`/ext/content/page-builder/blocks/${selected.id}`, {
      title: selected.title,
      slug: selected.slug,
      blocks: selected.blocks,
      meta_title: selected.meta_title || null,
      meta_description: selected.meta_description || null,
      og_image: selected.og_image || null,
      status: selected.status,
    });
    selected = res.page;
    pages = pages.map((p) => (p.id === res.page.id ? res.page : p));
    toast.success(m['content.pageBuilder.toast.saved']());
  } catch (e) {
    toast.error(extractError(e));
  } finally {
    saving = false;
  }
}

function deletePage(id: string) {
  askConfirm(m['content.pageBuilder.confirmDelete'](), async () => {
    try {
      await api.delete(`/ext/content/page-builder/blocks/${id}`);
      pages = pages.filter((p) => p.id !== id);
      if (selected?.id === id) {
        selected = null;
        view = 'list';
      }
    } catch (e) {
      toast.error(extractError(e));
    }
  });
}

async function toggleStatus() {
  if (!selected) return;
  selected.status = selected.status === 'published' ? 'draft' : 'published';
  await savePage();
}

function addBlock(type: string) {
  if (!selected) return;
  const defaults: Record<string, Record<string, unknown>> = {
    heading: { level: 2, text: 'New heading' },
    text: { html: '<p>Your text here.</p>' },
    image: { src: '', alt: '', width: '100%' },
    button: { label: 'Click me', href: '#', variant: 'primary' },
    divider: {},
    html: { code: '' },
  };
  selected.blocks = [...selected.blocks, { type, content: defaults[type] ?? {} }];
}
function removeBlock(idx: number) {
  if (!selected) return;
  selected.blocks = selected.blocks.filter((_, i) => i !== idx);
}
function moveBlock(idx: number, dir: -1 | 1) {
  if (!selected) return;
  const arr = [...selected.blocks];
  const target = idx + dir;
  if (target < 0 || target >= arr.length) return;
  [arr[idx], arr[target]] = [arr[target], arr[idx]];
  selected.blocks = arr;
}

// ── Menus ──────────────────────────────────────────────────────────────
async function openMenus() {
  view = 'menus';
  try {
    const res = await api.get<{ menus: { main: MenuItem[]; footer: MenuItem[] } }>(
      '/ext/content/page-builder/blocks/menus',
    );
    menus = { main: res.menus?.main ?? [], footer: res.menus?.footer ?? [] };
  } catch (e) {
    toast.error(extractError(e));
  }
}
function addMenuItem(key: 'main' | 'footer') {
  menus[key] = [...menus[key], { label: 'New link', slug: '' }];
}
function removeMenuItem(key: 'main' | 'footer', idx: number) {
  menus[key] = menus[key].filter((_, i) => i !== idx);
}
function moveMenuItem(key: 'main' | 'footer', idx: number, dir: -1 | 1) {
  const arr = [...menus[key]];
  const t = idx + dir;
  if (t < 0 || t >= arr.length) return;
  [arr[idx], arr[t]] = [arr[t], arr[idx]];
  menus[key] = arr;
}
async function saveMenu(key: 'main' | 'footer') {
  savingMenu = key;
  try {
    // Send url only for external items; otherwise slug.
    const items = menus[key].map((i) =>
      i.external
        ? { label: i.label, url: i.url, external: true }
        : { label: i.label, slug: i.slug },
    );
    await api.put(`/ext/content/page-builder/blocks/menus/${key}`, { items });
    toast.success(m['content.pageBuilder.toast.saved']());
  } catch (e) {
    toast.error(extractError(e));
  } finally {
    savingMenu = null;
  }
}
</script>

<ExtensionPageShell title={m['content.page-builder.title']()} subtitle={m['content.page-builder.subtitle']()}>
  {#snippet actions()}
    {#if view === 'list'}
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={openMenus}><MenuIcon size={14} /> {m['content.pageBuilder.menus.title']()}</button>
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showNew = true)}><Plus size={14} /> {m['content.pageBuilder.newPage']()}</button>
    {:else}
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={() => { view = 'list'; selected = null; }}><ArrowLeft size={14} /> {m['common.close']()}</button>
    {/if}
  {/snippet}

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>

  {:else if view === 'list'}
    {#if pages.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">{m['content.pageBuilder.empty.pages']()}</div></div>
    {:else}
      <div class="overflow-x-auto rounded-xl border border-base-300/60 bg-base-100">
        <table class="table table-sm">
          <thead><tr><th>{m['crm.col.title']()}</th><th>{m['content.page-builder.ui.slug']()}</th><th>{m['common.col.status']()}</th><th></th></tr></thead>
          <tbody>
            {#each pages as p (p.id)}
              <tr class="hover">
                <td class="font-medium">{p.title}</td>
                <td class="font-mono text-xs">/{p.slug}</td>
                <td><span class="badge badge-sm {p.status === 'published' ? 'badge-success' : 'badge-ghost'}">{p.status}</span></td>
                <td class="text-right">
                  <button class="btn btn-ghost btn-xs gap-1" onclick={() => openEdit(p)}><FileText size={13} /> {m['common.edit']()}</button>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deletePage(p.id)}><Trash2 size={13} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if view === 'edit' && selected}
    <div class="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
      <!-- Blocks editor -->
      <div class="space-y-3">
        <div class="flex flex-wrap gap-2">
          {#each BLOCK_TYPES as bt}
            <button class="btn btn-outline btn-xs gap-1" onclick={() => addBlock(bt)}><Plus size={11} /> {bt}</button>
          {/each}
        </div>
        {#if selected.blocks.length === 0}
          <div class="card bg-base-200"><div class="card-body items-center py-10 text-base-content/50 text-sm">{m['content.pageBuilder.empty.blocks']()}</div></div>
        {:else}
          {#each selected.blocks as block, idx (idx)}
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-3 gap-2">
                <div class="flex items-center justify-between">
                  <span class="badge badge-neutral badge-sm">{block.type}</span>
                  <div class="flex gap-1">
                    <button class="btn btn-ghost btn-xs" onclick={() => moveBlock(idx, -1)} disabled={idx === 0}><ChevronUp size={13} /></button>
                    <button class="btn btn-ghost btn-xs" onclick={() => moveBlock(idx, 1)} disabled={idx === selected.blocks.length - 1}><ChevronDown size={13} /></button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => removeBlock(idx)}><Trash2 size={13} /></button>
                  </div>
                </div>
                {#if block.type === 'heading'}
                  <div class="flex gap-2">
                    <select class="select select-xs w-20" bind:value={block.content.level}>
                      {#each [1,2,3,4] as l}<option value={l}>H{l}</option>{/each}
                    </select>
                    <input class="input input-xs flex-1" bind:value={block.content.text} placeholder="Heading text" />
                  </div>
                {:else if block.type === 'text'}
                  <textarea class="textarea textarea-xs" rows="3" bind:value={block.content.html} placeholder="<p>…</p>"></textarea>
                {:else if block.type === 'image'}
                  <input class="input input-xs" bind:value={block.content.src} placeholder="Image URL" />
                  <input class="input input-xs" bind:value={block.content.alt} placeholder="Alt text" />
                {:else if block.type === 'button'}
                  <div class="flex gap-2">
                    <input class="input input-xs flex-1" bind:value={block.content.label} placeholder="Label" />
                    <input class="input input-xs flex-1" bind:value={block.content.href} placeholder="href" />
                  </div>
                {:else if block.type === 'html'}
                  <textarea class="textarea textarea-xs font-mono" rows="3" bind:value={block.content.code} placeholder="<div>…</div>"></textarea>
                {:else if block.type === 'divider'}
                  <p class="text-xs text-base-content/40">—</p>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Settings sidebar -->
      <div class="space-y-3">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-3">
            <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">{m['content.page-builder.section.settings']()}</p>
            <label class="form-control gap-1"><span class="label-text text-xs">{m['crm.col.title']()}</span><input class="input input-sm" bind:value={selected.title} /></label>
            <label class="form-control gap-1"><span class="label-text text-xs">{m['content.page-builder.ui.slug']()}</span><input class="input input-sm font-mono" bind:value={selected.slug} /></label>
            <label class="form-control gap-1"><span class="label-text text-xs">{m['content.page-builder.ui.meta_title']()}</span><input class="input input-sm" bind:value={selected.meta_title} /></label>
            <label class="form-control gap-1"><span class="label-text text-xs">{m['content.page-builder.ui.meta_description']()}</span><textarea class="textarea textarea-sm text-xs h-16" bind:value={selected.meta_description}></textarea></label>
            <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pageBuilder.ui.ogImage']()}</span><input class="input input-sm" bind:value={selected.og_image} placeholder="https://…/og.png" /></label>
            <div class="flex items-center gap-2 pt-1">
              <span class="badge badge-sm {selected.status === 'published' ? 'badge-success' : 'badge-ghost'}">{selected.status}</span>
              <button class="btn btn-ghost btn-xs ml-auto" onclick={toggleStatus}>{selected.status === 'published' ? m['content.pageBuilder.unpublish']() : m['common.publish']()}</button>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-sm w-full gap-1" onclick={savePage} disabled={saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{:else}<Save size={14} />{/if} {m['common.save']()}
        </button>
      </div>
    </div>

  {:else if view === 'menus'}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each [['main', m['content.pageBuilder.menus.main']()], ['footer', m['content.pageBuilder.menus.footer']()]] as [key, label] (key)}
        {@const k = key as 'main' | 'footer'}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-2">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold text-sm">{label}</h3>
              <button class="btn btn-ghost btn-xs gap-1" onclick={() => addMenuItem(k)}><Plus size={12} /> {m['content.pageBuilder.menus.addItem']()}</button>
            </div>
            {#each menus[k] as item, idx (idx)}
              <div class="flex items-center gap-1 bg-base-100 rounded p-1.5">
                <input class="input input-xs w-28" bind:value={item.label} placeholder={m['content.pageBuilder.menus.label']()} />
                {#if item.external}
                  <input class="input input-xs flex-1 font-mono" bind:value={item.url} placeholder="https://…" />
                {:else}
                  <input class="input input-xs flex-1 font-mono" bind:value={item.slug} placeholder="slug" />
                {/if}
                <label class="label cursor-pointer gap-1 px-1" title={m['content.pageBuilder.menus.external']()}>
                  <input type="checkbox" class="checkbox checkbox-xs" bind:checked={item.external} />
                  <span class="text-[10px]">{m['content.pageBuilder.menus.external']()}</span>
                </label>
                <button class="btn btn-ghost btn-xs" onclick={() => moveMenuItem(k, idx, -1)} disabled={idx === 0}><ChevronUp size={12} /></button>
                <button class="btn btn-ghost btn-xs" onclick={() => moveMenuItem(k, idx, 1)} disabled={idx === menus[k].length - 1}><ChevronDown size={12} /></button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => removeMenuItem(k, idx)}><X size={12} /></button>
              </div>
            {/each}
            {#if menus[k].length === 0}<p class="text-xs text-base-content/40 py-3 text-center">{m['content.pageBuilder.menus.empty']()}</p>{/if}
            <button class="btn btn-primary btn-xs w-full mt-1 gap-1" onclick={() => saveMenu(k)} disabled={savingMenu === k}>
              {#if savingMenu === k}<LoaderCircle size={12} class="animate-spin" />{:else}<Save size={12} />{/if} {m['common.save']()}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</ExtensionPageShell>

{#if showNew}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">{m['content.pageBuilder.newPage']()}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showNew = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <label class="form-control gap-1"><span class="label-text text-xs">{m['crm.col.title']()}</span>
          <input class="input input-sm" bind:value={form.title} oninput={() => { if (!form.slug) form.slug = slugify(form.title); }} />
        </label>
        <label class="form-control gap-1"><span class="label-text text-xs">{m['content.page-builder.ui.slug']()}</span><input class="input input-sm font-mono" bind:value={form.slug} /></label>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showNew = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.title || !form.slug} onclick={createPage}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}

<ConfirmModal open={confirmState.open} title={confirmState.title} message={confirmState.message}
  confirmLabel={confirmState.confirmLabel} confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction} oncancel={cancelConfirm} />
