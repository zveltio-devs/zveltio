<script lang="ts">
/**
 * SDUI detail layout — one record by route param, with tabs for field cards,
 * genealogy trees, nested tables, and inline forms (consume / HACCP).
 */
import { onMount } from 'svelte';
import { base } from '$app/paths';
import { api } from '$lib/api.js';
import { ENGINE_URL } from '$lib/config.js';
import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { fmtDate } from '$lib/stores/format.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import { ArrowLeft, LoaderCircle, Download, CheckCircle, Play } from '@lucide/svelte';
import type { ActionDef, DetailPanel, FieldDef, ResourceView } from './types.js';

let {
  resource,
  routeParams = {},
  extName = '',
}: {
  resource: ResourceView;
  routeParams?: Record<string, string>;
  extName?: string;
} = $props();

const d = $derived(resource.detail!);
const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

function t(s?: string): string {
  if (!s) return '';
  const fn = (m as Record<string, (() => string) | undefined>)[s];
  return typeof fn === 'function' ? fn() : s;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any
function getPath(obj: any, path?: string): any {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function fill(tmpl: string, row: Record<string, unknown> = routeParams): string {
  return tmpl.replace(/\{([^}]+)\}/g, (_, k) => String(getPath(row, k.trim()) ?? ''));
}

function guardMutation(url: string): boolean {
  if (!extName || url.startsWith(`/ext/${extName}/`) || url === `/ext/${extName}`) return true;
  toast.error(t('ext.saveFailed'));
  return false;
}

// biome-ignore lint/suspicious/noExplicitAny: record is schema-shaped
let record = $state<Record<string, any> | null>(null);
let loading = $state(true);
let notFound = $state(false);
let panelId = $state('');
// biome-ignore lint/suspicious/noExplicitAny: panel caches
let panelData = $state<Record<string, any>>({});
let panelLoading = $state<Record<string, boolean>>({});
// biome-ignore lint/suspicious/noExplicitAny: form drafts
let formDrafts = $state<Record<string, Record<string, any>>>({});
let formSaving = $state<Record<string, boolean>>({});
let relationOpts = $state<Record<string, { value: string; label: string }[]>>({});

onMount(() => {
  panelId = d.panels[0]?.id ?? '';
  void load();
});

async function load() {
  loading = true;
  notFound = false;
  try {
    const res = await api.get(fill(d.loadEndpoint));
    record = getPath(res, d.loadPath) ?? res;
    panelData = {};
  } catch {
    notFound = true;
  } finally {
    loading = false;
  }
}

function visibleAction(a: ActionDef): boolean {
  if (!record || !a.visibleWhen) return true;
  const v = getPath(record, a.visibleWhen.field);
  if (a.visibleWhen.equals !== undefined) return v === a.visibleWhen.equals;
  if (a.visibleWhen.in) return a.visibleWhen.in.includes(String(v));
  return true;
}

function visiblePanelForm(p: DetailPanel): boolean {
  if (!record || !p.form?.visibleWhen) return true;
  const w = p.form.visibleWhen;
  const v = getPath(record, w.field);
  if (w.equals !== undefined) return v === w.equals;
  if (w.in) return w.in.includes(String(v));
  return true;
}

async function selectPanel(id: string) {
  panelId = id;
  const p = d.panels.find((x) => x.id === id);
  if (!p) return;
  if ((p.kind === 'tree' || p.kind === 'table') && p.dataSource && panelData[id] === undefined) {
    panelLoading[id] = true;
    try {
      const res = await api.get(fill(p.dataSource));
      panelData[id] = getPath(res, p.dataPath) ?? res;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
      panelData[id] = p.kind === 'tree' ? null : [];
    } finally {
      panelLoading[id] = false;
    }
  }
  if (p.kind === 'form' && p.form && !formDrafts[id]) {
    const draft: Record<string, unknown> = {};
    for (const f of p.form.fields ?? []) {
      draft[f.name] = f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '');
    }
    formDrafts[id] = draft;
    void loadRelations(p.form.fields ?? []);
  }
}

async function loadRelations(fields: FieldDef[]) {
  for (const f of fields) {
    if (f.type !== 'relation' || !f.relation || relationOpts[f.name]) continue;
    try {
      const res = await api.get(f.relation.dataSource);
      const list = getPath(res, f.relation.dataPath) ?? [];
      const vk = f.relation.valueKey ?? 'id';
      const lk = f.relation.labelKey;
      relationOpts[f.name] = (Array.isArray(list) ? list : []).map(
        (it: Record<string, unknown>) => ({
          value: String(getPath(it, vk)),
          label: Array.isArray(lk)
            ? lk
                .map((k) => getPath(it, k))
                .filter(Boolean)
                .join(' ')
            : String(getPath(it, lk) ?? ''),
        }),
      );
    } catch {
      relationOpts[f.name] = [];
    }
  }
}

function runHeaderAction(a: ActionDef) {
  if (!record) return;
  if (a.kind === 'download') {
    window.open(`${ENGINE_URL}${fill(a.endpoint ?? '', record)}`, '_blank');
    return;
  }
  const go = async () => {
    const url = fill(a.endpoint ?? '', record!);
    if (!guardMutation(url)) return;
    try {
      if (a.method === 'DELETE') await api.delete(url);
      else if (a.method === 'PATCH') await api.patch(url, {});
      else await api.post(url, {});
      toast.success(t('ext.saved'));
      await load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
    }
  };
  if (a.confirm) askConfirm(t(a.confirm), go);
  else void go();
}

async function submitPanelForm(p: DetailPanel) {
  if (!p.form || !record) return;
  const id = p.id;
  formSaving[id] = true;
  try {
    const url = fill(p.form.endpoint, record);
    if (!guardMutation(url)) return;
    const body: Record<string, unknown> = { ...(formDrafts[id] ?? {}) };
    const wrap = (p.form as { bodyWrap?: string }).bodyWrap;
    const payload = wrap ? { [wrap]: body } : body;
    const method = p.form.method ?? 'POST';
    if (method === 'PATCH') await api.patch(url, payload);
    else await api.post(url, payload);
    toast.success(t('ext.saved'));
    await load();
    // refresh sibling tables
    for (const sib of d.panels) {
      if (sib.kind === 'table' && sib.dataSource) {
        delete panelData[sib.id];
      }
    }
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  } finally {
    formSaving[id] = false;
  }
}

function renderNode(node: unknown, childrenKey: string, tmpl: string, depth = 0): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  const indent = '  '.repeat(depth);
  const line = tmpl.replace(/\{([^}]+)\}/g, (_, k) => String(getPath(n, k.trim()) ?? '?'));
  const kids = (getPath(n, childrenKey) as unknown[]) ?? [];
  const childLines = kids.map((c) => renderNode(c, childrenKey, tmpl, depth + 1)).filter(Boolean);
  return childLines.length ? `${indent}${line}\n${childLines.join('\n')}` : `${indent}${line}`;
}

function cell(row: Record<string, unknown>, key: string, type?: string): string {
  const v = getPath(row, key);
  if (v == null || v === '') return '—';
  if (type === 'date') return fmtDate(String(v));
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const title = $derived(
  record ? String(getPath(record, d.titleKey ?? 'name') ?? t(resource.label)) : t(resource.label),
);
const subtitle = $derived(
  record && d.subtitleKey ? String(getPath(record, d.subtitleKey) ?? '') : '',
);
const badgeVal = $derived(record && d.badgeKey ? String(getPath(record, d.badgeKey) ?? '') : '');
const badgeClass = $derived(
  badgeVal && d.badge?.colors?.[badgeVal] ? d.badge.colors[badgeVal] : 'badge-ghost',
);
const activePanel = $derived(d.panels.find((p) => p.id === panelId));
</script>

<ExtensionPageShell {title} {subtitle}>
  <div class="flex items-center gap-2 mb-4 flex-wrap">
    {#if d.backHref}
      <a href="{base}{d.backHref}" class="btn btn-ghost btn-sm gap-1">
        <ArrowLeft size={14} />
        {t(d.backLabel) || t('common.back')}
      </a>
    {/if}
    {#if badgeVal}
      <span class="badge {badgeClass}">{badgeVal}</span>
    {/if}
    <div class="flex-1"></div>
    {#each d.actions ?? [] as a}
      {#if visibleAction(a)}
        <button type="button" class="btn btn-sm {a.variant ?? 'btn-outline'} gap-1" onclick={() => runHeaderAction(a)}>
          {#if a.kind === 'download'}<Download size={14} />
          {:else if a.icon === 'CheckCircle'}<CheckCircle size={14} />
          {:else if a.icon === 'Play'}<Play size={14} />{/if}
          {t(a.label)}
        </button>
      {/if}
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if notFound || !record}
    <div class="card bg-base-200"><div class="card-body items-center py-16 text-sm text-base-content/50">{t('common.notFound')}</div></div>
  {:else}
    <div class="tabs tabs-boxed bg-base-200 w-fit mb-4 flex-wrap">
      {#each d.panels as p}
        {#if p.kind !== 'form' || visiblePanelForm(p)}
          <button
            type="button"
            class="tab"
            class:tab-active={panelId === p.id}
            onclick={() => selectPanel(p.id)}
          >
            {t(p.label)}
          </button>
        {/if}
      {/each}
    </div>

    {#if activePanel?.kind === 'fields'}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {#each activePanel.fields ?? [] as f}
          <div class="card bg-base-200">
            <div class="card-body py-3 gap-1">
              <p class="text-xs text-base-content/50">{t(f.label)}</p>
              <p class="text-sm font-medium {f.type === 'mono' ? 'font-mono' : ''}">
                {cell(record, f.key, f.type)}
              </p>
            </div>
          </div>
        {/each}
      </div>
    {:else if activePanel?.kind === 'tree'}
      {#if panelLoading[activePanel.id]}
        <div class="flex justify-center py-12"><LoaderCircle size={24} class="animate-spin text-primary" /></div>
      {:else}
        <pre class="bg-base-200 rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap">{renderNode(
            panelData[activePanel.id],
            activePanel.childrenKey ?? 'inputs',
            activePanel.nodeTemplate ?? '{item_name} — {lot_number} [{status}]',
          ) || '—'}</pre>
      {/if}
    {:else if activePanel?.kind === 'table'}
      {#if panelLoading[activePanel.id]}
        <div class="flex justify-center py-12"><LoaderCircle size={24} class="animate-spin text-primary" /></div>
      {:else}
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                {#each activePanel.columns ?? [] as c}<th>{t(c.label)}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each (Array.isArray(panelData[activePanel.id]) ? panelData[activePanel.id] : []) as row, i (row.id ?? i)}
                <tr class="hover">
                  {#each activePanel.columns ?? [] as c}
                    <td class={c.type === 'mono' ? 'font-mono text-xs' : 'text-xs'}>{cell(row, c.key, c.type)}</td>
                  {/each}
                </tr>
              {:else}
                <tr><td colspan={(activePanel.columns ?? []).length} class="text-center text-base-content/40 py-8">{t('common.noResults')}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if activePanel?.kind === 'form' && activePanel.form && visiblePanelForm(activePanel)}
      <div class="card bg-base-200 max-w-xl">
        <div class="card-body gap-3">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            {#each activePanel.form.fields ?? [] as f}
              {#if f.type === 'boolean'}
                <label class="flex items-center gap-2 md:col-span-2">
                  <input type="checkbox" class="toggle toggle-sm" bind:checked={formDrafts[activePanel.id][f.name]} />
                  <span class="text-xs">{t(f.label)}</span>
                </label>
              {:else if f.type === 'relation' || f.type === 'select'}
                <label class="form-control" class:md:col-span-2={f.colSpan === 2}>
                  <span class="label-text text-xs">{t(f.label)}</span>
                  <select class="select select-sm select-bordered" bind:value={formDrafts[activePanel.id][f.name]}>
                    <option value="">—</option>
                    {#each (f.type === 'relation' ? (relationOpts[f.name] ?? []) : (f.options ?? [])) as o}
                      <option value={o.value}>{t(o.label) || o.value}</option>
                    {/each}
                  </select>
                </label>
              {:else if f.type === 'textarea'}
                <label class="form-control md:col-span-2">
                  <span class="label-text text-xs">{t(f.label)}</span>
                  <textarea class="textarea textarea-sm textarea-bordered" bind:value={formDrafts[activePanel.id][f.name]}></textarea>
                </label>
              {:else}
                <label class="form-control" class:md:col-span-2={f.colSpan === 2}>
                  <span class="label-text text-xs">{t(f.label)}</span>
                  <input
                    class="input input-sm input-bordered"
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                    bind:value={formDrafts[activePanel.id][f.name]}
                  />
                </label>
              {/if}
            {/each}
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm w-fit"
            disabled={formSaving[activePanel.id]}
            onclick={() => submitPanelForm(activePanel)}
          >
            {#if formSaving[activePanel.id]}<LoaderCircle size={14} class="animate-spin" />{/if}
            {t(activePanel.form.submitLabel) || t('common.save')}
          </button>
        </div>
      </div>
    {/if}
  {/if}

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
