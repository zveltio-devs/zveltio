/**
 * How Studio's `view/2` renderer reaches the engine (ADR 0042 slice 2). A view
 * names collections and actions; this module turns a name into the engine's
 * data API or action route, always as the signed-in user, so the engine's
 * rules decide every call. Plain TypeScript: the Svelte components only draw.
 */
import {
  actionPath,
  type Button,
  type Field,
  type SchemaField,
  toFilter,
  toSort,
  type ViewScope,
} from '@zveltio/sdk/view';
import type { FormField } from '@zveltio/sdk/extension';
import { api, dataApi } from '#lib/api.js';

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

export async function runAction(
  extension: string,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const res = await api.post<{ result: unknown }>(actionPath(extension, action), input);
  return res?.result ?? null;
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
  /** Runs a button: an action, a navigation (a form handles `save` itself). */
  press: (b: Button, scope: ViewScope) => Promise<void>;
  /** Runs an action with this input and acts on its result. */
  run: (action: string, input: Record<string, unknown>) => Promise<void>;
  /** Whether the caller may run an action (`GET /api/actions`); a hint, the engine decides. */
  canRun: (action: string) => boolean;
  /** Bumped after an action ran: lists and records read again. */
  version: number;
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
