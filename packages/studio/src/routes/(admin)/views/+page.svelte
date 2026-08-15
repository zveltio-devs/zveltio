<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api, collectionsApi } from '$lib/api.js';
import { base } from '$app/paths';
import {
  Trash2,
  Layout,
  LayoutGrid,
  Table2,
  Columns3,
  CalendarDays,
  GalleryHorizontal,
  BarChart2,
  Map,
  List,
  Clock,
  LoaderCircle,
  Database,
} from '@lucide/svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import CrudListPage from '$lib/components/common/CrudListPage.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let views = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let collections = $state<any[]>([]);
let loading = $state(true);
let showModal = $state(false);
let creating = $state(false);
let searchQuery = $state('');
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

let form = $state({
  name: '',
  description: '',
  collection: '',
  view_type: 'table',
  page_size: 20,
});

/**
 * `rendered` says whether anything in this product can actually DISPLAY a view of
 * this type. Only three renderers exist — list, card and calendar — and this
 * picker offers eight types, so five of them save a definition that nothing will
 * ever draw. The admin had no way to know which.
 *
 * That is the same untruth M-1 corrected on the other views page: choosing
 * "Kanban board" there fell through to a plain list with nothing to say a
 * renderer was missing. Marking it here is the honest version at the point the
 * choice is made, rather than after saving.
 *
 * Marked, not removed. Which of the two views pages is canonical — this one, or
 * the extension's page behind the 301, which does render three of these — is a
 * product decision, and deleting half a dropdown would pre-empt it.
 */
const VIEW_TYPES = [
  { value: 'table', label: m['views.typeTable'], icon: Table2, rendered: false },
  { value: 'kanban', label: m['views.typeKanban'], icon: Columns3, rendered: false },
  { value: 'calendar', label: m['views.typeCalendar'], icon: CalendarDays, rendered: true },
  { value: 'gallery', label: m['views.typeGallery'], icon: GalleryHorizontal, rendered: false },
  { value: 'stats', label: m['views.typeStats'], icon: BarChart2, rendered: false },
  { value: 'chart', label: m['views.typeChart'], icon: BarChart2, rendered: false },
  { value: 'list', label: m['views.typeList'], icon: List, rendered: true },
  { value: 'timeline', label: m['views.typeTimeline'], icon: Clock, rendered: false },
];

const filtered = $derived(
  searchQuery.trim()
    ? views.filter(
        (v) =>
          v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          v.collection.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : views,
);

onMount(async () => {
  await Promise.all([loadViews(), loadCollections()]);
});

async function loadViews() {
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.get<{ views: any[]; total: number }>('/api/views?limit=200');
    views = res.views ?? [];
  } catch {
    views = [];
  } finally {
    loading = false;
  }
}

async function loadCollections() {
  try {
    const res = await collectionsApi.list();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    collections = (res.collections ?? []).filter((c: any) => !c.is_system);
  } catch {
    collections = [];
  }
}

async function createView() {
  if (!form.name.trim() || !form.collection) return;
  creating = true;
  try {
    await api.post('/api/views', {
      name: form.name.trim(),
      description: form.description || undefined,
      collection: form.collection,
      view_type: form.view_type,
      page_size: form.page_size,
    });
    showModal = false;
    form = { name: '', description: '', collection: '', view_type: 'table', page_size: 20 };
    await loadViews();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message ?? m['views.createFailed']());
  } finally {
    creating = false;
  }
}

async function deleteView(id: string, name: string) {
  confirmState = {
    open: true,
    title: m['views.deleteTitle'](),
    message: m['views.deleteMsg']({ name }),
    confirmLabel: m['common.delete'](),
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/views/${id}`);
        views = views.filter((v) => v.id !== id);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (e: any) {
        toast.error(e.message ?? m['views.deleteFailed']());
      }
    },
  };
}

function viewTypeIcon(type: string) {
  return VIEW_TYPES.find((t) => t.value === type)?.icon ?? Layout;
}
</script>

<CrudListPage
  title={m['nav.views']()}
  subtitle={m['views.subtitle']()}
  count={views.length}
  {loading}
  search={searchQuery}
  onSearchChange={(v) => (searchQuery = v)}
  searchPlaceholder={m['views.filterPh']()}
  actionLabel={m['views.newView']()}
  onAction={() => (showModal = true)}
  empty={{
    illustration: 'spark',
    illustrationColor: 'text-secondary',
    title: m['views.emptyTitle'](),
    description: m['views.emptyDesc'](),
    actionLabel: m['views.createView'](),
    onAction: () => (showModal = true),
  }}
  noSearchMatch={viewsSearchNoMatch}
>
  {#snippet list()}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {#each filtered as v (v.id)}
        {@const TypeIcon = viewTypeIcon(v.view_type)}
        <div class="group card bg-base-200 hover:bg-base-300 transition-colors border border-transparent hover:border-base-300">
          <div class="card-body p-4 gap-3">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <div class="p-1.5 rounded-lg bg-primary/10 shrink-0">
                  <TypeIcon size={14} class="text-primary"/>
                </div>
                <div class="min-w-0">
                  <h3 class="font-semibold text-sm truncate">{v.name}</h3>
                  <p class="text-xs text-base-content/40 font-mono truncate">{v.collection}</p>
                </div>
              </div>
              <button
                class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0"
                onclick={() => deleteView(v.id, v.name)}
                title={m['common.delete']()}
              >
                <Trash2 size={13}/>
              </button>
            </div>

            <div class="flex gap-1.5 flex-wrap">
              <span class="badge badge-outline badge-xs capitalize">{v.view_type}</span>
              <span class="badge badge-ghost badge-xs">{v.page_size ?? 20} {m['views.perPage']()}</span>
              {#if v.is_public}
                <span class="badge badge-success badge-xs">{m['views.publicBadge']()}</span>
              {/if}
            </div>

            {#if v.description}
              <p class="text-xs text-base-content/50 line-clamp-2">{v.description}</p>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/snippet}
</CrudListPage>

{#snippet viewsSearchNoMatch(q: string)}
  <p class="text-center text-sm text-base-content/40 py-8">{m['views.noMatch']({ q })}</p>
{/snippet}

<!-- Create Modal -->
{#if showModal}
  <dialog open aria-modal="true" class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">{m['views.newView']()}</h3>

      <div class="form-control mb-3">
        <label class="label" for="vn"><span class="label-text">{m['common.nameRequired']()}</span></label>
        <input id="vn" type="text" class="input" placeholder={m['views.egRecentOrders']()}
          bind:value={form.name}/>
      </div>

      <div class="form-control mb-3">
        <label class="label" for="vc"><span class="label-text">{m['common.collectionRequired']()}</span></label>
        <select id="vc" class="select" bind:value={form.collection}>
          <option value="">{m['views.selectCollection']()}</option>
          {#each collections as col}
            <option value={col.name}>{col.display_name || col.name}</option>
          {/each}
        </select>
      </div>

      <div class="mb-3">
        <p class="label-text text-sm font-medium mb-2">{m['views.viewType']()}</p>
        <div class="grid grid-cols-4 gap-2">
          {#each VIEW_TYPES as vt}
            {@const VIcon = vt.icon}
            <button
              class="flex flex-col items-center gap-1 p-2 rounded-lg border-2 text-xs transition-all
                     {form.view_type === vt.value ? 'border-primary bg-primary/5 text-primary' : 'border-base-300 bg-base-200 hover:border-primary/40'}"
              onclick={() => (form.view_type = vt.value)}
            >
              <VIcon size={18}/>
              {vt.label()}
            </button>
          {/each}
        </div>
        {#if !VIEW_TYPES.find((t) => t.value === form.view_type)?.rendered}
          <p class="mt-2 text-xs text-warning">{m['views.noRendererYet']()}</p>
        {/if}
      </div>

      <div class="form-control mb-3">
        <label class="label" for="vps"><span class="label-text">{m['views.rowsPerPage']()}</span></label>
        <input id="vps" type="number" class="input" min="5" max="200" bind:value={form.page_size}/>
      </div>

      <div class="form-control mb-4">
        <label class="label" for="vdesc"><span class="label-text">{m['common.col.description']()}</span></label>
        <textarea id="vdesc" class="textarea" rows={2} placeholder={m['zones.optionalDescription']()}
          bind:value={form.description}></textarea>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => { showModal = false; }}>{m['common.cancel']()}</button>
        <button
          class="btn btn-primary gap-1"
          onclick={createView}
          disabled={!form.name.trim() || !form.collection || creating}
        >
          {#if creating}<LoaderCircle size={15} class="animate-spin"/>{/if}
          {m['views.createView']()}
        </button>
      </div>
    </div>
    <div class="modal-backdrop" role="button" tabindex="0" aria-label={m['common.close']()}
      onclick={() => { showModal = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') { showModal = false; } }}></div>
  </dialog>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
