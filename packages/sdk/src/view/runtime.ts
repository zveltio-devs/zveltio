/**
 * What every `view/2` renderer does the same way, in plain TypeScript, so a
 * Svelte, React or Vue front end draws a view and only draws it (ADR 0042
 * decision 8): fill in references, turn conditions into a data API filter,
 * check a `when`, generate the default list, form and detail of a collection,
 * and read an action's result.
 *
 * Nothing here evaluates an expression or reaches a URL a view carries: a view
 * carries none. The data API and action paths below are the engine's, named by
 * the front end; the engine's rules decide every call.
 */

import type {
  Button,
  Condition,
  Conditions,
  Field,
  Fields,
  FileHandoff,
  Input,
  Literal,
  Ref,
  Sort,
  Value,
  View,
} from './types.generated.js';

/** What references read. Anything missing leaves the reference unresolved. */
export interface ViewScope {
  /** The current record (`$record`). */
  record?: Record<string, unknown>;
  /** Pane id → the id of the record selected in it (`$selected`). */
  selected?: Record<string, unknown>;
  /** The selected rows of a list (`$selection`). */
  selection?: Record<string, unknown>[];
  /** The parameters the view was opened with (`$param`). */
  params?: Record<string, unknown>;
  /** The signed-in user's id (`$user`). */
  user?: string;
  /** `YYYY-MM-DD` (`$today`); defaults to the local date. */
  today?: string;
}

const isRef = (v: unknown): v is Ref =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v)[0]?.startsWith('$');

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A value with its references filled in; `undefined` when one cannot be. */
export function resolveValue(v: Value, s: ViewScope): unknown {
  if (Array.isArray(v)) {
    const out = v.map((x) => resolveValue(x as Literal | Ref, s));
    return out.some((x) => x === undefined) ? undefined : out;
  }
  if (!isRef(v)) return v;
  if ('$record' in v) return s.record?.[v.$record];
  if ('$selected' in v) return s.selected?.[v.$selected];
  if ('$selection' in v) return s.selection?.map((r) => r[v.$selection]);
  if ('$param' in v) return s.params?.[v.$param];
  if ('$user' in v) return s.user;
  return s.today ?? localToday();
}

/** An action's input or a view's parameters, resolved; `null` when a reference is not. */
export function resolveInput(
  input: Input | undefined,
  s: ViewScope,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const r = resolveValue(v, s);
    if (r === undefined) return null;
    out[k] = r;
  }
  return out;
}

/**
 * The ids of stored files in a value: an id, a `file` field's value
 * (`{ id, name, size, type }`), or a list of either.
 */
export function fileIds(v: unknown): string[] {
  const one = (x: unknown): string[] =>
    typeof x === 'string' && x
      ? [x]
      : typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string'
        ? [(x as { id: string }).id]
        : [];
  return [...new Set(Array.isArray(v) ? v.flatMap(one) : one(v))];
}

/**
 * A button's `files` as the action request's `$files` (ADR 0032): `undefined`
 * when it hands nothing (no button `files`, or a `read` with no file),
 * `null` while a reference has no value yet.
 */
export function resolveFiles(
  files: FileHandoff | undefined,
  s: ViewScope,
): { read?: string[]; write?: { name: string; maxBytes?: number } } | null | undefined {
  if (!files) return undefined;
  const out: { read?: string[]; write?: { name: string; maxBytes?: number } } = {};
  if (files.read !== undefined) {
    const v = resolveValue(files.read, s);
    if (v === undefined) return null;
    const ids = fileIds(v);
    if (ids.length) out.read = ids;
  }
  if (files.write) {
    const name = resolveValue(files.write.name, s);
    const max =
      files.write.maxBytes === undefined ? undefined : resolveValue(files.write.maxBytes, s);
    if (name === undefined || (files.write.maxBytes !== undefined && max === undefined))
      return null;
    // A bigint column reads as a string through the data API.
    const bytes = typeof max === 'string' && max.trim() !== '' ? Number(max) : max;
    out.write = {
      name: String(name),
      ...(typeof bytes === 'number' && Number.isFinite(bytes) ? { maxBytes: bytes } : {}),
    };
  }
  return out.read || out.write ? out : undefined;
}

/**
 * Every reference a button carries (`input`, `params`, `files`) has a value in
 * `s`. A button that is not bound is drawn disabled and never sent (no row
 * selected in the pane it names). What it `prompt`s for is no reference.
 */
export function isBound(b: Button, s: ViewScope): boolean {
  if ('navigate' in b) return resolveInput(b.params, s) !== null;
  if ('action' in b) return resolveInput(b.input, s) !== null && resolveFiles(b.files, s) !== null;
  return true;
}

/**
 * Conditions as the data API's JSON `filter` (`{"field":{"op":value}}`); `null`
 * while a reference has no value yet (no row selected in the pane it names).
 */
export function toFilter(
  conds: Conditions | undefined,
  s: ViewScope,
): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of conds ?? []) {
    let value: unknown = true;
    if ('value' in c) {
      value = resolveValue(c.value as Value, s);
      if (value === undefined) return null;
    }
    // The data API takes one value per field and operator; `validateView` refuses the pair twice.
    if (out[c.field] && c.op in out[c.field]) {
      throw new Error(`view/2: "${c.field}" ${c.op} is given twice in one condition list`);
    }
    out[c.field] = { ...out[c.field], [c.op]: value };
  }
  return out;
}

const cmp = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a ?? '').localeCompare(String(b ?? ''));

function holds(c: Condition, row: Record<string, unknown>, s: ViewScope): boolean {
  const have = row[c.field];
  if (!('value' in c)) return c.op === 'null' ? have == null : have != null;
  const want = resolveValue(c.value, s);
  if (want === undefined) return false;
  const text = String(have ?? '').toLowerCase();
  const w = String(want).toLowerCase();
  switch (c.op) {
    case 'eq':
      return have === want || String(have) === String(want);
    case 'neq':
      return !(have === want || String(have) === String(want));
    case 'in':
    case 'not_in': {
      const list = (Array.isArray(want) ? want : [want]).map(String);
      return list.includes(String(have)) === (c.op === 'in');
    }
    case 'lt':
      return cmp(have, want) < 0;
    case 'lte':
      return cmp(have, want) <= 0;
    case 'gt':
      return cmp(have, want) > 0;
    case 'gte':
      return cmp(have, want) >= 0;
    case 'like':
    case 'ilike':
      return text.includes(w);
    case 'not_contains':
      return !text.includes(w);
    case 'starts_with':
      return text.startsWith(w);
    case 'ends_with':
      return text.endsWith(w);
    default:
      // `near`, `within`: the engine answers them; a row on screen cannot.
      return false;
  }
}

/** Whether a row meets every condition (`when`, `emphasisWhen`). No conditions: true. */
export function matches(
  conds: Conditions | undefined,
  row: Record<string, unknown>,
  s: ViewScope,
): boolean {
  return (conds ?? []).every((c) => holds(c, row, s));
}

/** The data API's `sort` and `order` for a view's `sort` (its first field). */
export function toSort(sort: Sort | undefined): { sort: string; order: 'asc' | 'desc' } | null {
  const first = Array.isArray(sort) ? sort[0] : sort;
  if (!first) return null;
  return first.startsWith('-')
    ? { sort: first.slice(1), order: 'desc' }
    : { sort: first, order: 'asc' };
}

export const fieldName = (f: Field): string => (typeof f === 'string' ? f : f.field);

/** A field as the data API describes it (`GET /api/data`, `GET /api/collections/:name`). */
export interface SchemaField {
  name: string;
  type: string;
  is_system?: boolean;
  [key: string]: unknown;
}

/** Field types a generated form does not offer: the engine computes them. */
const NOT_EDITABLE = new Set(['computed']);

/** Whether a form may write the field: not a system, computed or read-only one. */
export function isEditable(f: SchemaField): boolean {
  return !f.is_system && !NOT_EDITABLE.has(f.type) && f.readonly !== true;
}

/**
 * The fields a generated view shows: no system or computed field; a list
 * stops at eight columns so a wide collection stays readable.
 */
export function defaultFields<F extends SchemaField>(
  fields: readonly F[],
  kind: 'list' | 'form' | 'detail',
): F[] {
  const own = fields.filter((f) => !f.is_system && !NOT_EDITABLE.has(f.type));
  if (kind === 'list') return own.slice(0, 8);
  if (kind === 'form') return own.filter(isEditable);
  return own;
}

/** The generated default of a collection: a view writes only what differs from it. */
export function defaultView(
  kind: 'list' | 'form' | 'detail',
  collection: string,
  fields: readonly SchemaField[],
): View {
  const names = defaultFields(fields, kind).map((f) => f.name);
  if (kind === 'list') return { type: 'list', collection, fields: names, search: true };
  if (kind === 'form') return { type: 'form', collection, fields: names };
  return { type: 'detail', collection, record: { $param: 'id' }, fields: names };
}

/** A view's fields, or the collection's default ones when it names none. */
export function viewFields(
  fields: Fields | undefined,
  schema: readonly SchemaField[],
  kind: 'list' | 'form' | 'detail',
): Fields {
  return fields?.length ? fields : defaultFields(schema, kind).map((f) => f.name);
}

/**
 * What a front end that does not draw `view.type` draws instead: the view's own
 * `fallback`, else the generated list of its collection (ADR 0042 decision 6).
 * `null` when there is neither (a container it does not know).
 */
export function fallbackFor(view: View, drawn: ReadonlySet<string>): View | null {
  let v: View | undefined = view;
  while (v && !drawn.has(v.type)) v = v.fallback;
  if (v) return v;
  return 'collection' in view ? { type: 'list', collection: view.collection } : null;
}

/** The engine path that runs an action: its own extension's, or `<dependency>.<action>`. */
export function actionPath(extension: string, action: string): string {
  const dot = action.indexOf('.');
  const [ext, name] = dot < 0 ? [extension, action] : [action.slice(0, dot), action.slice(dot + 1)];
  // The manifest's rules (`ActionName`): no `.`/`..` segment, nothing to encode.
  if (!EXTENSION_NAME.test(ext) || !ACTION.test(name)) {
    throw new Error(`view/2: "${action}" is not an action of "${extension}" or a dependency`);
  }
  return `/ext/${ext}/actions/${name}`;
}

/** An extension name (`finance/quotes`): segments that start with a letter. */
const EXTENSION_NAME = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;
/** An action name, as the manifest's `actions[].name`. */
const ACTION = /^[a-z][a-zA-Z0-9]*$/;
