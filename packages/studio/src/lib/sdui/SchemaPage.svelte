<script lang="ts">
import { fmtDate } from '$lib/stores/format.svelte.js';
/**
 * SDUI SPIKE renderer. Interprets a PageSchema with trusted generic host
 * components — no per-extension code. Reuses ExtensionPageShell + ConfirmModal
 * + the shared `api`, exactly like a hand-written extension page would.
 */
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { ENGINE_URL } from '$lib/config.js';
import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import {
  Plus,
  Trash2,
  Send,
  CheckCircle,
  XCircle,
  LoaderCircle,
  Download,
  DollarSign,
  Users,
  Building2,
  TrendingUp,
  FolderOpen,
  Clock,
  Package,
  Warehouse,
  Boxes,
} from '@lucide/svelte';
import type { PageSchema, ResourceView, ColumnDef, ActionDef, FieldDef } from './types.js';

let { schema, extName = '' }: { schema: PageSchema; extName?: string } = $props();

// Defense-in-depth: a declarative page may only MUTATE its own extension's
// /ext/<name>/ routes. The publish validator is the primary gate; this stops a
// hand-edited / tampered on-disk schema from POSTing to core endpoints with the
// admin's cookie. Reads (GET) are not gated here (lower risk + the validator
// already covers them).
function guardMutation(url: string): boolean {
  if (!extName || url.startsWith(`/ext/${extName}/`) || url === `/ext/${extName}`) return true;
  toast.error(t('ext.saveFailed'));
  console.warn(
    `[sdui] blocked mutation to "${url}" — outside extension namespace "/ext/${extName}/"`,
  );
  return false;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
const ICONS: Record<string, any> = {
  Plus,
  Trash2,
  Send,
  CheckCircle,
  XCircle,
  Download,
  DollarSign,
  Users,
  Building2,
  TrendingUp,
  FolderOpen,
  Clock,
  Package,
  Warehouse,
  Boxes,
};
const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

// i18n: try the host bundle, fall back to literal — schemas are i18n-ready.
function t(s?: string): string {
  if (!s) return '';
  const fn = (m as Record<string, (() => string) | undefined>)[s];
  return typeof fn === 'function' ? fn() : s;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function getPath(obj: any, path?: string): any {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
// Relation option/cell label: a single key, or several keys joined (e.g. first+last name).
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function relLabel(it: any, labelKey: string | string[]): string {
  if (Array.isArray(labelKey))
    return labelKey
      .map((k) => it[k])
      .filter(Boolean)
      .join(' ');
  return String(it[labelKey] ?? '');
}

let activeId = $state(schema.resources[0]!.id);
const active = $derived<ResourceView>(
  schema.resources.find((r) => r.id === activeId) ?? schema.resources[0]!,
);
const isTabbed = $derived(schema.resources.length > 1);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let rows = $state<any[]>([]);
let total = $state(0);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let statData = $state<Record<string, any> | null>(null);
let loading = $state(false);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function formatStat(v: any, fmt?: string): string {
  if (v == null) return '—';
  if (fmt === 'currency' || fmt === 'number') return Number(v).toLocaleString();
  return String(v);
}
let page = $state(1);
let search = $state('');
let filterValues = $state<Record<string, string>>({});

// secret-reveal state (form.reveal): value shown exactly once after a create.
let revealValue = $state<string | null>(null);
let revealCopied = $state(false);
async function copyReveal() {
  if (revealValue) {
    await navigator.clipboard.writeText(revealValue).catch(() => undefined);
    revealCopied = true;
    setTimeout(() => (revealCopied = false), 1500);
  }
}

// form state
let showForm = $state(false);
let saving = $state(false);
let editingId = $state<string | null>(null);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let formData = $state<Record<string, any>>({});
// foreign-key / relation select options, loaded lazily per field
let relationOpts = $state<Record<string, { value: string; label: string }[]>>({});

async function loadRelations(r: ResourceView) {
  for (const f of allFields(r)) {
    if (f.type !== 'relation' || !f.relation || relationOpts[f.name]) continue;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const res = await api.get<any>(f.relation.dataSource);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const list = (getPath(res, f.relation.dataPath) ?? []) as any[];
      relationOpts[f.name] = list.map((it) => ({
        value: String(it[f.relation!.valueKey ?? 'id']),
        label: relLabel(it, f.relation!.labelKey),
      }));
    } catch {
      relationOpts[f.name] = [];
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function defaultFor(f: FieldDef): any {
  if (f.default === 'today') return new Date().toISOString().split('T')[0];
  if (f.default !== undefined) return f.default;
  if (f.type === 'boolean') return false;
  if (f.type === 'json') return '{}';
  return f.type === 'number' ? 0 : '';
}
// Conditional form field (e.g. auth_token only when auth_type === 'bearer').
function fieldVisible(f: FieldDef): boolean {
  if (!f.visibleWhen) return true;
  const v = formData[f.visibleWhen.field];
  if (f.visibleWhen.equals !== undefined) return v === f.visibleWhen.equals;
  if (f.visibleWhen.in) return f.visibleWhen.in.includes(v);
  return true;
}
function allFields(r: ResourceView): FieldDef[] {
  const fs = [...(r.form?.fields ?? [])];
  for (const sec of r.form?.sections ?? []) fs.push(...sec.fields);
  return fs;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function blankForm(r: ResourceView): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const d: Record<string, any> = {};
  for (const f of allFields(r)) d[f.name] = defaultFor(f);
  if (r.form?.repeatable) {
    const rep = r.form.repeatable;
    d[rep.name] = [Object.fromEntries(rep.columns.map((c) => [c.name, defaultFor(c)]))];
  }
  return d;
}

// master-detail state
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let masterRows = $state<any[]>([]);
let selectedMasterId = $state<string | null>(null);
const selectedMaster = $derived(
  active.master
    ? (masterRows.find(
        (mr) => String(mr[active.master!.idKey ?? 'id']) === String(selectedMasterId),
      ) ?? null)
    : null,
);

async function loadMasterDetail(r: ResourceView) {
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const mres = await api.get<any>(r.master!.dataSource);
    masterRows = getPath(mres, r.master!.dataPath) ?? [];
    const idKey = r.master!.idKey ?? 'id';
    if (
      selectedMasterId == null ||
      !masterRows.some((mr) => String(mr[idKey]) === String(selectedMasterId))
    )
      selectedMasterId = masterRows[0]?.[idKey] ?? null;
    if (selectedMasterId != null) {
      const durl = r.dataSource.replace('{masterId}', String(selectedMasterId));
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const dres = await api.get<any>(durl);
      rows = getPath(dres, r.dataPath) ?? [];
    } else {
      rows = [];
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  } finally {
    loading = false;
  }
}
async function selectMaster(id: string) {
  selectedMasterId = id;
  const r = active;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const dres = await api.get<any>(r.dataSource.replace('{masterId}', String(id)));
    rows = getPath(dres, r.dataPath) ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  }
}

async function load() {
  const r = active;
  if (r.master) return loadMasterDetail(r);
  loading = true;
  try {
    const qs = new URLSearchParams();
    if (r.search?.param && search) qs.set(r.search.param, search);
    for (const fl of r.filters ?? []) {
      const v = filterValues[fl.param];
      if (v && v !== 'all') qs.set(fl.param, v);
    }
    if (r.pagination) {
      qs.set('page', String(page));
      qs.set('limit', String(r.pagination.limit));
    }
    const url = qs.toString() ? `${r.dataSource}?${qs}` : r.dataSource;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.get<any>(url);
    rows = getPath(res, r.dataPath) ?? [];
    total = r.totalPath ? (getPath(res, r.totalPath) ?? 0) : rows.length;
    loadRelationColumns(r);
    if (r.stats) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const sres = await api.get<any>(r.stats.dataSource);
        statData = getPath(sres, r.stats.dataPath) ?? null;
      } catch {
        statData = null;
      }
    } else {
      statData = null;
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  } finally {
    loading = false;
  }
}

onMount(load);
// reload when the active resource, page, or any filter changes
$effect(() => {
  activeId;
  page;
  JSON.stringify(filterValues);
  load();
});

const clientFiltered = $derived.by(() => {
  const r = active;
  if (r.search?.param || !r.search?.fields || !search) return rows;
  const q = search.toLowerCase();
  return rows.filter((row) =>
    r.search!.fields!.some((f) =>
      String(row[f] ?? '')
        .toLowerCase()
        .includes(q),
    ),
  );
});

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function cellText(row: any, col: ColumnDef): string {
  if (col.template)
    return col.template.replace(/\{([^}]+)\}/g, (_, k) =>
      k.trim() === 'ENGINE_URL' ? ENGINE_URL : String(getPath(row, k.trim()) ?? ''),
    );
  if (col.join)
    return col.join.keys
      .map((k) => row[k])
      .filter(Boolean)
      .join(col.join.sep ?? ' ');
  const v = getPath(row, col.key);
  if (v == null || v === '') return '—';
  if (col.type === 'date') return fmtDate(v);
  if (col.type === 'currency') {
    const code = col.currency?.code ?? (col.currency?.codeKey ? row[col.currency.codeKey] : '');
    return `${Number(v).toLocaleString()} ${code ?? ''}`.trim();
  }
  if (col.type === 'relation') return relColMaps[col.key]?.[String(v)] ?? String(v);
  if (col.type === 'boolean') return v ? '✓' : '—';
  return String(v);
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function badgeClass(row: any, col: ColumnDef): string {
  return col.badge?.colors[getPath(row, col.key)] ?? 'badge-ghost';
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function badgeLabel(row: any, col: ColumnDef): string {
  const v = getPath(row, col.key);
  const mapped = col.badge?.labels?.[v];
  return mapped ? t(mapped) : String(v).replace(/_/g, ' ');
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function actionVisible(row: any, a: ActionDef): boolean {
  if (!a.visibleWhen) return true;
  const v = getPath(row, a.visibleWhen.field);
  if (a.visibleWhen.equals !== undefined) return v === a.visibleWhen.equals;
  if (a.visibleWhen.in) return a.visibleWhen.in.includes(v);
  return true;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const res = await api.get<any>(col.relation.dataSource);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const list = (getPath(res, col.relation.dataPath) ?? []) as any[];
      relColMaps[col.key] = Object.fromEntries(
        list.map((it) => [
          String(it[col.relation!.valueKey ?? 'id']),
          relLabel(it, col.relation!.labelKey),
        ]),
      );
    } catch {
      relColMaps[col.key] = {};
    }
  }
}

// Inline-edit: PATCH/POST a single field when an editable cell changes.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function inlineEdit(row: any, col: ColumnDef, value: string) {
  const e = col.editable!;
  const url = (e.endpoint ?? '').replace(/\{([^}]+)\}/g, (_, k) =>
    String(getPath(row, k.trim()) ?? ''),
  );
  const body = { [e.field ?? col.key]: value };
  if (!guardMutation(url)) return;
  try {
    if (e.method === 'POST') await api.post(url, body);
    else await api.patch(url, body);
    row[col.key] = value;
    toast.success(t('ext.saved'));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err instanceof Error ? err.message : t('ext.saveFailed'));
    await load();
  }
}

// Action request body: "{field}" tokens from the row; "{a-b}" subtracts.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function buildBody(a: ActionDef, row: any): Record<string, any> {
  if (!a.body) return {};
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    .filter((f) => f.required && fieldVisible(f))
    .every((f) => {
      const v = formData[f.name];
      return v !== '' && v != null;
    }),
);

// Build the JSON create/edit payload: parse type:'json' fields string→object,
// drop fields hidden by visibleWhen.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function jsonPayload(): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const out: Record<string, any> = {};
  for (const f of allFields(active)) {
    if (!fieldVisible(f)) continue;
    let v = formData[f.name];
    if (f.type === 'json') {
      try {
        v = JSON.parse(v || '{}');
      } catch {
        throw new Error(`Invalid JSON in ${f.name}`);
      }
    }
    out[f.name] = v;
  }
  // repeatable groups pass through untouched
  for (const rep of active.form?.repeatable ? [active.form.repeatable] : [])
    out[rep.name] = formData[rep.name];
  return out;
}

function openCreate() {
  editingId = null;
  formData = blankForm(active);
  loadRelations(active);
  showForm = true;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function openEdit(row: any) {
  editingId = row.id;
  const d = blankForm(active);
  for (const k of Object.keys(d)) if (row[k] !== undefined) d[k] = row[k];
  formData = d;
  loadRelations(active);
  showForm = true;
}
// Substitute "{id}" and any other "{field}" token in an endpoint from the row.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function fillEndpoint(tmpl: string, row: any): string {
  return tmpl.replace(/\{([^}]+)\}/g, (_, k) => String(getPath(row, k.trim()) ?? ''));
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function runAction(row: any, a: ActionDef) {
  if (a.kind === 'edit') return openEdit(row);
  if (a.kind === 'download') {
    window.open(`${ENGINE_URL}${fillEndpoint(a.endpoint ?? '', row)}`, '_blank');
    return;
  }
  const fire = async () => {
    try {
      const url = (a.endpoint ?? '').replace('{id}', row.id);
      if (!guardMutation(url)) return;
      const body = buildBody(a, row);
      if (a.method === 'DELETE') await api.delete(url);
      else if (a.method === 'PATCH') await api.patch(url, body);
      else await api.post(url, body);
      await load();
      toast.success(t('ext.saved'));
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const list = (formData[c.sumOf.group] as any[]) ?? [];
      formData[c.name] = list.reduce((s, it) => s + Number(it[c.sumOf!.field] || 0), 0);
    }
  }
});
function addRepeatRow() {
  const rep = active.form!.repeatable!;
  formData[rep.name] = [
    ...(formData[rep.name] ?? []),
    Object.fromEntries(rep.columns.map((c) => [c.name, defaultFor(c)])),
  ];
}
function removeRepeatRow(i: number) {
  const rep = active.form!.repeatable!;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  formData[rep.name] = (formData[rep.name] as any[]).filter((_, idx) => idx !== i);
}

// path tokens in a form endpoint template, e.g. "/x/{collection}" → ["collection"]
function endpointTokens(tmpl: string): string[] {
  return [...tmpl.matchAll(/\{([^}]+)\}/g)].map((mt) => mt[1].trim());
}

async function submitForm() {
  const F = active.form!;
  const sub = F.submit?.kind;
  if (!guardMutation(F.endpoint)) return;

  // download: open the GET endpoint (path tokens filled, rest → querystring) in a new tab.
  if (sub === 'download') {
    const tokens = endpointTokens(F.endpoint);
    const url = `${ENGINE_URL}${fillEndpoint(F.endpoint, formData)}`;
    const qs = new URLSearchParams();
    for (const f of allFields(active)) {
      if (tokens.includes(f.name)) continue;
      const v = formData[f.name];
      if (v !== '' && v != null && !(f.type === 'number' && Number(v) === 0))
        qs.set(f.name, String(v));
    }
    window.open(qs.toString() ? `${url}?${qs}` : url, '_blank');
    showForm = false;
    setTimeout(load, 800);
    return;
  }

  saving = true;
  try {
    if (sub === 'upload') {
      // multipart POST: the file field + the other (non-path) fields.
      const tokens = endpointTokens(F.endpoint);
      const fd = new FormData();
      for (const f of allFields(active)) {
        if (tokens.includes(f.name)) continue;
        const v = formData[f.name];
        if (f.type === 'file') {
          if (v) fd.append(f.name, v as File);
        } else if (v !== '' && v != null) fd.append(f.name, String(v));
      }
      const res = await api.fetch(fillEndpoint(F.endpoint, formData), { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    } else if (editingId) {
      await api.patch(`${F.endpoint}/${editingId}`, jsonPayload());
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: response shape is per-extension
      const created = (await api.post(F.endpoint, jsonPayload())) as any;
      if (F.reveal?.key) {
        const v = F.reveal.key.split('.').reduce((a: any, k: string) => a?.[k], created);
        if (typeof v === 'string' && v) revealValue = v;
      }
    }
    showForm = false;
    await load();
    toast.success(t('ext.saved'));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  } finally {
    saving = false;
  }
}

const shellTabs = $derived(
  isTabbed
    ? schema.resources.map((r) => ({
        id: r.id,
        label: t(r.label),
        icon: r.icon ? ICONS[r.icon] : undefined,
      }))
    : undefined,
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

  {#if active.master}
    {@const mkey = active.master.idKey ?? 'id'}
    <div class="grid grid-cols-12 gap-4">
      <aside class="col-span-3">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-2 gap-1">
            {#if masterRows.length === 0}
              <p class="p-3 text-xs text-base-content/50">{t('common.noResults')}</p>
            {:else}
              {#each masterRows as mrow (mrow[mkey])}
                <button
                  class="btn btn-ghost btn-sm h-auto py-2 justify-start {String(mrow[mkey]) === String(selectedMasterId) ? 'btn-active' : ''}"
                  onclick={() => selectMaster(mrow[mkey])}
                >
                  <div class="text-left w-full">
                    <div class="font-medium text-xs">{getPath(mrow, active.master.titleKey)}</div>
                    {#if active.master.subtitle}
                      <div class="text-xs opacity-60">
                        {active.master.subtitle.keys
                          .map((k) => getPath(mrow, k))
                          .filter(Boolean)
                          .join(active.master.subtitle.sep ?? ' ')}
                      </div>
                    {/if}
                    {#if active.master.badgeKey}<span class="badge badge-xs mt-0.5">{getPath(mrow, active.master.badgeKey)}</span>{/if}
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        </div>
      </aside>
      <main class="col-span-9">
        {#if active.detailActions && selectedMaster}
          <div class="flex gap-2 mb-3 justify-end">
            {#each active.detailActions as a}
              {#if actionVisible(selectedMaster, a)}
                <button class="btn btn-outline btn-sm gap-1 {a.variant ?? ''}" onclick={() => runAction(selectedMaster, a)}>
                  {#if a.icon && ICONS[a.icon]}{@const Icon = ICONS[a.icon]}<Icon size={13} />{/if}
                  {t(a.label)}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
        <ExtensionDataPanel {loading} empty={!loading && rows.length === 0} emptyTitle={t('common.noResults')}>
          {#snippet table()}
            <table class="table table-sm">
              <thead><tr>{#each active.columns as col}<th>{t(col.label)}</th>{/each}</tr></thead>
              <tbody>
                {#each rows as row (row.id ?? JSON.stringify(row))}
                  <tr class="hover">
                    {#each active.columns as col}
                      <td class={cellClass(row, col)}>
                        {#if col.type === 'badge'}
                          <span class="badge badge-sm {badgeClass(row, col)}">{badgeLabel(row, col)}</span>
                        {:else}{cellText(row, col)}{/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
        </ExtensionDataPanel>
      </main>
    </div>
  {:else if active.layout === 'cards'}
    {#if loading}
      <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
    {:else if clientFiltered.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">{t('common.noResults')}</div></div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each clientFiltered as row (row.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between">
                <div class="font-medium text-sm">{getPath(row, active.card?.title)}</div>
                {#if active.card?.badge}<span class="badge badge-ghost badge-sm">{getPath(row, active.card.badge)}</span>{/if}
              </div>
              {#if active.card?.subtitle}<div class="text-xs text-base-content/60 font-mono break-all">{getPath(row, active.card.subtitle)}</div>{/if}
              {#if active.rowActions}
                <div class="flex justify-end gap-1">
                  {#each active.rowActions as a}
                    {#if actionVisible(row, a)}
                      <button class="btn btn-ghost btn-xs {a.variant ?? ''}" title={t(a.label)} onclick={() => runAction(row, a)}>
                        {#if a.icon && ICONS[a.icon]}{@const Icon = ICONS[a.icon]}<Icon size={12} />{:else}{t(a.label)}{/if}
                      </button>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
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
                  {#if col.editable}
                    {#if col.editable.options}
                      <select class="select select-xs" value={getPath(row, col.key)}
                        onchange={(e) => inlineEdit(row, col, (e.currentTarget as HTMLSelectElement).value)}>
                        {#each col.editable.options as o}<option value={o.value}>{t(o.label)}</option>{/each}
                      </select>
                    {:else}
                      <input class="input input-xs w-full" value={getPath(row, col.key) ?? ''}
                        onblur={(e) => inlineEdit(row, col, (e.currentTarget as HTMLInputElement).value)} />
                    {/if}
                  {:else if col.type === 'badge'}
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
  {/if}

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

  {#if revealValue && active.form?.reveal}
    <dialog class="modal modal-open">
      <div class="modal-box max-w-xl">
        <h3 class="font-bold text-lg">{t(active.form.reveal.title ?? 'ext.reveal.title')}</h3>
        <p class="text-sm text-warning py-2">{t(active.form.reveal.note ?? 'ext.reveal.note')}</p>
        <div class="flex items-center gap-2">
          <code class="bg-base-200 rounded px-3 py-2 text-sm break-all flex-1 select-all">{revealValue}</code>
          <button class="btn btn-sm btn-primary" onclick={copyReveal}>
            {revealCopied ? t('ext.copied') : t('ext.reveal.copy')}
          </button>
        </div>
        <div class="modal-action">
          <button class="btn btn-sm" onclick={() => (revealValue = null)}>{t('common.close')}</button>
        </div>
      </div>
    </dialog>
  {/if}
</ExtensionPageShell>

{#if showForm && active.form}
  {@const F = active.form}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">{editingId ? t('common.edit') : t(schema.newLabel)}</h3>

      {#snippet fieldInput(f: FieldDef)}
        {#if fieldVisible(f)}
        <div class="form-control {f.colSpan === 2 ? 'col-span-2' : ''}">
          <label class="label py-0"><span class="label-text text-xs">{t(f.label)}{f.required ? ' *' : ''}</span></label>
          {#if f.type === 'select' || f.type === 'relation'}
            <select class="select select-sm" bind:value={formData[f.name]}>
              {#if f.type === 'relation'}<option value="">{t('common.select')}</option>{/if}
              {#each (f.type === 'relation' ? (relationOpts[f.name] ?? []) : (f.options ?? [])) as o}
                <option value={o.value}>{t(o.label)}</option>
              {/each}
            </select>
          {:else if f.type === 'textarea' || f.type === 'json'}
            <textarea
              class="textarea textarea-sm {f.mono || f.type === 'json' ? 'font-mono text-xs' : ''}"
              rows={f.rows ?? 4}
              bind:value={formData[f.name]}
              placeholder={t(f.placeholder)}
            ></textarea>
          {:else if f.type === 'boolean'}
            <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={formData[f.name]} />
          {:else if f.type === 'file'}
            <input type="file" class="file-input file-input-sm file-input-bordered" accept={f.accept}
              onchange={(e) => (formData[f.name] = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
          {:else}
            <input class="input input-sm {f.mono ? 'font-mono' : ''}" type={f.type ?? 'text'} bind:value={formData[f.name]} placeholder={t(f.placeholder)} />
          {/if}
        </div>
        {/if}
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
          {#if saving}<LoaderCircle size={14} class="animate-spin" />{/if}
          {#if F.submit?.kind === 'download'}{t('common.download')}
          {:else if F.submit?.kind === 'upload'}{t('common.upload')}
          {:else}{editingId ? t('common.save') : t('common.create')}{/if}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showForm = false)}></button>
  </dialog>
{/if}
