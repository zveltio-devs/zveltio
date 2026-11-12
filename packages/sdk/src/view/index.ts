/**
 * `@zveltio/sdk/view` — the `zveltio.view/2` specification (ADR 0042).
 *
 * - `VIEW_SCHEMA`: the JSON Schema (also published as
 *   `@zveltio/sdk/view/schema.json`), the single source of the types below.
 * - `validateView`: what `zveltio extension validate` and `pack` run; the
 *   engine checks the same schema when it loads an extension.
 * - `viewNameIssues`: a view names only its extension's collections and
 *   actions, and a dependency's action.
 * - `view`, `$`: a typed builder that emits the JSON.
 *
 * Dependency-free: the validator interprets the subset of JSON Schema that
 * `VIEW_SCHEMA` uses, so a front end can validate in the browser.
 */

import { VIEW_SCHEMA, VIEW_SPEC } from './schema.js';
import type { Condition, Ref, Value, View, ViewId } from './types.generated.js';

export { VIEW_SCHEMA, VIEW_SPEC } from './schema.js';
export type * from './types.generated.js';

/** A view file: a view with `spec` set at its top, and its `id` a `ViewId`. */
export type ViewDocument = View & { spec: typeof VIEW_SPEC; id?: ViewId };

export interface ViewIssue {
  /** JSON Pointer to the offending value, `''` for the document. */
  path: string;
  message: string;
}

export type ViewValidation = { ok: true; view: ViewDocument } | { ok: false; issues: ViewIssue[] };

/** A `view/2` file declares itself; anything else (a `view/1` schema) is not one. */
export function isViewDocument(input: unknown): boolean {
  return isObj(input) && input.spec === VIEW_SPEC;
}

export function validateView(input: unknown): ViewValidation {
  if (!isViewDocument(input)) {
    return { ok: false, issues: [{ path: '/spec', message: `must be "${VIEW_SPEC}"` }] };
  }
  const issues: ViewIssue[] = [];
  check(VIEW_SCHEMA, input, '', issues);
  return issues.length === 0 ? { ok: true, view: input as ViewDocument } : { ok: false, issues };
}

export interface ViewNames {
  /** The collections the extension declares (manifest `collections`). */
  collections: Iterable<string>;
  /** The extension's own action names (manifest `actions[].name`). */
  actions: Iterable<string>;
  /** Its `dependencies` and `optionalDependencies`: their actions are `<dep>.<action>`. */
  dependencies?: Iterable<string>;
  /** The `id`s of the extension's view files; `navigate` and `open` name one. Omit to skip. */
  views?: Iterable<string>;
  /** The message keys a `Text` may name (its own `en.json` and the shared ones). Omit to skip. */
  messageKeys?: Iterable<string>;
}

/** Maps of values by name: their keys are the caller's, not references. */
const VALUE_MAPS = new Set(['input', 'params']);
const TEXT_SLOTS = new Set(['title', 'label', 'confirm']);
/** The same rule as `looksLikeMessageKey` in `@zveltio/sdk/validate`. */
const MESSAGE_KEY = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/i;

/**
 * What the schema cannot see in a (valid) view: a collection or action its
 * extension does not own, a `$selected` that names no earlier pane, a pane id
 * used twice, a `navigate`/`open` to no view of the extension, a message key
 * the extension does not ship. (`fallback` is an inline view, not a reference.)
 */
export function viewNameIssues(view: unknown, names: ViewNames): ViewIssue[] {
  const collections = new Set(names.collections);
  const actions = new Set(names.actions);
  const deps = new Set(names.dependencies ?? []);
  const views = names.views && new Set(names.views);
  const keys = names.messageKeys && new Set(names.messageKeys);
  const ids = new Set<string>();
  const out: ViewIssue[] = [];
  const issue = (path: string, message: string) => out.push({ path, message });

  // `panes`: the pane ids a `$selected` here may name. `valuesOnly`: inside an
  // input or params map, where only references are references.
  const walk = (
    v: unknown,
    path: string,
    panes: ReadonlySet<string>,
    valuesOnly: boolean,
  ): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}/${i}`, panes, valuesOnly));
      return;
    }
    if (!isObj(v)) return;
    let scope = panes;
    if (!valuesOnly && v.type === 'split' && Array.isArray(v.panes)) {
      const earlier = new Set(panes);
      v.panes.forEach((pane, i) => {
        walk(pane, `${path}/panes/${i}`, new Set(earlier), false);
        if (isObj(pane) && typeof pane.id === 'string') earlier.add(pane.id);
      });
      scope = earlier;
    }
    for (const [k, x] of Object.entries(v)) {
      const at = `${path}/${k}`;
      if (k === '$selected') {
        if (typeof x === 'string' && !panes.has(x)) {
          issue(at, `"${x}" is not an earlier pane of an enclosing split`);
        }
        continue;
      }
      if (valuesOnly) {
        walk(x, at, panes, true);
        continue;
      }
      if (k === 'panes' && v.type === 'split') continue;
      if (k === 'tones') continue;
      if (VALUE_MAPS.has(k)) {
        walk(x, at, scope, true);
      } else if (typeof x !== 'string') {
        walk(x, at, scope, false);
      } else if (k === 'collection' && !collections.has(x)) {
        issue(at, `collection "${x}" is not declared by this extension`);
      } else if (k === 'action') {
        const dot = x.lastIndexOf('.');
        if (dot < 0 ? !actions.has(x) : !deps.has(x.slice(0, dot))) {
          issue(
            at,
            dot < 0
              ? `action "${x}" is not declared by this extension`
              : `action "${x}" names "${x.slice(0, dot)}", which is not a dependency`,
          );
        }
      } else if (k === 'id' && path !== '') {
        if (ids.has(x)) issue(at, `pane id "${x}" is used twice`);
        ids.add(x);
      } else if ((k === 'navigate' || k === 'open') && views && !views.has(x)) {
        issue(at, `"${x}" is not the id of a view of this extension`);
      } else if (
        keys &&
        TEXT_SLOTS.has(k) &&
        !(k === 'label' && (v.type === 'map' || v.type === 'tree')) &&
        !keys.has(x) &&
        MESSAGE_KEY.test(x)
      ) {
        issue(at, `"${x}" is not a message key of this extension (studio/messages/en.json)`);
      }
    }
  };
  walk(view, '', new Set(), false);
  return out;
}

// ─── Builder ────────────────────────────────────────────────────────────────

type Kind = View['type'];
type Of<K extends Kind> = Extract<View, { type: K }>;
type Props<K extends Kind> =
  Of<K> extends infer T ? (T extends unknown ? Omit<T, 'type'> : never) : never;

/** Drops `undefined` keys (`sort: cond ? 'a' : undefined`) at every depth, as the file would. */
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const kind =
  <K extends Kind>(type: K) =>
  (props: Props<K>): Of<K> =>
    clean({ type, ...props }) as unknown as Of<K>;

/**
 * Typed constructors: `view.list({ collection: 'invoices', fields: ['number'] })`.
 * `view.document(v)` stamps `spec` on the top-level view; `JSON.stringify` it
 * into the file the manifest names.
 */
export const view = {
  list: kind('list'),
  form: kind('form'),
  detail: kind('detail'),
  board: kind('board'),
  timeline: kind('timeline'),
  tree: kind('tree'),
  matrix: kind('matrix'),
  map: kind('map'),
  stat: kind('stat'),
  split: kind('split'),
  tabs: kind('tabs'),
  document: (v: View, id?: ViewId): ViewDocument => clean({ ...v, spec: VIEW_SPEC, id }),
};

/** References and conditions: `$.record('id')`, `$.where('status', 'eq', 'open')`. */
export const $ = {
  record: (field: string): Ref => ({ $record: field }),
  selected: (pane: string): Ref => ({ $selected: pane }),
  selection: (field: string): Ref => ({ $selection: field }),
  param: (name: string): Ref => ({ $param: name }),
  user: (): Ref => ({ $user: 'id' }),
  today: (): Ref => ({ $today: true }),
  where: (field: string, op: Condition['op'], value?: Value): Condition =>
    (value === undefined ? { field, op } : { field, op, value }) as Condition,
};

// ─── The JSON Schema subset `VIEW_SCHEMA` uses ──────────────────────────────

type Schema = Record<string, unknown>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resolve(s: Schema): Schema {
  let cur = s;
  while (typeof cur.$ref === 'string') {
    const name = cur.$ref.replace('#/$defs/', '');
    cur = (VIEW_SCHEMA.$defs as Record<string, Schema>)[name] as Schema;
  }
  return cur;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

const show = (v: unknown) => JSON.stringify(v);

/** The values a schema (or a union of them) accepts for `key`: a view's `type`, a condition's `op`. */
function accepts(schema: Schema, key: string): unknown[] {
  const s = resolve(schema);
  if (Array.isArray(s.anyOf)) return (s.anyOf as Schema[]).flatMap((b) => accepts(b, key));
  const p = (s.properties as Record<string, Schema> | undefined)?.[key];
  return p ? (Array.isArray(p.enum) ? p.enum : [p.const]) : [];
}

function check(schema: Schema, v: unknown, path: string, out: ViewIssue[]): void {
  const s = resolve(schema);
  const at = (message: string) => out.push({ path, message });
  if ('const' in s && v !== s.const) return void at(`must be ${show(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    return void at(`must be one of ${s.enum.map(show).join(', ')}`);
  }
  if (s.type !== undefined) {
    const want = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(v);
    if (!want.includes(t) && !(t === 'integer' && want.includes('number'))) {
      return void at(`must be ${want.join(' or ')}`);
    }
  }
  const branches = s.anyOf as Schema[] | undefined;
  if (branches) {
    const results = branches.map((b) => {
      const errs: ViewIssue[] = [];
      check(b, v, path, errs);
      return errs;
    });
    if (results.some((r) => r.length === 0)) return;
    // Report the closest form: among those whose `type` or `op` matches if any, the
    // one whose shape the value has (its issues sit deeper), else the fewest.
    const named = results.filter(
      (_, i) =>
        isObj(v) &&
        (['type', 'op'] as const).some(
          (k) => typeof v[k] === 'string' && accepts(branches[i] as Schema, k).includes(v[k]),
        ),
    );
    const score = (r: ViewIssue[]) => r.filter((i) => i.path === path).length * 1000 + r.length;
    out.push(
      ...(named.length > 0 ? named : results).reduce((a, b) => (score(b) < score(a) ? b : a)),
    );
    return;
  }
  if (typeof v === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) {
      at(`${show(v)} must match ${s.pattern}`);
    }
    if (typeof s.minLength === 'number' && v.length < s.minLength) at('must not be empty');
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) {
      at(`must be at most ${s.maxLength} characters`);
    }
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) at(`must be at least ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) at(`must be at most ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) {
      at(`must have at least ${s.minItems} item(s)`);
    }
    if (isObj(s.items)) v.forEach((x, i) => check(s.items as Schema, x, `${path}/${i}`, out));
  }
  if (isObj(v)) {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) {
      if (!Object.hasOwn(v, r)) at(`needs "${r}"`);
    }
    for (const [k, x] of Object.entries(v)) {
      const p = `${path}/${k}`;
      if (Object.hasOwn(props, k)) check(props[k] as Schema, x, p, out);
      else if (s.additionalProperties === false)
        out.push({ path: p, message: 'is not part of view/2' });
      else if (isObj(s.additionalProperties)) check(s.additionalProperties, x, p, out);
    }
  }
}
