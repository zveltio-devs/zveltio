/**
 * How Studio's `view/2` renderer reaches the engine (ADR 0042 slice 2). A view
 * names collections and actions; this module turns a name into the engine's
 * data API or action route, always as the signed-in user, so the engine's
 * rules decide every call. Plain TypeScript: the Svelte components only draw.
 */
import {
  actionPath,
  type Button,
  type Change,
  type Condition,
  type Field,
  type SchemaField,
  toFilter,
  toSort,
  type ViewScope,
} from '@zveltio/sdk/view';
import type { FormField } from '@zveltio/sdk/extension';
import { api, dataApi } from '#lib/api.js';
import { labelFromRecord } from '#lib/components/collections/field-helpers.js';

export interface ReadableCollection {
  name: string;
  display_name?: string | null;
  fields: SchemaField[];
}

/**
 * The collections the caller may read, with the fields it may read
 * (`GET /api/data`): the same answer the data API gives a list, so a
 * generated view never shows a column the caller cannot see. Not cached: a
 * sign-out, a role change or a schema change must not leave an old answer.
 */
export async function readableCollections(): Promise<Map<string, ReadableCollection>> {
  const r = await api.get<{ collections: ReadableCollection[] }>('/api/data');
  return new Map(r.collections.map((c) => [c.name, c]));
}

export async function schemaOf(collection: string): Promise<SchemaField[]> {
  return (await readableCollections()).get(collection)?.fields ?? [];
}

export interface RunnableAction {
  extension: string;
  name: string;
  input: { properties?: Record<string, Record<string, unknown>>; required?: string[] };
}

/** The actions the caller may run (`GET /api/actions`, ADR 0029). Not cached, as above. */
export async function runnableActions(): Promise<RunnableAction[]> {
  return (await api.get<{ actions: RunnableAction[] }>('/api/actions')).actions;
}

/** `pay` of `billing`, or `mail.send`: the entry `GET /api/actions` lists for it. */
export function findAction(
  list: readonly RunnableAction[],
  extension: string,
  action: string,
): RunnableAction | undefined {
  const dot = action.indexOf('.');
  const [ext, name] = dot < 0 ? [extension, action] : [action.slice(0, dot), action.slice(dot + 1)];
  return list.find((a) => a.extension === ext && a.name === name);
}

/** `$files`: the stored files the caller hands the action's job (ADR 0032). */
export type FileHandoff = { read?: string[]; write?: { name: string; maxBytes?: number } };

export async function runAction(
  extension: string,
  action: string,
  input: Record<string, unknown>,
  files?: FileHandoff,
): Promise<unknown> {
  const res = await api.post<{ result: unknown }>(
    actionPath(extension, action),
    files ? { ...input, $files: files } : input,
  );
  return res?.result ?? null;
}

/** A `file` field's value: a stored file by id. */
export interface FileValue {
  id: string;
  name: string;
  size?: number;
  type?: string;
}

/** The files in a `file` field's value (one, or a list with `options.multiple`). */
export function filesOf(v: unknown): FileValue[] {
  return (Array.isArray(v) ? v : v == null ? [] : [v]).filter(
    (f): f is FileValue =>
      typeof f === 'object' && f !== null && typeof (f as FileValue).id === 'string',
  );
}

/** Opens a stored file through a signed URL, as the user (`/api/storage/:id`). */
export async function openFile(id: string): Promise<void> {
  const { url } = await api.get<{ url: string }>(
    `/api/storage/${encodeURIComponent(id)}/signed-url`,
  );
  window.open(url, '_blank', 'noopener');
}

/** What a view shows for a field of a row: its value, or its `fallback` field's while it is empty. */
export function shownValue(
  row: Record<string, unknown>,
  name: string,
  hint: { fallback?: string } | null,
  types: ReadonlyMap<string, { type?: unknown }>,
): { value: unknown; type: string | undefined } {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  const use = hint?.fallback && empty(row[name]) ? hint.fallback : name;
  const t = types.get(use)?.type;
  return { value: row[use], type: typeof t === 'string' ? t : undefined };
}

export interface ListQuery {
  page: number;
  limit: number;
  search?: string;
  filter: Record<string, Record<string, unknown>>;
  sort?: string;
}

/** The data API query of a list: `null` while a reference has no value yet. */
export function listParams(
  view: { filter?: Parameters<typeof toFilter>[0]; sort?: Parameters<typeof toSort>[0] },
  scope: ViewScope,
  q: { page: number; limit: number; search?: string },
): Record<string, string | number> | null {
  const filter = toFilter(view.filter, scope);
  if (!filter) return null;
  const out: Record<string, string | number> = { page: q.page, limit: q.limit };
  if (Object.keys(filter).length) out.filter = JSON.stringify(filter);
  const sort = toSort(view.sort);
  if (sort) Object.assign(out, sort);
  if (q.search?.trim()) out.search = q.search.trim();
  return out;
}

export const listRecords = (collection: string, params: Record<string, string | number>) =>
  dataApi.list(collection, params);

const INPUT_TYPES: Record<string, string> = {
  email: 'email',
  url: 'url',
  password: 'password',
  secret: 'password',
  number: 'number',
  integer: 'number',
  decimal: 'number',
  float: 'number',
  boolean: 'checkbox',
  textarea: 'textarea',
  richtext: 'textarea',
  json: 'textarea',
  select: 'select',
  enum: 'select',
};

const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * A collection field as `SchemaForm` draws it. A `richtext` value is edited as
 * text and never rendered as HTML here (ADR 0042 decision 10).
 */
export function toFormField(f: SchemaField, label?: string): FormField {
  const type = INPUT_TYPES[f.type] ?? 'text';
  const opts = f.options as { choices?: unknown[] } | unknown[] | null | undefined;
  const choices = Array.isArray(opts) ? opts : opts?.choices;
  return {
    name: f.name,
    // The engine's type, for `formPayload`: a `json` field is edited as text.
    fieldType: f.type,
    type: type === 'select' && !choices?.length ? 'text' : type,
    label: label ?? (typeof f.label === 'string' && f.label ? f.label : humanize(f.name)),
    required: f.required === true,
    ...(type === 'select' && choices?.length
      ? {
          options: choices.map((c) =>
            typeof c === 'object' && c !== null
              ? {
                  value: String((c as { value: unknown }).value),
                  label: String(
                    (c as { label?: unknown }).label ?? (c as { value: unknown }).value,
                  ),
                }
              : String(c),
          ),
        }
      : {}),
  };
}

/** A select or enum field's declared choices, in order; none for any other field. */
export function choicesOf(f: SchemaField | undefined): { value: string; label: string }[] {
  const opts = f?.options as { choices?: unknown[] } | unknown[] | null | undefined;
  const list = Array.isArray(opts) ? opts : (opts?.choices ?? []);
  return list.map((c) => {
    if (typeof c !== 'object' || c === null) return { value: String(c), label: String(c) };
    const { value, label } = c as { value: unknown; label?: unknown };
    return { value: String(value), label: String(label ?? value) };
  });
}

/** An action's input JSON Schema as the fields of a form. */
export function actionInputFields(input: RunnableAction['input'] | undefined): SchemaField[] {
  const required = new Set(input?.required ?? []);
  return Object.entries(input?.properties ?? {}).map(([name, p]) => {
    const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
    return {
      name,
      type: Array.isArray(p.enum)
        ? 'select'
        : t === 'boolean'
          ? 'boolean'
          : t === 'number' || t === 'integer'
            ? 'number'
            : 'text',
      required: required.has(name),
      ...(Array.isArray(p.enum) ? { options: { choices: p.enum } } : {}),
      ...(typeof p.title === 'string' ? { label: p.title } : {}),
    };
  });
}

/**
 * Form values as the engine takes them: numbers as numbers. An empty input says
 * nothing on create (the default applies) and clears the field on edit.
 */
export function formPayload(
  values: Record<string, unknown>,
  fields: readonly FormField[],
  edit = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined) continue;
    if (v === '') {
      if (edit) out[f.name] = null;
      continue;
    }
    // `SchemaForm` shows a `json` value as JSON text (`textValue`); edited, it is
    // text again and goes back as the value it spells. Bad JSON fails the save.
    if (f.fieldType === 'json' && typeof v === 'string') {
      try {
        out[f.name] = JSON.parse(v);
      } catch {
        throw new Error(`${f.label ?? f.name}: not valid JSON`);
      }
      continue;
    }
    out[f.name] = f.type === 'number' && typeof v === 'string' ? Number(v) : v;
  }
  return out;
}

/** The view fields as `{ name, hint }`: a field object adds only presentation. */
export function fieldHints(
  fields: readonly Field[],
): { name: string; hint: Exclude<Field, string> | null }[] {
  return fields.map((f) =>
    typeof f === 'string' ? { name: f, hint: null } : { name: f.field, hint: f },
  );
}

/** What the components of one drawn view share: set up by `ViewPage.svelte`. */
export interface ViewHost {
  /** The extension whose view this is: its actions are run under its name. */
  ext: string;
  /** `$param`, `$user`, and `$selected` (pane id → selected record id), reactive. */
  scope: Required<Pick<ViewScope, 'params' | 'selected'>> & Pick<ViewScope, 'user'>;
  /** A message key of the extension, or literal text. */
  t: (s?: string) => string;
  /**
   * Runs a button: an action, a navigation (a form handles `save` itself).
   * `before` runs once the prompt and confirm went through, just before the
   * action (a form saves there), and gives the scope it runs on, or `null`.
   */
  press: (
    b: Button,
    scope: ViewScope,
    before?: (s: ViewScope) => Promise<ViewScope | null>,
  ) => Promise<void>;
  /**
   * Runs an action with this input and acts on its result; `files` goes as the
   * request's `$files`. `quiet`: no success message and the result is not
   * acted on (`onOpen`).
   */
  run: (
    action: string,
    input: Record<string, unknown>,
    opts?: { files?: FileHandoff; quiet?: boolean },
  ) => Promise<boolean>;
  /**
   * Keeps the page reading its records again, every few seconds, until the
   * returned release is called: a button's `busyWhen` holds while the work it
   * started is under way.
   */
  hold: () => () => void;
  /** Deletes a record through the data API, after a confirm. */
  remove: (collection: string, id: string) => Promise<void>;
  /** Whether the caller may run an action (`GET /api/actions`); a hint, the engine decides. */
  canRun: (action: string) => boolean;
  /**
   * Writes a change a view made (a board or timeline `move`, a matrix `edit`):
   * `patch` through the data API (a record with no `id` is created), or the
   * action with `$record` as the record after the change. Reads again after;
   * `true` when the write went through.
   */
  change: (
    change: Change,
    collection: string,
    record: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => Promise<boolean>;
  /**
   * Several such writes as one: `patch` is one bulk update of the data API
   * (one transaction, at most 500 records); an action runs once per record and
   * stops at the first refusal. `true` when every write went through.
   */
  changeMany: (
    change: Change,
    collection: string,
    writes: { record: Record<string, unknown>; patch: Record<string, unknown> }[],
  ) => Promise<boolean>;
  /** Bumped after an action ran: lists and records read again. */
  version: number;
}

/**
 * The page a board, timeline, tree, matrix or map reads: the data API's
 * largest. More than that shows a note and "Load more" (`readRows`).
 */
export const WHOLE = 500;

/** A date or timestamp as its local day, `YYYY-MM-DD`; `null` when it is neither. */
export function dayKey(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : localDay(d);
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A `YYYY-MM-DD` day as a local midnight. */
export const dayDate = (key: string) => new Date(`${key}T00:00:00`);

/**
 * A date or timestamp moved by whole days, in its own form: a date stays a
 * date, a timestamp keeps its local time of day.
 */
export function shiftDays(value: unknown, days: number): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = dayDate(value);
    d.setDate(d.getDate() + days);
    return localDay(d);
  }
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. */
export const daysBetween = (a: string, b: string) =>
  Math.round((dayDate(b).getTime() - dayDate(a).getTime()) / 86_400_000);

/** The days a timeline shows around `anchor`: a day, a week from Monday, or a month. */
export function period(anchor: string, scale: 'day' | 'week' | 'month' | 'gantt'): string[] {
  const d = dayDate(anchor);
  let n = 1;
  if (scale === 'week') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    n = 7;
  } else if (scale === 'month' || scale === 'gantt') {
    d.setDate(1);
    n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    return localDay(x);
  });
}

/** Whether `id` is `under` or one of its descendants: a tree must not take a node into itself. */
export function isWithin(
  id: string,
  under: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set<string>();
  for (let at: string | null | undefined = under; at != null; at = parentOf.get(at)) {
    if (at === id) return true;
    if (seen.has(at)) return false; // a cycle already in the data: stop
    seen.add(at);
  }
  return false;
}

/**
 * Where `navigate: <view id>` goes: the extension's page whose view file has
 * that `id`, its `:name` segments filled from the parameters and the rest as
 * the query (`$param` reads both). `null` when no page shows that view.
 */
export function viewHref(
  pages: readonly { path: string; schema?: unknown }[],
  viewId: string,
  params: Record<string, unknown>,
): string | null {
  const page = pages.find(
    (p) =>
      typeof p.schema === 'object' &&
      p.schema !== null &&
      (p.schema as { id?: unknown }).id === viewId,
  );
  if (!page) return null;
  const rest = new URLSearchParams();
  const used = new Set<string>();
  const path = page.path
    .replace(/^\/admin(?=\/|$)/, '')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k: string) => {
      used.add(k);
      return encodeURIComponent(String(params[k] ?? ''));
    });
  for (const [k, v] of Object.entries(params)) {
    if (!used.has(k) && v !== undefined && v !== null) rest.set(k, String(v));
  }
  const qs = rest.toString();
  return qs ? `${path}?${qs}` : path;
}

/** "3 hours ago" for a timestamp; the value itself when it is not one. */
export function elapsed(value: unknown, now = Date.now(), locale?: string): string {
  const t =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(t)) return String(value);
  const s = Math.round((t - now) / 1000);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    if (Math.abs(s) >= size) return fmt.format(Math.round(s / size), unit);
  }
  return fmt.format(s, 'second');
}

/**
 * The data API queries of a timeline's period `[from, until)`, the view's own
 * conditions kept (a field and operator the view sets stay the view's). With
 * an `end`: what overlaps the period, and, asked apart because the data API has
 * no OR, what starts in it with an empty `end` (a point at its start).
 */
export function periodQueries(
  own: readonly Condition[],
  start: string,
  end: string | undefined,
  from: string,
  until: string,
): Condition[][] {
  const keep = (add: Condition[]) => [
    ...own,
    ...add.filter((c) => !own.some((o) => o.field === c.field && o.op === c.op)),
  ];
  const before: Condition = { field: start, op: 'lt', value: until };
  const after: Condition = { field: start, op: 'gte', value: from };
  if (!end) return [keep([before, after])];
  return [
    keep([before, { field: end, op: 'gte', value: from }]),
    keep([before, after, { field: end, op: 'null' }]),
  ];
}

/**
 * Each record's parent in a tree: the `parent` value when that record is
 * among the rows, else none (a root). A cycle in the data (A under B under A)
 * has no root and would not be drawn: its first record becomes one, so every
 * record is drawn exactly once and the drawing ends.
 */
export function treeParents(
  rows: readonly { id: string; [k: string]: unknown }[],
  parent: string,
): Map<string, string | null> {
  const ids = new Set(rows.map((r) => r.id));
  const out = new Map(
    rows.map((r) => {
      const p = r[parent];
      return [r.id, p != null && ids.has(String(p)) ? String(p) : null] as const;
    }),
  );
  for (;;) {
    const kids = new Map<string | null, string[]>();
    for (const [id, p] of out) kids.set(p, [...(kids.get(p) ?? []), id]);
    const reached = new Set<string>();
    const todo = [...(kids.get(null) ?? [])];
    while (todo.length) {
      const id = todo.pop() as string;
      if (reached.has(id)) continue;
      reached.add(id);
      todo.push(...(kids.get(id) ?? []));
    }
    const lost = rows.find((r) => !reached.has(r.id));
    if (!lost) return out;
    out.set(lost.id, null);
  }
}

/**
 * The `order` writes that move sibling `i` to `j` (a neighbour): the two swap
 * values when both are set and differ; otherwise every sibling is renumbered
 * 0..n-1 in the new order, so no value collides with another sibling's.
 */
export function reorder<R extends Record<string, unknown>>(
  sibs: readonly R[],
  i: number,
  j: number,
  order: string,
): { renumber: boolean; writes: { record: R; patch: Record<string, unknown> }[] } {
  const set = (v: unknown) => v !== null && v !== undefined && v !== '';
  const [a, b] = [sibs[i][order], sibs[j][order]];
  if (set(a) && set(b) && a !== b) {
    return {
      renumber: false,
      writes: [
        { record: sibs[i], patch: { [order]: b } },
        { record: sibs[j], patch: { [order]: a } },
      ],
    };
  }
  const next = [...sibs];
  [next[i], next[j]] = [next[j], next[i]];
  return { renumber: true, writes: next.map((record, k) => ({ record, patch: { [order]: k } })) };
}

/** The collection a relation field points at (`m2o`, `reference`); none for any other field. */
export function relatedOf(f: SchemaField | undefined): string | null {
  const target = (f?.options as { related_collection?: unknown } | null | undefined)
    ?.related_collection;
  return (f?.type === 'm2o' || f?.type === 'reference') && typeof target === 'string'
    ? target
    : null;
}

/**
 * The labels of records of `collection` by id, read through the data API as
 * the user, 100 ids a query (a short URL). An id the caller may not read, or
 * that is gone, has no label.
 */
export async function recordLabels(
  collection: string,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await listRecords(collection, {
      page: 1,
      limit: chunk.length,
      filter: JSON.stringify({ id: { in: chunk } }),
    });
    for (const r of res.records) out.set(String(r.id), labelFromRecord(r));
  }
  return out;
}
