<script lang="ts">
import { fmtDate } from '$lib/stores/format.svelte.js';
import Modal from '$lib/components/common/Modal.svelte';
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
  Play,
  Factory,
  AlertTriangle,
  FileText,
  Save,
  Pencil,
  Inbox,
  ScanSearch,
} from '@lucide/svelte';
import type { PageSchema, ResourceView, ColumnDef, ActionDef, FieldDef } from './types.js';
import BuilderLayout from './BuilderLayout.svelte';
import DetailLayout from './DetailLayout.svelte';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { page } from '$app/state';

let {
  schema,
  extName = '',
  routeParams = {},
}: {
  schema: PageSchema;
  extName?: string;
  routeParams?: Record<string, string>;
} = $props();

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

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
  Play,
  Factory,
  AlertTriangle,
  FileText,
  Save,
  Pencil,
  Inbox,
  ScanSearch,
};
const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

// i18n: try the host bundle, fall back to literal — schemas are i18n-ready.
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
// Relation option/cell label: a single key, or several keys joined (e.g. first+last name).
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

$effect(() => {
  const tab = page.url.searchParams.get('tab');
  if (!tab) return;
  if (schema.resources.some((r) => r.id === tab)) activeId = tab;
});

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let rows = $state<any[]>([]);
let total = $state(0);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let statData = $state<Record<string, any> | null>(null);
let loading = $state(false);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function formatStat(v: any, fmt?: string): string {
  if (v == null) return '—';
  if (fmt === 'currency' || fmt === 'number') return Number(v).toLocaleString();
  return String(v);
}
let pageNum = $state(1);
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
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let formData = $state<Record<string, any>>({});
// foreign-key / relation select options, loaded lazily per field
let relationOpts = $state<Record<string, { value: string; label: string }[]>>({});
// The records behind those options, kept so `relation.autofill` can copy fields
// off the one that was picked. The dropdown only ever needed a value and a
// label, which is why a relation could store an id and nothing else.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let relationRows = $state<Record<string, Record<string, any>>>({});

async function loadRelations(r: ResourceView) {
  // Top-level/section fields plus repeatable line-item columns (so a line's
  // relation column — e.g. an account picker — gets its dropdown options too).
  const fields = [...allFields(r), ...(r.form?.repeatable?.columns ?? [])];
  for (const f of fields) {
    if (f.type !== 'relation' || !f.relation || relationOpts[f.name]) continue;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const res = await api.get<any>(f.relation.dataSource);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const list = (getPath(res, f.relation.dataPath) ?? []) as any[];
      const key = f.relation.valueKey ?? 'id';
      relationOpts[f.name] = list.map((it) => ({
        value: String(it[key]),
        label: relLabel(it, f.relation!.labelKey),
      }));
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const byId: Record<string, any> = {};
      for (const it of list) byId[String(it[key])] = it;
      relationRows[f.name] = byId;
    } catch {
      relationOpts[f.name] = [];
      relationRows[f.name] = {};
    }
  }
}

/**
 * Copy the picked record's fields into `target`, per `relation.autofill`.
 *
 * Empty targets only. Somebody who has already typed a price meant that price,
 * and a picker that overwrites deliberate edits is worse than one that fills
 * nothing — it makes people distrust every field on the form.
 */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function applyAutofill(f: FieldDef, id: unknown, target: Record<string, any>): void {
  const map = f.relation?.autofill;
  if (!map) return;
  const record = relationRows[f.name]?.[String(id)];
  if (!record) return;
  for (const [field, path] of Object.entries(map)) {
    const current = target[field];
    const untouched = current === undefined || current === null || current === '' || current === 0;
    if (!untouched) continue;
    const value = getPath(record, path);
    if (value !== undefined && value !== null) target[field] = value;
  }
}

// `row` is present only for an action prompt, where a default may be drawn from
// the row the action was fired on — "{total-amount_paid}" pre-fills what is
// still outstanding, so settling an invoice in full stays one click and paying
// part of it means editing the number down.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function defaultFor(f: FieldDef, row?: any): any {
  if (f.default === 'today') return new Date().toISOString().split('T')[0];
  if (row !== undefined && typeof f.default === 'string') return resolveToken(f.default, row);
  if (f.default !== undefined) return f.default;
  if (f.type === 'boolean') return false;
  if (f.type === 'json') return '{}';
  return f.type === 'number' ? 0 : '';
}
// Conditional form field (e.g. auth_token only when auth_type === 'bearer').
// `data` defaults to the create/edit form, but an action prompt renders the
// same fields against its own values — see `promptFor`.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function fieldVisible(f: FieldDef, data: Record<string, any> = formData): boolean {
  if (!f.visibleWhen) return true;
  const v = data[f.visibleWhen.field];
  if (f.visibleWhen.equals !== undefined) return v === f.visibleWhen.equals;
  if (f.visibleWhen.in) return f.visibleWhen.in.includes(v);
  return true;
}

/** GS1 / barcode lookup: POST then map response paths into sibling fields. */
// biome-ignore lint/suspicious/noExplicitAny: form draft bag
async function runLookup(f: FieldDef, data: Record<string, any>) {
  if (!f.lookup) return;
  try {
    const body: Record<string, string> = {};
    if (f.lookup.body) {
      for (const [k, tmpl] of Object.entries(f.lookup.body)) {
        body[k] = tmpl.replace(/\{([^}]+)\}/g, (_, key) => String(data[key.trim()] ?? ''));
      }
    } else {
      body[f.name] = String(data[f.name] ?? '');
    }
    const method = f.lookup.method ?? 'POST';
    const res =
      method === 'GET' ? await api.get(f.lookup.endpoint) : await api.post(f.lookup.endpoint, body);
    for (const [target, path] of Object.entries(f.lookup.map)) {
      const v = getPath(res, path);
      if (v !== undefined && v !== null && v !== '') data[target] = v;
    }
    toast.success(t('ext.saved'));
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  }
}
function allFields(r: ResourceView): FieldDef[] {
  const fs = [...(r.form?.fields ?? [])];
  for (const sec of r.form?.sections ?? []) fs.push(...sec.fields);
  return fs;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function blankForm(r: ResourceView): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  const d: Record<string, any> = {};
  for (const f of allFields(r)) d[f.name] = defaultFor(f);
  if (r.form?.repeatable) {
    const rep = r.form.repeatable;
    d[rep.name] = [Object.fromEntries(rep.columns.map((c) => [c.name, defaultFor(c)]))];
  }
  return d;
}

// master-detail state
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const dres = await api.get<any>(durl);
      rows = getPath(dres, r.dataPath) ?? [];
    } else {
      rows = [];
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const dres = await api.get<any>(r.dataSource.replace('{masterId}', String(id)));
    rows = getPath(dres, r.dataPath) ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  }
}

// ── checklist layout (role × catalog toggles) ───────────────────────────────
type ChecklistItem = { id: string; removable?: boolean; permission?: unknown };
let checklistOptions = $state<string[]>([]);
let checklistCatalog = $state<ChecklistItem[]>([]);
let checklistSelected = $state('');
let checklistDraft = $state<Record<string, boolean>>({});
let checklistConfigured = $state(false);
let checklistSaving = $state(false);

function checklistLabel(id: string): string {
  const prefix = active.checklist?.catalogLabelPrefix;
  if (prefix) {
    const key = `${prefix}.${id}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return id;
}

async function loadChecklist(r: ResourceView) {
  const cl = r.checklist!;
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const cat = await api.get<any>(cl.catalogDataSource);
    const rawCatalog = getPath(cat, cl.catalogPath ?? 'catalog') ?? [];
    const idKey = cl.catalogIdKey ?? 'id';
    checklistCatalog = (Array.isArray(rawCatalog) ? rawCatalog : []).map((w: unknown) =>
      typeof w === 'string'
        ? { id: w, removable: true }
        : {
            id: String((w as Record<string, unknown>)[idKey]),
            removable: (w as Record<string, unknown>).removable !== false,
            permission: (w as Record<string, unknown>).permission,
          },
    );
    const rawOpts = getPath(cat, cl.optionsPath ?? 'roles') ?? [];
    const optKey = cl.optionsIdKey ?? 'id';
    let opts = (Array.isArray(rawOpts) ? rawOpts : []).map((o: unknown) =>
      typeof o === 'string' ? o : String((o as Record<string, unknown>)[optKey]),
    );
    for (const extra of cl.optionsExtra ?? []) if (!opts.includes(extra)) opts.push(extra);
    opts = [...new Set(opts)].sort();
    checklistOptions = opts;
    const pick =
      checklistSelected && opts.includes(checklistSelected)
        ? checklistSelected
        : opts.includes('editor')
          ? 'editor'
          : (opts[0] ?? '');
    if (pick) await selectChecklistOption(pick);
    else {
      checklistDraft = {};
      checklistConfigured = false;
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  } finally {
    loading = false;
  }
}

async function selectChecklistOption(id: string) {
  const cl = active.checklist;
  if (!cl) return;
  checklistSelected = id;
  try {
    const url = fillEndpoint(cl.loadEndpoint, { id });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const res = await api.get<any>(url);
    const selected = new Set((getPath(res, cl.valueKey ?? 'widgets') ?? []) as string[]);
    checklistDraft = Object.fromEntries(checklistCatalog.map((w) => [w.id, selected.has(w.id)]));
    checklistConfigured = Boolean(getPath(res, cl.configuredKey ?? 'configured'));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.loadFailed'));
  }
}

async function saveChecklist() {
  const cl = active.checklist;
  if (!cl || !checklistSelected) return;
  const url = fillEndpoint(cl.saveEndpoint, { id: checklistSelected });
  if (!guardMutation(url)) return;
  checklistSaving = true;
  try {
    const widgets = checklistCatalog.filter((w) => checklistDraft[w.id]).map((w) => w.id);
    const body = { [cl.saveBodyKey ?? 'widgets']: widgets };
    if ((cl.saveMethod ?? 'PUT') === 'PATCH') await api.patch(url, body);
    else await api.put(url, body);
    checklistConfigured = true;
    toast.success(t('ext.saved'));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  } finally {
    checklistSaving = false;
  }
}

const checklistSelectedIds = $derived(
  checklistCatalog.filter((w) => checklistDraft[w.id]).map((w) => w.id),
);

async function load() {
  const r = active;
  if (r.layout === 'builder' && r.builder) return;
  if (r.layout === 'detail' && r.detail) return;
  if (r.layout === 'checklist' && r.checklist) return loadChecklist(r);
  if (r.master) return loadMasterDetail(r);
  loading = true;
  try {
    const qs = new URLSearchParams();
    if (r.search?.param && search) qs.set(r.search.param, search);
    for (const fl of r.filters ?? []) {
      if (fl.type === 'dateRange') {
        const fromP = fl.fromParam ?? 'from';
        const toP = fl.toParam ?? 'to';
        const from = filterValues[fromP];
        const to = filterValues[toP];
        if (fl.required && (!from || !to)) {
          rows = [];
          total = 0;
          return;
        }
        if (from) qs.set(fromP, from);
        if (to) qs.set(toP, to);
      } else if (fl.type === 'date') {
        const p = fl.param ?? 'date';
        const v = filterValues[p];
        if (v) qs.set(p, v);
      } else if (fl.param) {
        const v = filterValues[fl.param];
        if (v && v !== 'all') qs.set(fl.param, v);
      }
    }
    if (r.pagination) {
      qs.set('page', String(pageNum));
      qs.set('limit', String(r.pagination.limit));
    }
    const url = qs.toString() ? `${r.dataSource}?${qs}` : r.dataSource;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const res = await api.get<any>(url);
    rows = getPath(res, r.dataPath) ?? [];
    total = r.totalPath ? (getPath(res, r.totalPath) ?? 0) : rows.length;
    loadRelationColumns(r);
    if (r.stats) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
        const sres = await api.get<any>(r.stats.dataSource);
        statData = getPath(sres, r.stats.dataPath) ?? null;
      } catch {
        statData = null;
      }
    } else {
      statData = null;
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
  pageNum;
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

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
  if (col.type === 'tags') {
    const arr = Array.isArray(v)
      ? v
      : String(v)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    return arr.join(', ') || '—';
  }
  if (col.type === 'link') {
    return String(v);
  }
  return String(v);
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function badgeClass(row: any, col: ColumnDef): string {
  return col.badge?.colors[getPath(row, col.key)] ?? 'badge-ghost';
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function badgeLabel(row: any, col: ColumnDef): string {
  const v = getPath(row, col.key);
  const mapped = col.badge?.labels?.[v];
  return mapped ? t(mapped) : String(v).replace(/_/g, ' ');
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function actionVisible(row: any, a: ActionDef): boolean {
  if (!a.visibleWhen) return true;
  const v = getPath(row, a.visibleWhen.field);
  if (a.visibleWhen.equals !== undefined) return v === a.visibleWhen.equals;
  if (a.visibleWhen.in) return a.visibleWhen.in.includes(v);
  return true;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const res = await api.get<any>(col.relation.dataSource);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    toast.error(err instanceof Error ? err.message : t('ext.saveFailed'));
    await load();
  }
}

// Action request body: "{field}" tokens from the row; "{a-b}" subtracts.
/** "{field}" → the row's value; "{a-b}" → the difference. Anything else is a literal. */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function resolveToken(tmpl: string, row: any): any {
  const mt = /^\{(.+)\}$/.exec(tmpl);
  if (!mt) return tmpl;
  const parts = mt[1].split('-');
  return parts.length === 2
    ? Number(getPath(row, parts[0].trim()) || 0) - Number(getPath(row, parts[1].trim()) || 0)
    : getPath(row, mt[1].trim());
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function buildBody(a: ActionDef, row: any): Record<string, any> {
  if (!a.body) return {};
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  const out: Record<string, any> = {};
  for (const [k, tmpl] of Object.entries(a.body)) out[k] = resolveToken(tmpl, row);
  return out;
}

// required-field gating for the create/edit form submit
const formValid = $derived.by(() => {
  const requiredOk = allFields(active)
    .filter((f) => f.required && fieldVisible(f))
    .every((f) => {
      const v = formData[f.name];
      return v !== '' && v != null;
    });
  if (!requiredOk) return false;
  for (const c of active.form?.computed ?? []) {
    if (c.validWhen?.equals) {
      const [a, b] = c.validWhen.equals;
      if (formData[a] !== formData[b] && Number(formData[a]) !== Number(formData[b])) return false;
    }
  }
  return true;
});

let busyRowKey = $state<string | null>(null);
let selectedIds = $state<Set<string>>(new Set());

function rowKey(row: Record<string, unknown>): string {
  return String(row.id ?? JSON.stringify(row));
}

function toggleSelect(id: string, on: boolean) {
  const next = new Set(selectedIds);
  if (on) next.add(id);
  else next.delete(id);
  selectedIds = next;
}

function toggleSelectAll(rowsList: Record<string, unknown>[], on: boolean) {
  if (!on) {
    selectedIds = new Set();
    return;
  }
  selectedIds = new Set(rowsList.map((r) => rowKey(r)));
}

// Build the JSON create/edit payload: parse type:'json' fields string→object,
// drop fields hidden by visibleWhen.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function jsonPayload(): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function openEdit(row: any) {
  editingId = row.id;
  const d = blankForm(active);
  for (const k of Object.keys(d)) if (row[k] !== undefined) d[k] = row[k];
  formData = d;
  loadRelations(active);
  showForm = true;
}
// Substitute "{id}" and any other "{field}" token in an endpoint from the row.
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function fillEndpoint(tmpl: string, row: any): string {
  return tmpl.replace(/\{([^}]+)\}/g, (_, k) => String(getPath(row, k.trim()) ?? ''));
}
/** The call itself. `extra` carries whatever an action prompt collected. */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function fireAction(row: any, a: ActionDef, extra: Record<string, any> = {}) {
  return async () => {
    const key = rowKey(row);
    busyRowKey = key;
    try {
      const url = fillEndpoint(a.endpoint ?? '', row);
      if (!guardMutation(url)) return;
      // Typed values last: a prompt exists precisely because the row cannot
      // supply this, so it overrides a "{field}" token of the same name.
      const body = { ...buildBody(a, row), ...extra };
      if (a.method === 'DELETE') await api.delete(url);
      else if (a.method === 'PATCH') await api.patch(url, body);
      else await api.post(url, body);
      await load();
      toast.success(t('ext.saved'));
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
    } finally {
      busyRowKey = null;
    }
  };
}

async function runBulkAction(a: ActionDef) {
  if (selectedIds.size === 0) return;
  const ids = [...selectedIds];
  const fakeRow = { id: ids[0], ids: ids.join(',') };
  const url = fillEndpoint(a.endpoint ?? '', fakeRow).replace('{ids}', ids.join(','));
  if (!guardMutation(url)) return;
  busyRowKey = '__bulk__';
  try {
    const body = { ...buildBody(a, fakeRow), ids };
    if (a.method === 'DELETE') await api.delete(url);
    else if (a.method === 'PATCH') await api.patch(url, body);
    else await api.post(url, body);
    selectedIds = new Set();
    await load();
    toast.success(t('ext.saved'));
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  } finally {
    busyRowKey = null;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
function runAction(row: any, a: ActionDef) {
  if (a.kind === 'edit') return openEdit(row);
  if (a.kind === 'navigate') {
    const path = fillEndpoint(a.href ?? '', row);
    const href = path.startsWith('/') ? path : `/${path}`;
    void goto(`${base}${href}`);
    return;
  }
  if (a.kind === 'open') {
    const path = fillEndpoint(a.endpoint ?? a.href ?? '', row);
    window.open(`${ENGINE_URL}${path.startsWith('/') ? path : `/${path}`}`, '_blank');
    return;
  }
  if (a.kind === 'download') {
    let ep = fillEndpoint(a.endpoint ?? '', row);
    const [path, existingQs] = ep.split('?');
    const qs = new URLSearchParams(existingQs ?? '');
    for (const fl of active.filters ?? []) {
      if (fl.type === 'dateRange') {
        const fromP = fl.fromParam ?? 'from';
        const toP = fl.toParam ?? 'to';
        const from = filterValues[fromP];
        const to = filterValues[toP];
        if (from) qs.set(fromP, from);
        if (to) qs.set(toP, to);
      } else if (fl.type === 'date') {
        const p = fl.param ?? 'date';
        const v = filterValues[p];
        if (v) qs.set(p, v);
      } else if (fl.param) {
        const v = filterValues[fl.param];
        if (v && v !== 'all') qs.set(fl.param, v);
      }
    }
    const q = qs.toString();
    window.open(`${ENGINE_URL}${path}${q ? `?${q}` : ''}`, '_blank');
    return;
  }
  if (a.prompt) {
    // The prompt IS the confirmation — see the note on ActionDef.prompt.
    promptData = {};
    for (const f of a.prompt.fields) promptData[f.name] = defaultFor(f, row);
    promptFor = { action: a, row };
    return;
  }
  const fire = fireAction(row, a);
  if (a.confirm) askConfirm(t(a.confirm), fire);
  else fire();
}

/** Action awaiting input, with the row it was fired on. */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let promptFor = $state<{ action: ActionDef; row: any } | null>(null);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let promptData = $state<Record<string, any>>({});

const promptValid = $derived.by(() =>
  (promptFor?.action.prompt?.fields ?? [])
    .filter((f) => f.required && fieldVisible(f, promptData))
    .every((f) => {
      const v = promptData[f.name];
      return v !== undefined && v !== null && v !== '';
    }),
);

async function submitPrompt() {
  const pending = promptFor;
  if (!pending || !promptValid) return;
  promptFor = null;
  await fireAction(pending.row, pending.action, { ...promptData })();
}

// computed fields (e.g. total weight = sum of goods.weight_kg)
$effect(() => {
  for (const c of active.form?.computed ?? []) {
    if (c.sumOf) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  formData[rep.name] = (formData[rep.name] as any[]).filter((_, idx) => idx !== i);
}

// path tokens in a form endpoint template, e.g. "/x/{collection}" → ["collection"]
function endpointTokens(tmpl: string): string[] {
  return [...tmpl.matchAll(/\{([^}]+)\}/g)].map((mt) => mt[1].trim());
}

let formPreview = $state<{
  // biome-ignore lint/suspicious/noExplicitAny: preview KPI bag
  stats: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: preview list rows
  list: any[];
} | null>(null);

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

  // Preview step (e.g. recall simulate) before the real create.
  if (!editingId && F.preview && !formPreview) {
    saving = true;
    try {
      const ep = fillEndpoint(F.preview.endpoint, formData);
      // biome-ignore lint/suspicious/noExplicitAny: preview API
      const res = (await api.post(ep, {})) as any;
      const root = F.preview.statsPath ? getPath(res, F.preview.statsPath) : (res?.data ?? res);
      const list = F.preview.listPath ? (getPath(res, F.preview.listPath) ?? []) : [];
      formPreview = { stats: root ?? {}, list: Array.isArray(list) ? list : [] };
      showForm = false;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
    } finally {
      saving = false;
    }
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
      const created = (await api.post(F.endpoint, jsonPayload())) as Record<string, unknown>;
      if (F.reveal?.key) {
        const v = F.reveal.key
          .split('.')
          .reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], created);
        if (typeof v === 'string' && v) revealValue = v;
      }
    }
    formPreview = null;
    showForm = false;
    await load();
    toast.success(t('ext.saved'));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : t('ext.saveFailed'));
  } finally {
    saving = false;
  }
}

function cancelPreview() {
  formPreview = null;
  showForm = true;
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

{#if active.layout === 'builder' && active.builder}
  <BuilderLayout resource={active} {routeParams} {extName} />
{:else if active.layout === 'detail' && active.detail}
  <DetailLayout resource={active} {routeParams} {extName} />
{:else}
<ExtensionPageShell
  title={t(schema.title)}
  subtitle={t(schema.subtitle)}
  tabs={shellTabs}
  activeTab={isTabbed ? activeId : undefined}
  onTabChange={(id: string) => { activeId = id; pageNum = 1; }}
  search={active.search ? search : undefined}
  onSearchChange={active.search ? (v: string) => { search = v; pageNum = 1; if (active.search?.param) load(); } : undefined}
  searchPlaceholder={t(active.search?.placeholder)}
>
  {#snippet actions()}
    {#each schema.pageActions ?? [] as a}
      <button type="button" class="btn btn-ghost btn-sm gap-1 {a.variant ?? ''}" onclick={() => runAction({}, a)}>
        {#if a.icon && ICONS[a.icon]}{@const Icon = ICONS[a.icon]}<Icon size={14} />{/if}
        {t(a.label)}
      </button>
    {/each}
    {#if active.form}
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={openCreate}>
        <Plus size={14} /> {t(schema.newLabel)}
      </button>
    {/if}
  {/snippet}

  {#if active.filters}
    {#each active.filters as fl}
      {#if fl.type === 'dateRange'}
        <div class="flex flex-wrap items-end gap-3 mb-4">
          {#if fl.label}<span class="text-xs font-medium text-base-content/65 pb-2">{t(fl.label)}</span>{/if}
          <label class="form-control">
            <span class="label-text text-xs">{t('common.col.from')}</span>
            <input
              type="date"
              class="input input-sm input-bordered"
              value={filterValues[fl.fromParam ?? 'from'] ?? ''}
              onchange={(e) => {
                filterValues = {
                  ...filterValues,
                  [fl.fromParam ?? 'from']: (e.currentTarget as HTMLInputElement).value,
                };
                pageNum = 1;
              }}
            />
          </label>
          <label class="form-control">
            <span class="label-text text-xs">{t('common.col.to')}</span>
            <input
              type="date"
              class="input input-sm input-bordered"
              value={filterValues[fl.toParam ?? 'to'] ?? ''}
              onchange={(e) => {
                filterValues = {
                  ...filterValues,
                  [fl.toParam ?? 'to']: (e.currentTarget as HTMLInputElement).value,
                };
                pageNum = 1;
              }}
            />
          </label>
          {#if fl.required && (!filterValues[fl.fromParam ?? 'from'] || !filterValues[fl.toParam ?? 'to'])}
            <span class="text-xs text-warning pb-2">{t('operations.traceability.report.needDates')}</span>
          {/if}
        </div>
      {:else if fl.type === 'date'}
        <div class="flex items-end gap-3 mb-4">
          <label class="form-control">
            <span class="label-text text-xs">{t(fl.label) || t('common.col.date')}</span>
            <input
              type="date"
              class="input input-sm input-bordered"
              value={filterValues[fl.param ?? 'date'] ?? ''}
              onchange={(e) => {
                filterValues = {
                  ...filterValues,
                  [fl.param ?? 'date']: (e.currentTarget as HTMLInputElement).value,
                };
                pageNum = 1;
              }}
            />
          </label>
        </div>
      {:else if fl.param && fl.options}
        <div class="tabs tabs-boxed bg-base-200 w-fit mb-4">
          {#each fl.options as opt}
            <button type="button"
              class="tab {(filterValues[fl.param] ?? 'all') === opt.value ? 'tab-active' : ''}"
              onclick={() => {
                filterValues = { ...filterValues, [fl.param!]: opt.value };
                pageNum = 1;
              }}
            >
              {t(opt.label)}
            </button>
          {/each}
        </div>
      {/if}
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

  {#if active.layout === 'checklist' && active.checklist}
    {#if loading}
      <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
    {:else}
      <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        <div class="space-y-4">
          <div class="form-control">
            <label class="label" for="sdui-checklist-option"><span class="label-text font-medium">{t('common.col.role')}</span></label>
            <select
              id="sdui-checklist-option"
              class="select select-bordered select-sm"
              value={checklistSelected}
              onchange={(e) => selectChecklistOption((e.currentTarget as HTMLSelectElement).value)}
            >
              {#each checklistOptions as opt (opt)}
                <option value={opt}>{opt}</option>
              {/each}
            </select>
            <p class="text-xs text-base-content/65 mt-1">
              {checklistConfigured ? t('analytics.dashboard.customLayout') : t('analytics.dashboard.defaultLayout')}
            </p>
          </div>
          <div class="card bg-base-200">
            <div class="card-body p-4 space-y-2">
              <h2 class="font-medium text-sm">{t('analytics.dashboard.widgetsForRole')}</h2>
              {#each checklistCatalog as w (w.id)}
                <label class="flex items-center gap-3 p-1.5 rounded hover:bg-base-300/40 cursor-pointer">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm checkbox-primary"
                    checked={!!checklistDraft[w.id]}
                    disabled={w.removable === false}
                    onchange={(e) => {
                      checklistDraft = { ...checklistDraft, [w.id]: (e.currentTarget as HTMLInputElement).checked };
                    }}
                  />
                  <span class="text-sm flex-1">{checklistLabel(w.id)}</span>
                </label>
              {/each}
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-sm" onclick={saveChecklist} disabled={checklistSaving || !checklistSelected}>
            {t('common.save')}
          </button>
        </div>
        <div class="space-y-2">
          <h2 class="font-medium text-sm text-base-content/65">{t('analytics.dashboard.includedWidgets')}</h2>
          <div class="border border-base-300 rounded-lg p-4 bg-base-100 min-h-[8rem]">
            {#if checklistSelectedIds.length}
              <div class="flex flex-wrap gap-2">
                {#each checklistSelectedIds as id (id)}
                  <span class="badge badge-lg badge-primary badge-outline">{checklistLabel(id)}</span>
                {/each}
              </div>
            {:else}
              <p class="text-sm text-base-content/65 py-8 text-center">{t('analytics.dashboard.noWidgets')}</p>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  {:else if active.master}
    {@const mkey = active.master.idKey ?? 'id'}
    <div class="grid grid-cols-12 gap-4">
      <aside class="col-span-3">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-2 gap-1">
            {#if masterRows.length === 0}
              <p class="p-3 text-xs text-base-content/65">{t('common.noResults')}</p>
            {:else}
              {#each masterRows as mrow (mrow[mkey])}
                <button type="button"
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
                <button type="button" class="btn btn-outline btn-sm gap-1 {a.variant ?? ''}" onclick={() => runAction(selectedMaster, a)}>
                  {#if a.icon && ICONS[a.icon]}{@const Icon = ICONS[a.icon]}<Icon size={13} />{/if}
                  {t(a.label)}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
        <ExtensionDataPanel {loading} empty={!loading && rows.length === 0} emptyTitle={t('common.noResults')}>
          {#snippet table()}
            {#if active.selectable && active.bulkActions && selectedIds.size > 0}
              <div class="flex flex-wrap items-center gap-2 mb-2 px-1">
                <span class="text-sm opacity-70">{selectedIds.size} selected</span>
                {#each active.bulkActions as a}
                  <button type="button"
                    class="btn btn-sm {a.variant ?? 'btn-outline'}"
                    disabled={busyRowKey === '__bulk__'}
                    onclick={() => void runBulkAction(a)}
                  >
                    {#if busyRowKey === '__bulk__'}<LoaderCircle size={13} class="animate-spin" />{/if}
                    {t(a.label)}
                  </button>
                {/each}
              </div>
            {/if}
            <table class="table table-sm">
              <thead>
                <tr>
                  {#if active.selectable}
                    <th class="w-8">
                      <input
                        type="checkbox"
                        class="checkbox checkbox-xs"
                        checked={clientFiltered.length > 0 && clientFiltered.every((r) => selectedIds.has(rowKey(r)))}
                        onchange={(e) => toggleSelectAll(clientFiltered, (e.currentTarget as HTMLInputElement).checked)}
                      />
                    </th>
                  {/if}
                  {#each (active.columns ?? []) as col}<th>{t(col.label)}</th>{/each}
                  {#if active.rowActions}<th></th>{/if}
                </tr>
              </thead>
              <tbody>
                {#each clientFiltered as row (row.id ?? JSON.stringify(row))}
                  <tr class="hover">
                    {#if active.selectable}
                      <td>
                        <input
                          type="checkbox"
                          class="checkbox checkbox-xs"
                          checked={selectedIds.has(rowKey(row))}
                          onchange={(e) => toggleSelect(rowKey(row), (e.currentTarget as HTMLInputElement).checked)}
                        />
                      </td>
                    {/if}
                    {#each (active.columns ?? []) as col}
                      <td class={cellClass(row, col)}>
                        {#if col.editable}
                          {#if col.editable.options}
                            <select class="select select-xs select-bordered" value={String(getPath(row, col.key) ?? '')}
                              onchange={(e) => inlineEdit(row, col, (e.currentTarget as HTMLSelectElement).value)}>
                              {#each col.editable.options as o}<option value={o.value}>{t(o.label)}</option>{/each}
                            </select>
                          {:else}
                            <input class="input input-xs input-bordered w-full max-w-[12rem]" value={String(getPath(row, col.key) ?? '')}
                              onchange={(e) => inlineEdit(row, col, (e.currentTarget as HTMLInputElement).value)} />
                          {/if}
                        {:else if col.type === 'badge'}
                          <span class="badge badge-sm {badgeClass(row, col)}">{badgeLabel(row, col)}</span>
                        {:else if col.type === 'boolean'}
                          {getPath(row, col.key) ? t('common.yes') : t('common.no')}
                        {:else if col.type === 'tags'}
                          <div class="flex flex-wrap gap-1">
                            {#each (Array.isArray(getPath(row, col.key)) ? getPath(row, col.key) : String(getPath(row, col.key) ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)) as tag}
                              <span class="badge badge-ghost badge-sm">{tag}</span>
                            {/each}
                          </div>
                        {:else if col.type === 'link'}
                          {@const href = String(getPath(row, col.key) ?? '')}
                          {#if href}
                            <a class="link link-primary" href={href} target="_blank" rel="noopener noreferrer">{href}</a>
                          {:else}—{/if}
                        {:else}{cellText(row, col)}{/if}
                      </td>
                    {/each}
                    {#if active.rowActions}
                      <td class="text-right whitespace-nowrap">
                        {#each active.rowActions as a}
                          {#if actionVisible(row, a)}
                            <button type="button"
                              class="btn btn-ghost btn-xs {a.variant ?? ''}"
                              title={t(a.label)}
                              disabled={busyRowKey === rowKey(row)}
                              onclick={() => runAction(row, a)}
                            >
                              {#if busyRowKey === rowKey(row)}
                                <LoaderCircle size={12} class="animate-spin" />
                              {:else if a.icon && ICONS[a.icon]}
                                {@const Icon = ICONS[a.icon]}<Icon size={12} />
                              {:else}{t(a.label)}{/if}
                            </button>
                          {/if}
                        {/each}
                      </td>
                    {/if}
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
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/65 text-sm">{t('common.noResults')}</div></div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each clientFiltered as row (row.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between">
                <div class="font-medium text-sm">{getPath(row, active.card?.title)}</div>
                {#if active.card?.badge}<span class="badge badge-ghost badge-sm">{getPath(row, active.card.badge)}</span>{/if}
              </div>
              {#if active.card?.subtitle}<div class="text-xs text-base-content/65 font-mono break-all">{getPath(row, active.card.subtitle)}</div>{/if}
              {#if active.rowActions}
                <div class="flex justify-end gap-1">
                  {#each active.rowActions as a}
                    {#if actionVisible(row, a)}
                      <button type="button" class="btn btn-ghost btn-xs {a.variant ?? ''}" title={t(a.label)} onclick={() => runAction(row, a)}>
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
      {#if active.selectable && active.bulkActions && selectedIds.size > 0}
        <div class="flex flex-wrap items-center gap-2 mb-2 px-1">
          <span class="text-sm opacity-70">{selectedIds.size} selected</span>
          {#each active.bulkActions as a}
            <button type="button"
              class="btn btn-sm {a.variant ?? 'btn-outline'}"
              disabled={busyRowKey === '__bulk__'}
              onclick={() => void runBulkAction(a)}
            >
              {#if busyRowKey === '__bulk__'}<LoaderCircle size={13} class="animate-spin" />{/if}
              {t(a.label)}
            </button>
          {/each}
        </div>
      {/if}
      <table class="table table-sm">
        <thead>
          <tr>
            {#if active.selectable}
              <th class="w-8">
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  checked={clientFiltered.length > 0 && clientFiltered.every((r) => selectedIds.has(rowKey(r)))}
                  onchange={(e) => toggleSelectAll(clientFiltered, (e.currentTarget as HTMLInputElement).checked)}
                />
              </th>
            {/if}
            {#each (active.columns ?? []) as col}<th>{t(col.label)}</th>{/each}
            {#if active.rowActions}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each clientFiltered as row (row.id)}
            <tr class="hover">
              {#if active.selectable}
                <td>
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    checked={selectedIds.has(rowKey(row))}
                    onchange={(e) => toggleSelect(rowKey(row), (e.currentTarget as HTMLInputElement).checked)}
                  />
                </td>
              {/if}
              {#each (active.columns ?? []) as col}
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
                  {:else if col.type === 'boolean'}
                    {getPath(row, col.key) ? t('common.yes') : t('common.no')}
                  {:else if col.type === 'tags'}
                    <div class="flex flex-wrap gap-1">
                      {#each (Array.isArray(getPath(row, col.key)) ? getPath(row, col.key) : String(getPath(row, col.key) ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)) as tag}
                        <span class="badge badge-ghost badge-sm">{tag}</span>
                      {/each}
                    </div>
                  {:else if col.type === 'link'}
                    {@const href = String(getPath(row, col.key) ?? '')}
                    {#if href}
                      <a class="link link-primary" href={href} target="_blank" rel="noopener noreferrer">{href}</a>
                    {:else}—{/if}
                  {:else if col.secondary}
                    <div class="font-medium">{cellText(row, col)}</div>
                    {#if row[col.secondary]}<div class="text-xs text-base-content/65">{row[col.secondary]}</div>{/if}
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
                        <button type="button"
                          class="btn btn-ghost btn-xs {a.variant ?? ''}"
                          title={t(a.label)}
                          disabled={busyRowKey === rowKey(row)}
                          onclick={() => runAction(row, a)}
                        >
                          {#if busyRowKey === rowKey(row)}
                            <LoaderCircle size={12} class="animate-spin" />
                          {:else if a.icon && ICONS[a.icon]}
                            {@const Icon = ICONS[a.icon]}<Icon size={12} />
                          {:else}{t(a.label)}{/if}
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
      <button type="button" class="btn btn-sm" disabled={pageNum === 1} onclick={() => pageNum--}>{t('common.prev')}</button>
      <span class="btn btn-sm btn-disabled">{pageNum} / {Math.ceil(total / active.pagination.limit) || 1}</span>
      <button class="btn btn-sm" disabled={pageNum * active.pagination.limit >= total} onclick={() => pageNum++}>{t('common.next')}</button>
    </div>
  {/if}

  <ConfirmModal open={confirmState.open} title={confirmState.title} message={confirmState.message}
    confirmLabel={confirmState.confirmLabel} confirmClass={confirmState.confirmClass}
    onconfirm={runConfirmAction} oncancel={cancelConfirm} />

  {#if revealValue && active.form?.reveal}
    <Modal open={true} title={t(active.form.reveal.title ?? 'ext.reveal.title')} size="lg" dismissible={false}>
        <p class="text-sm text-warning py-2">{t(active.form.reveal.note ?? 'ext.reveal.note')}</p>
        <div class="flex items-center gap-2">
          <code class="bg-base-200 rounded px-3 py-2 text-sm break-all flex-1 select-all">{revealValue}</code>
          <button type="button" class="btn btn-sm btn-primary" onclick={copyReveal}>
            {revealCopied ? t('ext.copied') : t('ext.reveal.copy')}
          </button>
        </div>
        <div class="modal-action">
          <button type="button" class="btn btn-sm" onclick={() => (revealValue = null)}>{t('common.close')}</button>
        </div>
    </Modal>
  {/if}

  {#if formPreview && active.form?.preview}
    <Modal open={true} title={t(schema.newLabel)} size="lg" dismissible={false}>
      {#if active.form.preview.stats?.length}
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          {#each active.form.preview.stats as card}
            <div class="stat bg-base-200 rounded-xl py-3">
              <div class="stat-title text-xs">{t(card.label)}</div>
              <div class="stat-value text-lg">{getPath(formPreview.stats, card.key) ?? '—'}</div>
            </div>
          {/each}
        </div>
      {/if}
      {#if active.form.preview.listColumns?.length && formPreview.list.length}
        <div class="overflow-x-auto max-h-64">
          <table class="table table-sm">
            <thead>
              <tr>
                {#each active.form.preview.listColumns as col}
                  <th>{t(col.label)}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each formPreview.list as row}
                <tr>
                  {#each active.form.preview.listColumns as col}
                    <td>{getPath(row, col.key) ?? '—'}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={cancelPreview}>{t('common.cancel')}</button>
        <button type="button" class="btn btn-error" onclick={submitForm} disabled={saving}>
          {saving ? '…' : t(active.form.preview.confirmLabel ?? 'operations.traceability.action.confirm')}
        </button>
      </div>
    </Modal>
  {/if}
</ExtensionPageShell>

<!--
  One field renderer, two callers: the create/edit form and an action prompt.
  It takes the object to write into rather than closing over `formData`, so a
  prompt keeps its own values and cannot leave anything behind in a form the
  person never opened.
-->
{#snippet fieldInput(f: FieldDef, data: Record<string, any>)}
  {#if fieldVisible(f, data)}
  <div class="form-control {f.colSpan === 2 ? 'col-span-2' : ''}">
    <label class="label py-0"><span class="label-text text-xs">{t(f.label)}{f.required ? ' *' : ''}</span></label>
    {#if f.type === 'select' || f.type === 'relation'}
      <select
        class="select select-sm"
        bind:value={data[f.name]}
        onchange={() => applyAutofill(f, data[f.name], data)}
      >
        <!--
          The empty option says what leaving it alone DOES, when the field
          knows. "Select…" describes the widget; a placeholder like "Default
          series" describes the outcome, which is the only thing the person
          filling in the form is deciding.
        -->
        {#if f.type === 'relation'}<option value="">{t(f.placeholder ?? 'common.select')}</option>{/if}
        {#each (f.type === 'relation' ? (relationOpts[f.name] ?? []) : (f.options ?? [])) as o}
          <option value={o.value}>{t(o.label)}</option>
        {/each}
      </select>
    {:else if f.type === 'textarea' || f.type === 'json'}
      <textarea
        class="textarea textarea-sm {f.mono || f.type === 'json' ? 'font-mono text-xs' : ''}"
        rows={f.rows ?? 4}
        bind:value={data[f.name]}
        placeholder={t(f.placeholder)}
      ></textarea>
    {:else if f.type === 'boolean'}
      <input type="checkbox" class="toggle toggle-sm toggle-primary" bind:checked={data[f.name]} />
    {:else if f.type === 'file'}
      <input type="file" class="file-input file-input-sm file-input-bordered" accept={f.accept}
        onchange={(e) => (data[f.name] = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
    {:else}
      <div class="flex gap-2 items-center">
        <input class="input input-sm flex-1 {f.mono ? 'font-mono' : ''}" type={f.type ?? 'text'} bind:value={data[f.name]} placeholder={t(f.placeholder)} />
        {#if f.lookup}
          <button type="button" class="btn btn-sm btn-outline shrink-0" onclick={() => runLookup(f, data)}>
            {t(f.lookup.label)}
          </button>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
{/snippet}

{#if promptFor?.action.prompt}
  {@const P = promptFor.action.prompt}
  <Modal open={true} onClose={() => (promptFor = null)} title={t(P.title ?? promptFor.action.label ?? 'common.confirm')} size="md">
      <div class="grid grid-cols-1 gap-3">
        {#each P.fields as f}{@render fieldInput(f, promptData)}{/each}
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (promptFor = null)}>{t('common.cancel')}</button>
        <button type="button"
          class="btn btn-primary {promptFor.action.variant ?? ''}"
          disabled={!promptValid}
          onclick={submitPrompt}
        >{t(P.submitLabel ?? 'common.confirm')}</button>
      </div>
  </Modal>
{/if}

{#if showForm && active.form}
  {@const F = active.form}
  <Modal bind:open={showForm} title={editingId ? t('common.edit') : t(schema.newLabel)} size="xl" onSubmit={submitForm}>

      {#if F.fields}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          {#each F.fields as f}{@render fieldInput(f, formData)}{/each}
        </div>
      {/if}

      {#each F.sections ?? [] as sec}
        <div class="card bg-base-200 p-3 mb-3">
          <p class="font-semibold text-sm mb-2">{t(sec.title)}</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">{#each sec.fields as f}{@render fieldInput(f, formData)}{/each}</div>
        </div>
      {/each}

      {#if F.repeatable}
        {@const rep = F.repeatable}
        <div class="mb-3">
          <div class="flex items-center justify-between mb-2">
            <p class="font-semibold text-sm">{t(rep.label)}</p>
            <button type="button" class="btn btn-ghost btn-xs" onclick={addRepeatRow}>{t(rep.addLabel)}</button>
          </div>
          <div class="overflow-x-auto">
          <table class="table table-xs">
            <thead><tr>{#each rep.columns as c}<th>{t(c.label)}</th>{/each}<th></th></tr></thead>
            <tbody>
              {#each (formData[rep.name] ?? []) as _, i}
                <tr>
                  {#each rep.columns as c}
                    <td>
                      {#if c.type === 'relation'}
                        <!--
                          Autofill writes into THIS row, so picking a catalogue
                          item fills that line's description, unit, price and
                          VAT rate and leaves the other lines alone.
                        -->
                        <select
                          class="select select-xs w-40"
                          bind:value={formData[rep.name][i][c.name]}
                          onchange={() => applyAutofill(c, formData[rep.name][i][c.name], formData[rep.name][i])}
                        >
                          <option value="">—</option>
                          {#each relationOpts[c.name] ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                        </select>
                      {:else}
                        <input class="input input-xs {c.mono ? 'font-mono' : ''}" type={c.type ?? 'text'} bind:value={formData[rep.name][i][c.name]} />
                      {/if}
                    </td>
                  {/each}
                  <td>{#if (formData[rep.name]?.length ?? 0) > (rep.min ?? 0)}<button type="button" class="btn btn-ghost btn-xs text-error" onclick={() => removeRepeatRow(i)}>✕</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          </div>
        </div>
      {/if}

      {#each F.computed ?? [] as c}
        <p class="text-right text-sm mb-2">{t(c.label)}: <strong class="font-mono">{formData[c.name] ?? 0}</strong></p>
      {/each}

      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (showForm = false)}>{t('common.cancel')}</button>
        <button type="submit" class="btn btn-primary" disabled={saving || !formValid}>
          {#if saving}<LoaderCircle size={14} class="animate-spin" />{/if}
          {#if F.submit?.kind === 'download'}{t('common.download')}
          {:else if F.submit?.kind === 'upload'}{t('common.upload')}
          {:else if !editingId && F.preview}{t(F.preview.submitLabel ?? 'operations.traceability.action.simulate')}
          {:else}{editingId ? t('common.save') : t('common.create')}{/if}
        </button>
      </div>
  </Modal>
{/if}
{/if}
