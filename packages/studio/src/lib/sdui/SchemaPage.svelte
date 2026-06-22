<script lang="ts">
  /**
   * SDUI SPIKE renderer. Interprets a PageSchema with trusted generic host
   * components — no per-extension code. Reuses ExtensionPageShell + ConfirmModal
   * + the shared `api`, exactly like a hand-written extension page would.
   */
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { m } from '$lib/i18n.svelte.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import {
    Plus, Trash2, Send, CheckCircle, XCircle, LoaderCircle,
    Users, Building2, TrendingUp, FolderOpen, Clock,
  } from '@lucide/svelte';
  import type { PageSchema, ResourceView, ColumnDef, ActionDef, FieldDef } from './types.js';

  let { schema }: { schema: PageSchema } = $props();

  const ICONS: Record<string, any> = { Plus, Trash2, Send, CheckCircle, XCircle, Users, Building2, TrendingUp, FolderOpen, Clock };
  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  // i18n: try the host bundle, fall back to literal — schemas are i18n-ready.
  function t(s?: string): string {
    if (!s) return '';
    const fn = (m as Record<string, (() => string) | undefined>)[s];
    return typeof fn === 'function' ? fn() : s;
  }
  function getPath(obj: any, path?: string): any {
    if (!path) return obj;
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  let activeId = $state(schema.resources[0]!.id);
  const active = $derived<ResourceView>(schema.resources.find((r) => r.id === activeId) ?? schema.resources[0]!);
  const isTabbed = $derived(schema.resources.length > 1);

  let rows = $state<any[]>([]);
  let total = $state(0);
  let statData = $state<Record<string, any> | null>(null);
  let loading = $state(false);

  function formatStat(v: any, fmt?: string): string {
    if (v == null) return '—';
    if (fmt === 'currency' || fmt === 'number') return Number(v).toLocaleString();
    return String(v);
  }
  let page = $state(1);
  let search = $state('');
  let filterValues = $state<Record<string, string>>({});

  // form state
  let showForm = $state(false);
  let saving = $state(false);
  let editingId = $state<string | null>(null);
  let formData = $state<Record<string, any>>({});
  // foreign-key / relation select options, loaded lazily per field
  let relationOpts = $state<Record<string, { value: string; label: string }[]>>({});

  async function loadRelations(r: ResourceView) {
    for (const f of allFields(r)) {
      if (f.type !== 'relation' || !f.relation || relationOpts[f.name]) continue;
      try {
        const res = await api.get<any>(f.relation.dataSource);
        const list = (getPath(res, f.relation.dataPath) ?? []) as any[];
        relationOpts[f.name] = list.map((it) => ({
          value: String(it[f.relation!.valueKey ?? 'id']),
          label: String(it[f.relation!.labelKey]),
        }));
      } catch {
        relationOpts[f.name] = [];
      }
    }
  }

  function defaultFor(f: FieldDef): any {
    if (f.default === 'today') return new Date().toISOString().split('T')[0];
    if (f.default !== undefined) return f.default;
    return f.type === 'number' ? 0 : '';
  }
  function allFields(r: ResourceView): FieldDef[] {
    const fs = [...(r.form?.fields ?? [])];
    for (const sec of r.form?.sections ?? []) fs.push(...sec.fields);
    return fs;
  }
  function blankForm(r: ResourceView): Record<string, any> {
    const d: Record<string, any> = {};
    for (const f of allFields(r)) d[f.name] = defaultFor(f);
    if (r.form?.repeatable) {
      const rep = r.form.repeatable;
      d[rep.name] = [Object.fromEntries(rep.columns.map((c) => [c.name, defaultFor(c)]))];
    }
    return d;
  }

  async function load() {
    const r = active;
    loading = true;
    try {
      const qs = new URLSearchParams();
      if (r.search?.param && search) qs.set(r.search.param, search);
      for (const fl of r.filters ?? []) {
        const v = filterValues[fl.param];
        if (v && v !== 'all') qs.set(fl.param, v);
      }
      if (r.pagination) { qs.set('page', String(page)); qs.set('limit', String(r.pagination.limit)); }
      const url = qs.toString() ? `${r.dataSource}?${qs}` : r.dataSource;
      const res = await api.get<any>(url);
      rows = getPath(res, r.dataPath) ?? [];
      total = r.totalPath ? (getPath(res, r.totalPath) ?? 0) : rows.length;
      loadRelationColumns(r);
      if (r.stats) {
        try {
          const sres = await api.get<any>(r.stats.dataSource);
          statData = getPath(sres, r.stats.dataPath) ?? null;
        } catch {
          statData = null;
        }
      } else {
        statData = null;
      }
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
    } finally {
      loading = false;
    }
  }

  onMount(load);
  // reload when the active resource, page, or any filter changes
  $effect(() => { activeId; page; JSON.stringify(filterValues); load(); });

  const clientFiltered = $derived.by(() => {
    const r = active;
    if (r.search?.param || !r.search?.fields || !search) return rows;
    const q = search.toLowerCase();
    return rows.filter((row) => r.search!.fields!.some((f) => String(row[f] ?? '').toLowerCase().includes(q)));
  });

  function cellText(row: any, col: ColumnDef): string {
    if (col.join) return col.join.keys.map((k) => row[k]).filter(Boolean).join(col.join.sep ?? ' ');
    const v = getPath(row, col.key);
    if (v == null || v === '') return '—';
    if (col.type === 'date') return new Date(v).toLocaleDateString();
    if (col.type === 'currency') {
      const code = col.currency?.code ?? (col.currency?.codeKey ? row[col.currency.codeKey] : '');
      return `${Number(v).toLocaleString()} ${code ?? ''}`.trim();
    }
    if (col.type === 'relation') return relColMaps[col.key]?.[String(v)] ?? String(v);
    return String(v);
  }
  function badgeClass(row: any, col: ColumnDef): string {
    return col.badge?.colors[getPath(row, col.key)] ?? 'badge-ghost';
  }
  function badgeLabel(row: any, col: ColumnDef): string {
    const v = getPath(row, col.key);
    return col.badge?.labels?.[v] ?? String(v).replace(/_/g, ' ');
  }
  function actionVisible(row: any, a: ActionDef): boolean {
    if (!a.visibleWhen) return true;
    const v = getPath(row, a.visibleWhen.field);
    if (a.visibleWhen.equals !== undefined) return v === a.visibleWhen.equals;
    if (a.visibleWhen.in) return a.visibleWhen.in.includes(v);
    return true;
  }
  function cellClass(row: any, col: ColumnDef): string {
    let cls = col.type === 'mono' ? 'font-mono text-xs' : '';
    for (const c of col.classWhen ?? []) {
      const v = c.field ? getPath(row, c.field) : getPath(row, col.key);
      if ((c.equals !== undefined && v === c.equals) || (c.in && c.in.includes(v))) {
        cls += ` ${c.class}`;
        break;
      }
    }
    return cls.trim();
  }

  // id → label maps for relation COLUMNS (lazy, one fetch per relation column)
  let relColMaps = $state<Record<string, Record<string, string>>>({});
  async function loadRelationColumns(r: ResourceView) {
    for (const col of r.columns) {
      if (col.type !== 'relation' || !col.relation || relColMaps[col.key]) continue;
      try {
        const res = await api.get<any>(col.relation.dataSource);
        const list = (getPath(res, col.relation.dataPath) ?? []) as any[];
        relColMaps[col.key] = Object.fromEntries(
          list.map((it) => [String(it[col.relation!.valueKey ?? 'id']), String(it[col.relation!.labelKey])]),
        );
      } catch {
        relColMaps[col.key] = {};
      }
    }
  }

  // Action request body: "{field}" tokens from the row; "{a-b}" subtracts.
  function buildBody(a: ActionDef, row: any): Record<string, any> {
    if (!a.body) return {};
    const out: Record<string, any> = {};
    for (const [k, tmpl] of Object.entries(a.body)) {
      const mt = /^\{(.+)\}$/.exec(tmpl);
      if (mt) {
        const parts = mt[1].split('-');
        out[k] =
          parts.length === 2
            ? Number(getPath(row, parts[0].trim()) || 0) - Number(getPath(row, parts[1].trim()) || 0)
            : getPath(row, mt[1].trim());
      } else {
        out[k] = tmpl;
      }
    }
    return out;
  }

  // required-field gating for the create/edit form submit
  const formValid = $derived.by(() =>
    allFields(active)
      .filter((f) => f.required)
      .every((f) => {
        const v = formData[f.name];
        return v !== '' && v != null;
      }),
  );

  function openCreate() { editingId = null; formData = blankForm(active); loadRelations(active); showForm = true; }
  function openEdit(row: any) {
    editingId = row.id;
    const d = blankForm(active);
    for (const k of Object.keys(d)) if (row[k] !== undefined) d[k] = row[k];
    formData = d;
    loadRelations(active);
    showForm = true;
  }
  function runAction(row: any, a: ActionDef) {
    if (a.kind === 'edit') return openEdit(row);
    const fire = async () => {
      try {
        const url = (a.endpoint ?? '').replace('{id}', row.id);
        const body = buildBody(a, row);
        if (a.method === 'DELETE') await api.delete(url);
        else if (a.method === 'PATCH') await api.patch(url, body);
        else await api.post(url, body);
        await load();
        toast.success(t('ext.saved'));
      } catch (e: any) {
        toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
      }
    };
    if (a.confirm) askConfirm(t(a.confirm), fire);
    else fire();
  }

  // computed fields (e.g. total weight = sum of goods.weight_kg)
  $effect(() => {
    for (const c of active.form?.computed ?? []) {
      if (c.sumOf) {
        const list = (formData[c.sumOf.group] as any[]) ?? [];
        formData[c.name] = list.reduce((s, it) => s + Number(it[c.sumOf!.field] || 0), 0);
      }
    }
  });
  function addRepeatRow() {
    const rep = active.form!.repeatable!;
    formData[rep.name] = [...(formData[rep.name] ?? []), Object.fromEntries(rep.columns.map((c) => [c.name, defaultFor(c)]))];
  }
  function removeRepeatRow(i: number) {
    const rep = active.form!.repeatable!;
    formData[rep.name] = (formData[rep.name] as any[]).filter((_, idx) => idx !== i);
  }

  async function submitForm() {
    const r = active;
    saving = true;
    try {
      if (editingId) await api.patch(`${r.form!.endpoint}/${editingId}`, formData);
      else await api.post(r.form!.endpoint, formData);
      showForm = false;
      await load();
      toast.success(t('ext.saved'));
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
    } finally {
      saving = false;
    }
  }

  const shellTabs = $derived(
    isTabbed ? schema.resources.map((r) => ({ id: r.id, label: t(r.label), icon: r.icon ? ICONS[r.icon] : undefined })) : undefined,
  );
</script>

<ExtensionPageShell
  title={t(schema.title)}
  subtitle={t(schema.subtitle)}
  tabs={shellTabs}
  activeTab={isTabbed ? activeId : undefined}
  onTabChange={(id: string) => { activeId = id; page = 1; }}
  search={active.search ? search : undefined}
  onSearchChange={active.search ? (v: string) => { search = v; page = 1; if (active.search?.param) load(); } : undefined}
  searchPlaceholder={t(active.search?.placeholder)}
>
  {#snippet actions()}
    {#if active.form}
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={openCreate}>
        <Plus size={14} /> {t(schema.newLabel)}
      </button>
    {/if}
  {/snippet}

  {#if active.filters}
    {#each active.filters as fl}
      <div class="tabs tabs-boxed bg-base-200 w-fit mb-4">
        {#each fl.options as opt}
          <button class="tab {(filterValues[fl.param] ?? 'all') === opt.value ? 'tab-active' : ''}"
            onclick={() => { filterValues = { ...filterValues, [fl.param]: opt.value }; page = 1; }}>
            {t(opt.label)}
          </button>
        {/each}
      </div>
    {/each}
  {/if}

  {#if active.stats && statData}
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      {#each active.stats.cards as card}
        <div class="stat bg-base-200 rounded-xl py-3">
          <div class="stat-title text-xs">{t(card.label)}</div>
          <div class="stat-value text-lg {card.color ?? ''}">{formatStat(statData[card.key], card.format)}</div>
        </div>
      {/each}
    </div>
  {/if}

  <ExtensionDataPanel {loading} empty={!loading && clientFiltered.length === 0} emptyTitle={t('common.noResults')}>
    {#snippet table()}
      <table class="table table-sm">
        <thead>
          <tr>
            {#each active.columns as col}<th>{t(col.label)}</th>{/each}
            {#if active.rowActions}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each clientFiltered as row (row.id)}
            <tr class="hover">
              {#each active.columns as col}
                <td class={cellClass(row, col)}>
                  {#if col.type === 'badge'}
                    <span class="badge badge-sm {badgeClass(row, col)}">{badgeLabel(row, col)}</span>
                  {:else if col.secondary}
                    <div class="font-medium">{cellText(row, col)}</div>
                    {#if row[col.secondary]}<div class="text-xs text-base-content/50">{row[col.secondary]}</div>{/if}
                  {:else}
                    {cellText(row, col)}
                  {/if}
                </td>
              {/each}
              {#if active.rowActions}
                <td>
                  <div class="flex gap-1 justify-end">
                    {#each active.rowActions as a}
                      {#if actionVisible(row, a)}
                        <button class="btn btn-ghost btn-xs {a.variant ?? ''}" title={t(a.label)} onclick={() => runAction(row, a)}>
                          {#if a.icon && ICONS[a.icon]}{@const Icon = ICONS[a.icon]}<Icon size={12} />{:else}{t(a.label)}{/if}
                        </button>
                      {/if}
                    {/each}
                  </div>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/snippet}
  </ExtensionDataPanel>

  {#if active.pagination && total > active.pagination.limit}
    <div class="flex justify-center gap-2 mt-4">
      <button class="btn btn-sm" disabled={page === 1} onclick={() => page--}>{t('common.prev')}</button>
      <span class="btn btn-sm btn-disabled">{page} / {Math.ceil(total / active.pagination.limit) || 1}</span>
      <button class="btn btn-sm" disabled={page * active.pagination.limit >= total} onclick={() => page++}>{t('common.next')}</button>
    </div>
  {/if}

  <ConfirmModal open={confirmState.open} title={confirmState.title} message={confirmState.message}
    confirmLabel={confirmState.confirmLabel} confirmClass={confirmState.confirmClass}
    onconfirm={runConfirmAction} oncancel={cancelConfirm} />
</ExtensionPageShell>

{#if showForm && active.form}
  {@const F = active.form}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">{editingId ? t('common.edit') : t(schema.newLabel)}</h3>

      {#snippet fieldInput(f: FieldDef)}
        <div class="form-control {f.colSpan === 2 ? 'col-span-2' : ''}">
          <label class="label py-0"><span class="label-text text-xs">{t(f.label)}{f.required ? ' *' : ''}</span></label>
          {#if f.type === 'select' || f.type === 'relation'}
            <select class="select select-sm" bind:value={formData[f.name]}>
              {#if f.type === 'relation'}<option value="">{t('common.select')}</option>{/if}
              {#each (f.type === 'relation' ? (relationOpts[f.name] ?? []) : (f.options ?? [])) as o}
                <option value={o.value}>{t(o.label)}</option>
              {/each}
            </select>
          {:else}
            <input class="input input-sm {f.mono ? 'font-mono' : ''}" type={f.type ?? 'text'} bind:value={formData[f.name]} placeholder={t(f.placeholder)} />
          {/if}
        </div>
      {/snippet}

      {#if F.fields}
        <div class="grid grid-cols-2 gap-3 mb-3">
          {#each F.fields as f}{@render fieldInput(f)}{/each}
        </div>
      {/if}

      {#each F.sections ?? [] as sec}
        <div class="card bg-base-200 p-3 mb-3">
          <p class="font-semibold text-sm mb-2">{t(sec.title)}</p>
          <div class="grid grid-cols-2 gap-3">{#each sec.fields as f}{@render fieldInput(f)}{/each}</div>
        </div>
      {/each}

      {#if F.repeatable}
        {@const rep = F.repeatable}
        <div class="mb-3">
          <div class="flex items-center justify-between mb-2">
            <p class="font-semibold text-sm">{t(rep.label)}</p>
            <button class="btn btn-ghost btn-xs" onclick={addRepeatRow}>{t(rep.addLabel)}</button>
          </div>
          <table class="table table-xs">
            <thead><tr>{#each rep.columns as c}<th>{t(c.label)}</th>{/each}<th></th></tr></thead>
            <tbody>
              {#each (formData[rep.name] ?? []) as _, i}
                <tr>
                  {#each rep.columns as c}
                    <td><input class="input input-xs {c.mono ? 'font-mono' : ''}" type={c.type ?? 'text'} bind:value={formData[rep.name][i][c.name]} /></td>
                  {/each}
                  <td>{#if (formData[rep.name]?.length ?? 0) > (rep.min ?? 0)}<button class="btn btn-ghost btn-xs text-error" onclick={() => removeRepeatRow(i)}>✕</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#each F.computed ?? [] as c}
        <p class="text-right text-sm mb-2">{t(c.label)}: <strong class="font-mono">{formData[c.name] ?? 0}</strong></p>
      {/each}

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showForm = false)}>{t('common.cancel')}</button>
        <button class="btn btn-primary" onclick={submitForm} disabled={saving || !formValid}>
          {#if saving}<LoaderCircle size={14} class="animate-spin" />{/if} {editingId ? t('common.save') : t('common.create')}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showForm = false)}></button>
  </dialog>
{/if}
