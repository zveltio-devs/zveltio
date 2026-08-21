<script lang="ts">
/**
 * SDUI builder layout — meta fields + ordered item collection (+ optional
 * secondary panel). Driven entirely by ResourceView.builder; no per-extension
 * code. Ported from the forms field editor / responses screens.
 */
import { onMount } from 'svelte';
import { base } from '$app/paths';
import { page } from '$app/state';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  LoaderCircle,
  Inbox,
  ChevronUp,
  ChevronDown,
} from '@lucide/svelte';
import type { FieldDef, ResourceView } from './types.js';

let {
  resource,
  routeParams = {},
  extName = '',
}: {
  resource: ResourceView;
  routeParams?: Record<string, string>;
  extName?: string;
} = $props();

const b = $derived(resource.builder!);

function t(s?: string): string {
  if (!s) return '';
  const fn = (m as Record<string, (() => string) | undefined>)[s];
  return typeof fn === 'function' ? fn() : s;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function getPath(obj: any, path?: string): any {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function fill(tmpl: string): string {
  return tmpl.replace(/\{([^}]+)\}/g, (_, k) => String(routeParams[k.trim()] ?? ''));
}

function guardMutation(url: string): boolean {
  if (!extName || url.startsWith(`/ext/${extName}/`) || url === `/ext/${extName}`) return true;
  toast.error(t('ext.saveFailed'));
  return false;
}

// biome-ignore lint/suspicious/noExplicitAny: builder draft is schema-shaped JSON
let draft = $state<Record<string, any> | null>(null);
let loading = $state(true);
let saving = $state(false);
let notFound = $state(false);
let panel = $state<'edit' | string>('edit');

// biome-ignore lint/suspicious/noExplicitAny: submissions rows
let secondaryRows = $state<any[]>([]);
let answerFields = $state<{ id: string; label: string }[]>([]);
let secondaryLoading = $state(false);

const collKey = $derived(b.collection.key);
const idKey = $derived(b.collection.idKey ?? 'id');

onMount(() => {
  const panelQ = page.url.searchParams.get('panel');
  if (panelQ && b.secondary?.id === panelQ) {
    panel = panelQ;
    void load().then(() => loadSecondary());
  } else {
    void load();
  }
});

async function load() {
  loading = true;
  notFound = false;
  try {
    const res = await api.get(fill(b.loadEndpoint));
    let record = getPath(res, b.loadPath) ?? res;
    if (typeof record?.[collKey] === 'string') {
      try {
        record = { ...record, [collKey]: JSON.parse(record[collKey]) };
      } catch {
        record = { ...record, [collKey]: [] };
      }
    }
    if (!Array.isArray(record?.[collKey])) {
      record = { ...record, [collKey]: record?.[collKey] ?? [] };
    }
    draft = structuredClone(record);
  } catch (e: unknown) {
    notFound = true;
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  } finally {
    loading = false;
  }
}

async function loadSecondary() {
  const sec = b.secondary;
  if (!sec) return;
  secondaryLoading = true;
  try {
    const res = await api.get(fill(sec.dataSource));
    secondaryRows = getPath(res, sec.dataPath) ?? [];
    const raw = getPath(res, sec.answerLabelsFrom);
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    answerFields = Array.isArray(list) ? list : [];
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  } finally {
    secondaryLoading = false;
  }
}

async function selectPanel(id: string) {
  panel = id;
  if (id !== 'edit' && b.secondary?.id === id) await loadSecondary();
}

function addItem() {
  if (!draft) return;
  const item: Record<string, unknown> = { [idKey]: crypto.randomUUID() };
  for (const f of b.collection.itemFields) {
    if (f.type === 'boolean') item[f.name] = f.default ?? false;
    else if (f.type === 'select' && f.options?.[0]) item[f.name] = f.options[0].value;
    else item[f.name] = f.default ?? (f.type === 'number' ? 0 : '');
  }
  draft[collKey] = [...(draft[collKey] ?? []), item];
}

function removeItem(idx: number) {
  if (!draft) return;
  draft[collKey] = draft[collKey].filter((_: unknown, i: number) => i !== idx);
}

function moveItem(idx: number, dir: -1 | 1) {
  if (!draft) return;
  const arr = [...draft[collKey]];
  const j = idx + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  draft[collKey] = arr;
}

function optionsText(item: Record<string, unknown>): string {
  const name = b.collection.optionsField?.name;
  if (!name) return '';
  const v = item[name];
  return Array.isArray(v) ? v.join(', ') : '';
}

function setOptions(idx: number, value: string) {
  if (!draft) return;
  const name = b.collection.optionsField!.name;
  const opts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  draft[collKey] = draft[collKey].map((it: Record<string, unknown>, i: number) =>
    i === idx ? { ...it, [name]: opts } : it,
  );
}

function takesOptions(item: Record<string, unknown>): boolean {
  const of = b.collection.optionsField;
  if (!of) return false;
  const v = String(item[of.visibleWhen.field] ?? '');
  return of.visibleWhen.in.includes(v);
}

async function save() {
  if (!draft) return;
  saving = true;
  try {
    const url = fill(b.saveEndpoint);
    if (!guardMutation(url)) return;
    const of = b.collection.optionsField;
    const items = (draft[collKey] ?? []).map((it: Record<string, unknown>) => {
      const out: Record<string, unknown> = { [idKey]: it[idKey] };
      for (const f of b.collection.itemFields) out[f.name] = it[f.name];
      if (of && takesOptions(it)) {
        const opts = it[of.name];
        if (Array.isArray(opts) && opts.length) out[of.name] = opts;
      }
      return out;
    });
    const body: Record<string, unknown> = { [collKey]: items };
    for (const f of b.fields) {
      body[f.name] = draft[f.name] ?? (f.type === 'boolean' ? false : undefined);
    }
    const method = b.saveMethod ?? 'PATCH';
    if (method === 'PUT') await api.put(url, body);
    else await api.patch(url, body);
    toast.success(t('forms.toast.saved') || t('ext.saved'));
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  } finally {
    saving = false;
  }
}

function fieldInputClass(f: FieldDef, size: 'sm' | 'xs' = 'sm'): string {
  const baseCls = size === 'xs' ? 'input input-xs input-bordered' : 'input input-sm input-bordered';
  return f.mono ? `${baseCls} font-mono` : baseCls;
}

function labelFor(key: string): string {
  return answerFields.find((f) => f.id === key)?.label || key;
}

function answers(row: Record<string, unknown>): Record<string, unknown> {
  const key = b.secondary?.dataKey ?? 'data';
  const d = row[key] as unknown;
  if (typeof d === 'string') {
    try {
      return JSON.parse(d);
    } catch {
      return {};
    }
  }
  return (d as Record<string, unknown>) ?? {};
}

function renderAnswer(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? '✓' : '—';
  return String(v);
}

const title = $derived(
  draft
    ? String(draft.name ?? draft.title ?? t(resource.label) ?? t('forms.title'))
    : t('forms.title'),
);
const subtitle = $derived(draft ? String(draft.slug ?? '') : '');
</script>

<ExtensionPageShell {title} {subtitle}>
  <div class="flex items-center gap-2 mb-4 flex-wrap">
    {#if b.backHref}
      <a href="{base}{b.backHref}" class="btn btn-ghost btn-sm gap-1">
        <ArrowLeft size={14} />
        {t(b.backLabel) || t('forms.btn.back')}
      </a>
    {/if}
    {#if b.secondary}
      <button
        type="button"
        class="btn btn-ghost btn-sm gap-1"
        class:btn-active={panel === b.secondary.id}
        onclick={() => selectPanel(b.secondary!.id)}
      >
        <Inbox size={14} />
        {t(b.secondary.label)}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        class:btn-active={panel === 'edit'}
        onclick={() => selectPanel('edit')}
      >
        {t('forms.btn.builder') || t('common.edit')}
      </button>
    {/if}
    <div class="flex-1"></div>
    {#if draft && panel === 'edit'}
      <button class="btn btn-primary btn-sm gap-1" onclick={save} disabled={saving}>
        {#if saving}<LoaderCircle size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        {t('forms.btn.save') || t('common.save')}
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={28} class="animate-spin text-primary" />
    </div>
  {:else if notFound || !draft}
    <div class="card bg-base-200">
      <div class="card-body items-center text-center py-16">
        <p class="text-sm text-base-content/50">{t('forms.error.notFound')}</p>
      </div>
    </div>
  {:else if panel !== 'edit' && b.secondary}
    {#if secondaryLoading}
      <div class="flex justify-center py-16">
        <LoaderCircle size={28} class="animate-spin text-primary" />
      </div>
    {:else if secondaryRows.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center text-center py-16 gap-3">
          <Inbox size={36} class="text-base-content/20" />
          <p class="text-sm text-base-content/50">{t(b.secondary.emptyLabel)}</p>
        </div>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>{t('forms.col.submittedAt')}</th>
              <th>{t('forms.col.answers')}</th>
            </tr>
          </thead>
          <tbody>
            {#each secondaryRows as r (r.id)}
              <tr class="hover align-top">
                <td class="text-xs whitespace-nowrap">
                  {new Date(String(r[b.secondary.timestampKey ?? 'created_at'] ?? '')).toLocaleString()}
                </td>
                <td>
                  <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    {#each Object.entries(answers(r)) as [k, v]}
                      <dt class="text-base-content/50">{labelFor(k)}</dt>
                      <dd>{renderAnswer(v)}</dd>
                    {/each}
                  </dl>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    <div class="card bg-base-200 mb-4">
      <div class="card-body gap-3">
        <p class="text-xs font-medium text-base-content/70">{t('forms.section.details')}</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each b.fields as f}
            {#if f.type === 'boolean'}
              <label class="flex items-center gap-2 mt-2" class:md:col-span-2={f.colSpan === 2}>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={draft[f.name]} />
                <span class="text-xs">{t(f.label)}</span>
              </label>
            {:else if f.type === 'textarea'}
              <label class="form-control" class:md:col-span-2={f.colSpan !== 1}>
                <span class="label-text text-xs">{t(f.label)}</span>
                <textarea class="textarea textarea-sm textarea-bordered" rows={f.rows ?? 2} bind:value={draft[f.name]}
                ></textarea>
              </label>
            {:else}
              <label class="form-control" class:md:col-span-2={f.colSpan === 2}>
                <span class="label-text text-xs">{t(f.label)}</span>
                <input class={fieldInputClass(f)} bind:value={draft[f.name]} />
              </label>
            {/if}
          {/each}
        </div>
      </div>
    </div>

    <div class="card bg-base-200">
      <div class="card-body gap-3">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-base-content/70">{t('forms.section.fields')}</p>
          <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={addItem}>
            <Plus size={12} />
            {t(b.collection.addLabel)}
          </button>
        </div>

        {#each draft[collKey] as item, idx (item[idKey] ?? idx)}
          <div class="bg-base-100 rounded-lg p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
            {#each b.collection.itemFields as f}
              {#if f.type === 'boolean'}
                <label class="flex items-center gap-1 md:col-span-1 pb-1">
                  <input type="checkbox" class="checkbox checkbox-xs" bind:checked={item[f.name]} />
                  <span class="text-xs">{t(f.label)}</span>
                </label>
              {:else if f.type === 'select'}
                <label class="form-control md:col-span-3">
                  <span class="label-text text-xs">{t(f.label)}</span>
                  <select class="select select-xs select-bordered" bind:value={item[f.name]}>
                    {#each f.options ?? [] as opt}
                      <option value={opt.value}>{t(opt.label) || opt.value}</option>
                    {/each}
                  </select>
                </label>
              {:else}
                <label class="form-control md:col-span-4">
                  <span class="label-text text-xs">{t(f.label)}</span>
                  <input class={fieldInputClass(f, 'xs')} bind:value={item[f.name]} />
                </label>
              {/if}
            {/each}
            <div class="flex gap-0.5 md:col-span-1 justify-end">
              <button type="button" class="btn btn-ghost btn-xs" disabled={idx === 0} onclick={() => moveItem(idx, -1)}>
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                disabled={idx >= draft[collKey].length - 1}
                onclick={() => moveItem(idx, 1)}
              >
                <ChevronDown size={12} />
              </button>
              <button type="button" class="btn btn-ghost btn-xs text-error" onclick={() => removeItem(idx)}>
                <Trash2 size={12} />
              </button>
            </div>

            {#if takesOptions(item)}
              <label class="form-control md:col-span-12">
                <span class="label-text text-xs">{t(b.collection.optionsField?.label) || t('forms.field.options')}</span>
                <input
                  class="input input-xs input-bordered"
                  value={optionsText(item)}
                  oninput={(e) => setOptions(idx, (e.currentTarget as HTMLInputElement).value)}
                />
              </label>
            {/if}
          </div>
        {:else}
          <p class="text-xs text-base-content/40 py-4 text-center">{t(b.collection.emptyLabel)}</p>
        {/each}
      </div>
    </div>
  {/if}
</ExtensionPageShell>
