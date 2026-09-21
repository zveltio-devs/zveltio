<script lang="ts">
/**
 * /admin/templates — pre-built business application templates.
 *
 * Lists every template exposed by GET /api/templates. Clicking a card
 * opens a preview drawer; clicking "Install" enqueues the DDL jobs and
 * polls the collections jobs endpoint until everything is applied.
 *
 * Optional name prefix lets the user install the same template twice
 * (e.g. one CRM for sales, one for partner relations) without colliding.
 */
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { api, collectionsApi, invalidateCollectionsCache } from '$lib/api.js';
import {
  Users,
  Receipt,
  Kanban,
  LifeBuoy,
  Package,
  Sparkles,
  Download,
  ChevronRight,
  X,
  Loader2,
  Check,
} from '@lucide/svelte';
import { toast } from '$lib/stores/toast.svelte.js';

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags?: string[];
  collection_count: number;
  relation_count: number;
}
interface FieldDef {
  name: string;
  type: string;
  required?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  options?: any;
}
interface CollectionDef {
  name: string;
  display_name?: string;
  fields: FieldDef[];
}
interface TemplateFull extends TemplateSummary {
  collections: CollectionDef[];
}

let templates = $state<TemplateSummary[]>([]);
let loading = $state(true);

// Preview drawer state
let openId = $state('');
let preview = $state<TemplateFull | null>(null);
let previewLoading = $state(false);
let prefix = $state('');
let prefixError = $state('');

// Install progress
let installing = $state(false);
let installedCollections = $state<string[]>([]);
let installCompletedCount = $state(0);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
const ICONS: Record<string, any> = {
  Users,
  Receipt,
  Kanban,
  LifeBuoy,
  Package,
};

async function loadList() {
  loading = true;
  try {
    const r = await api.get<{ templates: TemplateSummary[] }>('/api/templates');
    templates = r.templates ?? [];
  } catch (err) {
    // Without this the request rejected into nothing and the page rendered as
    // "no templates" — indistinguishable from an install that has them all.
    toast.error(err instanceof Error ? err.message : m['common.loadFailed']());
  } finally {
    loading = false;
  }
}

async function openPreview(id: string) {
  openId = id;
  preview = null;
  previewLoading = true;
  prefix = '';
  prefixError = '';
  try {
    const r = await api.get<{ template: TemplateFull }>(`/api/templates/${id}`);
    preview = r.template;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (err: any) {
    toast.error(err?.message ?? m['common.loadFailed']());
    openId = '';
  } finally {
    previewLoading = false;
  }
}

function closePreview() {
  if (installing) return; // can't close while installing
  openId = '';
  preview = null;
  installedCollections = [];
  installCompletedCount = 0;
}

function validatePrefix(p: string): string {
  if (!p) return '';
  if (!/^[a-z][a-z0-9_]*$/.test(p)) return m['tpl.prefixInvalid']();
  if (p.length > 20) return m['tpl.prefixTooLong']();
  return '';
}

async function install() {
  if (!preview) return;
  prefixError = validatePrefix(prefix);
  if (prefixError) return;

  installing = true;
  installedCollections = [];
  installCompletedCount = 0;

  try {
    const res = await api.post<{
      installed: { name: string; job_id: string | null; status: 'queued' | 'skipped' }[];
    }>(`/api/templates/${preview.id}/install`, prefix ? { prefix } : {});

    installedCollections = res.installed.map((i) => i.name);
    const queuedJobs = res.installed.filter((i) => i.job_id);

    // Poll job statuses in parallel — each completes within a few seconds
    // once the DDL queue processes it.
    const deadline = Date.now() + 60_000;
    const pending = new Map(queuedJobs.map((j) => [j.job_id!, j.name]));
    // A failed job used to throw inside the per-job try, where the catch that
    // exists to ride out a transient status request swallowed it: the install
    // then polled a dead job for the full minute and reported a timeout
    // instead of the reason the DDL refused.
    let jobFailure: string | null = null;
    while (pending.size > 0 && !jobFailure && Date.now() < deadline) {
      for (const [jobId, name] of pending) {
        try {
          const j = await collectionsApi.jobStatus(jobId);
          // Route returns { job: { status, error, ... } } — see
          // mapJobToPublic in packages/engine/src/lib/ddl-queue.ts.
          const job = j.job as { status?: string; error?: string } | undefined;
          if (job?.status === 'completed') {
            pending.delete(jobId);
            installCompletedCount++;
          } else if (job?.status === 'failed') {
            jobFailure = m['tpl.jobFailed']({
              name,
              error: job.error ?? m['common.unknownError'](),
            });
            break;
          }
        } catch {
          /* status request hiccup — keep polling */
        }
      }
      if (jobFailure) break;
      if (pending.size > 0) await new Promise((r) => setTimeout(r, 500));
    }

    // Count skipped (existing) collections as already-done.
    installCompletedCount += res.installed.filter((i) => i.status === 'skipped').length;

    invalidateCollectionsCache();

    if (jobFailure) {
      toast.error(jobFailure);
    } else if (pending.size === 0) {
      // Collections are applied — seed starter rows so the install is an instant
      // working app, not empty tables. Best-effort: the schema install already
      // succeeded, so a seeding hiccup must not surface as a failure.
      let seeded = 0;
      try {
        const seedRes = await api.post<{ seeded: number }>(
          `/api/templates/${preview.id}/seed`,
          prefix ? { prefix } : {},
        );
        seeded = seedRes.seeded ?? 0;
      } catch {
        /* sample data is optional — keep the success path */
      }
      toast.success(
        seeded
          ? m['tpl.installedOkSeeded']({
              name: preview.name,
              collections: installedCollections.length,
              rows: seeded,
            })
          : m['tpl.installedOk']({ name: preview.name, collections: installedCollections.length }),
      );
      setTimeout(() => goto(`${base}/collections/erd`), 800);
    } else {
      toast.error(m['tpl.timedOut']({ count: pending.size }));
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (err: any) {
    toast.error(err?.message ?? m['common.unexpectedError']());
  } finally {
    installing = false;
  }
}

onMount(() => {
  loadList();
});
</script>

<svelte:head><title>{m['tpl.pageTitle']()}</title></svelte:head>

<div class="max-w-6xl mx-auto p-6">
  <header class="mb-6">
    <div class="flex items-center gap-2 mb-2">
      <Sparkles class="text-primary" size={20} />
      <h1 class="text-2xl font-bold">{m['tpl.title']()}</h1>
    </div>
    <p class="text-sm text-base-content/65 max-w-2xl">
      {m['tpl.intro']()}
    </p>
  </header>

  {#if loading}
    <div class="flex justify-center py-12">
      <Loader2 class="animate-spin text-primary" size={28} />
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each templates as t}
        {@const Icon = (t.icon && ICONS[t.icon]) || Sparkles}
        <button
          class="card bg-base-100 hover:bg-base-300 transition-colors border border-base-300 hover:border-primary text-left"
          onclick={() => openPreview(t.id)}
        >
          <div class="card-body p-5 gap-3">
            <div class="flex items-start justify-between gap-3">
              <div class="p-2.5 rounded-lg bg-primary/10">
                <Icon class="text-primary" size={20} />
              </div>
              <ChevronRight size={16} class="text-base-content/65 mt-2" />
            </div>
            <h3 class="font-semibold text-base">{t.name}</h3>
            <p class="text-xs text-base-content/65 line-clamp-2">{t.description}</p>
            <div class="flex items-center gap-3 mt-1 text-xs text-base-content/65">
              <span>{t.collection_count} collections</span>
              <span>·</span>
              <span>{t.relation_count} relations</span>
            </div>
            {#if t.tags && t.tags.length > 0}
              <div class="flex flex-wrap gap-1.5 mt-1">
                {#each t.tags as tag}
                  <span class="badge badge-sm badge-ghost text-[10px]">{tag}</span>
                {/each}
              </div>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<!-- Preview drawer -->
{#if openId}
  <div
    class="fixed inset-0 z-50 bg-black/50 flex justify-end"
    onclick={(e) => { if (e.target === e.currentTarget) closePreview(); }}
    role="presentation"
  >
    <div class="bg-base-100 w-full max-w-2xl h-full overflow-y-auto shadow-xl flex flex-col" role="dialog" aria-modal="true">
      <header class="p-5 border-b border-base-300 flex items-center justify-between gap-4">
        <div class="min-w-0">
          {#if preview}
            <h2 class="text-lg font-bold">{preview.name}</h2>
            <p class="text-sm text-base-content/65">{preview.description}</p>
          {:else}
            <span class="text-sm text-base-content/65">{m['common.loading']()}</span>
          {/if}
        </div>
        <button class="btn btn-ghost btn-sm" onclick={closePreview} disabled={installing} aria-label={m['common.close']()}>
          <X size={16} />
        </button>
      </header>

      <div class="grow p-5 space-y-5">
        {#if previewLoading || !preview}
          <div class="flex justify-center py-8"><Loader2 class="animate-spin text-primary" /></div>
        {:else}
          <!-- Collections -->
          <section>
            <h3 class="text-sm font-semibold mb-2 text-base-content/70">
              {preview.collections.length} collection{preview.collections.length === 1 ? '' : 's'}
            </h3>
            <div class="space-y-3">
              {#each preview.collections as col}
                <div class="card bg-base-100 border border-base-300">
                  <div class="card-body p-4 gap-2">
                    <div class="flex items-baseline justify-between gap-2">
                      <h4 class="font-semibold text-sm">{col.display_name || col.name}</h4>
                      <span class="text-[11px] font-mono text-base-content/65">{prefix ? `${prefix}_${col.name}` : col.name}</span>
                    </div>
                    <ul class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-base-content/70">
                      {#each col.fields as f}
                        {@const isRel = ['m2o', 'o2m', 'm2m', 'reference'].includes(f.type)}
                        <li class="flex items-center gap-1.5">
                          <span class="font-mono {isRel ? 'text-indigo-400' : ''}">{f.name}</span>
                          <span class="text-base-content/65">·</span>
                          <span class="text-base-content/65">{f.type}</span>
                          {#if f.required}<span class="text-error">*</span>{/if}
                        </li>
                      {/each}
                    </ul>
                  </div>
                </div>
              {/each}
            </div>
          </section>

          <!-- Install options -->
          <section class="border-t border-base-300 pt-5">
            <h3 class="text-sm font-semibold mb-2 text-base-content/70">{m['tpl.installOptions']()}</h3>
            <label class="form-control w-full">
              <div class="label py-1">
                <span class="label-text text-xs">{m['tpl.prefixLabel']()}</span>
                <span class="label-text-alt text-[10px] text-base-content/65">
                  e.g. <code>sales</code> → <code>sales_crm_companies</code>
                </span>
              </div>
              <input
                class="input input-bordered input-sm"
                bind:value={prefix}
                oninput={() => (prefixError = validatePrefix(prefix))}
                placeholder={m['tpl.prefixPh']()}
                disabled={installing}
              />
              {#if prefixError}
                <p class="text-[11px] text-error mt-1">{prefixError}</p>
              {/if}
            </label>
          </section>

          <!-- Install progress -->
          {#if installing || installedCollections.length > 0}
            <section class="border-t border-base-300 pt-5">
              <h3 class="text-sm font-semibold mb-2 text-base-content/70">
                {m['tpl.progress']({ done: installCompletedCount, total: installedCollections.length })}
              </h3>
              <ul class="space-y-1.5">
                {#each installedCollections as name, i}
                  <li class="flex items-center gap-2 text-xs">
                    {#if i < installCompletedCount}
                      <Check size={14} class="text-success" />
                    {:else}
                      <Loader2 size={14} class="animate-spin text-base-content/65" />
                    {/if}
                    <span class="font-mono">{name}</span>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        {/if}
      </div>

      <footer class="border-t border-base-300 p-4 flex items-center gap-2">
        <button class="btn btn-ghost btn-sm" onclick={closePreview} disabled={installing}>
          {installing ? 'Installing…' : 'Cancel'}
        </button>
        <div class="grow"></div>
        <button
          class="btn btn-primary btn-sm gap-1.5"
          onclick={install}
          disabled={!preview || installing || !!prefixError}
        >
          {#if installing}
            <Loader2 class="animate-spin" size={14} /> {m['tpl.installing']()}
          {:else}
            <Download size={14} /> {m['tpl.install']()}
          {/if}
        </button>
      </footer>
    </div>
  </div>
{/if}
