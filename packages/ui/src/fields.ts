/**
 * How the kit's generic collection screens (`CollectionList`, `CollectionForm`;
 * ADR 0007 item 3) draw and read a field, from nothing but its type. A
 * collection with screens of its own never comes here; these are what every
 * other collection gets.
 */

export type InputKind =
  | 'checkbox'
  | 'number'
  | 'date'
  | 'datetime-local'
  | 'time'
  | 'email'
  | 'url'
  | 'color'
  | 'textarea'
  | 'json'
  | 'text';

/** Relations and computed values are not columns a form writes. */
const NOT_A_COLUMN = new Set(['o2m', 'm2m', 'm2a', 'computed']);

const KIND: Record<string, InputKind> = {
  boolean: 'checkbox',
  integer: 'number',
  smallint: 'number',
  number: 'number',
  float: 'number',
  real: 'number',
  decimal: 'number',
  money: 'number',
  date: 'date',
  datetime: 'datetime-local',
  time: 'time',
  email: 'email',
  url: 'url',
  color: 'color',
  textarea: 'textarea',
  richtext: 'textarea',
  json: 'json',
  tags: 'json',
  location: 'json',
};

export function isWritable(field: { type: string; readonly?: boolean }): boolean {
  return !field.readonly && !NOT_A_COLUMN.has(field.type);
}

/** A column the list can order by; relations and computed values are not columns. */
export function isSortable(field: { type?: string }): boolean {
  return !NOT_A_COLUMN.has(field.type ?? '');
}

export function inputKind(type: string): InputKind {
  return KIND[type] ?? 'text';
}

/** A stored value as the input holds it. */
export function toInput(kind: InputKind, value: unknown): string | boolean {
  if (kind === 'checkbox') return value === true;
  if (value === null || value === undefined) return '';
  if (kind === 'json') return JSON.stringify(value, null, 2);
  // `datetime-local` takes `YYYY-MM-DDTHH:mm:ss` (with `step="1"`), in local
  // time. To the minute only, saving any edit dropped the stored seconds.
  if (kind === 'datetime-local') {
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  }
  if (kind === 'date') return String(value).slice(0, 10);
  return String(value);
}

/**
 * An input that cannot become the value its column takes. The kit has no
 * catalogue: the host words it from `field` and `reason`.
 */
export class FieldValueError extends Error {
  constructor(
    readonly field: string,
    readonly reason: 'number' | 'json',
  ) {
    super(`${field}: not a valid ${reason}`);
  }
}

/**
 * What the input holds, as the API takes it. An empty input is `null`, not `''`:
 * an empty string in a number or date column is a 400, and in a text column it
 * is a value the user did not type. Malformed JSON or a non-number throws a `FieldValueError` naming the field.
 */
export function fromInput(kind: InputKind, raw: string | boolean, name: string): unknown {
  if (kind === 'checkbox') return raw === true;
  const s = String(raw);
  if (s.trim() === '') return null;
  if (kind === 'number') {
    const n = Number(s);
    if (Number.isNaN(n)) throw new FieldValueError(name, 'number');
    return n;
  }
  if (kind === 'json') {
    try {
      return JSON.parse(s);
    } catch {
      throw new FieldValueError(name, 'json');
    }
  }
  if (kind === 'datetime-local') return new Date(s).toISOString();
  return s;
}

/** A cell in the list: short, and never an object dumped as `[object Object]`. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** The engine's filter operators the kit offers (`?field[op]=value`). */
export type FilterOp =
  | 'contains'
  | 'eq'
  | 'neq'
  | 'starts_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'is_not_null';

export interface CollectionFilter {
  field: string;
  op: FilterOp;
  /** As typed; `''` for `is_null` and `is_not_null`. */
  value: string;
}

const EMPTY_OPS: FilterOp[] = ['is_null', 'is_not_null'];
const ORDERED_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...EMPTY_OPS];
const OPS: Partial<Record<InputKind, FilterOp[]>> = {
  number: ORDERED_OPS,
  date: ORDERED_OPS,
  'datetime-local': ORDERED_OPS,
  time: ORDERED_OPS,
  checkbox: ['eq', ...EMPTY_OPS],
  color: ['eq', 'neq', ...EMPTY_OPS],
  json: EMPTY_OPS,
};

/** The operators a field can be filtered by; none for a relation or a computed value. */
export function filterOps(field: { type: string }): FilterOp[] {
  if (!isSortable(field)) return [];
  return OPS[inputKind(field.type)] ?? ['contains', 'eq', 'neq', 'starts_with', ...EMPTY_OPS];
}

export function needsValue(op: FilterOp): boolean {
  return !EMPTY_OPS.includes(op);
}

const BRACKET = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-z_]+)\]$/;

/**
 * The filters a URL names (`?title[contains]=x`), only on a field the user sees
 * and with an operator that field takes; anything else is dropped, as the
 * engine would answer it with a 400 or a 500.
 */
export function readFilters(
  params: URLSearchParams,
  fields: Array<{ name: string; type: string }>,
): CollectionFilter[] {
  const out: CollectionFilter[] = [];
  for (const [key, value] of params) {
    const m = BRACKET.exec(key);
    const field = m && fields.find((f) => f.name === m[1]);
    const op = m?.[2] as FilterOp | undefined;
    if (field && op && filterOps(field).includes(op))
      out.push({ field: field.name, op, value: needsValue(op) ? value : '' });
  }
  return out;
}

/** The words a filter UI needs; the kit has no catalogue. */
export interface FilterLabels {
  add: string;
  remove: string;
  field: string;
  op: string;
  value: string;
  yes: string;
  no: string;
  ops: Record<FilterOp, string>;
}

export const filterParam = (f: CollectionFilter): string => `${f.field}[${f.op}]`;

/** A filter's value as the engine compares it: a local date-time becomes an instant. */
export function filterValue(f: CollectionFilter, field: { type: string }): string {
  if (inputKind(field.type) !== 'datetime-local' || !f.value) return f.value;
  const d = new Date(f.value);
  return Number.isNaN(d.getTime()) ? f.value : d.toISOString();
}
