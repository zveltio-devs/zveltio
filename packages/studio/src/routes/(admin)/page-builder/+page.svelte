<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Plus, Trash2, Save, LoaderCircle, Eye, EyeOff, FileText } from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

type Block = { type: string; content: Record<string, unknown> };
type Page = {
  id: string;
  title: string;
  slug: string;
  blocks: Block[];
  meta_title: string | null;
  meta_description: string | null;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

let pages = $state<Page[]>([]);
let loading = $state(true);
let selected = $state<Page | null>(null);
let view = $state<'list' | 'edit'>('list');
let saving = $state(false);
let showNew = $state(false);
let form = $state({ title: '', slug: '' });

const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'html'];

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractError(e: unknown): string {
  if (e instanceof Error) return e.message;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  if (e && typeof e === 'object') return (e as any).message ?? (e as any).error ?? 'Unknown error';
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
  selected = JSON.parse(JSON.stringify(p)); // deep clone
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

async function deletePage(id: string) {
  askConfirm(m['content.pageBuilder.confirmDelete'](), () => deletePageConfirmed(id));
}
async function deletePageConfirmed(id: string) {
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
</script>

<ExtensionPageShell title={m['content.page-builder.title']()} subtitle={m['content.page-builder.subtitle']()}>
<div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-3">
            <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">{m['content.page-builder.section.settings']()}</p>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">{m['crm.col.title']()}</span></label>
              <input type="text" class="input input-sm" bind:value={selected.title}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">{m['content.page-builder.ui.slug']()}</span></label>
              <input type="text" class="input input-sm font-mono" bind:value={selected.slug}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">{m['content.page-builder.ui.meta_title']()}</span></label>
              <input type="text" class="input input-sm" bind:value={selected.meta_title}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">{m['content.page-builder.ui.meta_description']()}</span></label>
              <textarea class="textarea textarea-sm text-xs h-16" bind:value={selected.meta_description}></textarea>
            </div>
            <div class="flex items-center gap-2 pt-1">
              <span class="text-xs text-base-content/60">Status:</span>
              <span class="badge badge-sm {selected.status === 'published' ? 'badge-success' : 'badge-ghost'}">{selected.status}</span>
            </div>
          </div>
        </div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>

