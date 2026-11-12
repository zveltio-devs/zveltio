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
import type { Condition, Ref, Value, View } from './types.generated.js';

export { VIEW_SCHEMA, VIEW_SPEC } from './schema.js';
export type * from './types.generated.js';

/** A view file: a view with `spec` set at its top. */
export type ViewDocument = View & { spec: typeof VIEW_SPEC };

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
}

/** Collections and actions a (valid) view names that its extension does not own. */
export function viewNameIssues(view: unknown, names: ViewNames): ViewIssue[] {
  const collections = new Set(names.collections);
  const actions = new Set(names.actions);
  const deps = new Set(names.dependencies ?? []);
  const out: ViewIssue[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}/${i}`));
      return;
    }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const at = `${path}/${k}`;
      if (k === 'collection' && typeof x === 'string' && !collections.has(x)) {
        out.push({ path: at, message: `collection "${x}" is not declared by this extension` });
      } else if (k === 'action' && typeof x === 'string') {
        const dot = x.lastIndexOf('.');
        const ok = dot < 0 ? actions.has(x) : deps.has(x.slice(0, dot));
        if (!ok) {
          out.push({
            path: at,
            message:
              dot < 0
                ? `action "${x}" is not declared by this extension`
                : `action "${x}" names "${x.slice(0, dot)}", which is not a dependency`,
          });
        }
      } else {
        walk(x, at);
      }
    }
  };
  walk(view, '');
  return out;
}

// ─── Builder ────────────────────────────────────────────────────────────────

type Kind = View['type'];
type Of<K extends Kind> = Extract<View, { type: K }>;
type Props<K extends Kind> =
  Of<K> extends infer T ? (T extends unknown ? Omit<T, 'type'> : never) : never;

const kind =
  <K extends Kind>(type: K) =>
  (props: Props<K>): Of<K> =>
    ({ type, ...props }) as unknown as Of<K>;

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
  document: (v: View): ViewDocument => ({ ...v, spec: VIEW_SPEC }),
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
    value === undefined ? { field, op } : { field, op, value },
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

/** The `type` consts a schema (a view kind, or a union of them) accepts. */
function kindsOf(schema: Schema): unknown[] {
  const s = resolve(schema);
  if (Array.isArray(s.anyOf)) return (s.anyOf as Schema[]).flatMap(kindsOf);
  return [((s.properties as Record<string, Schema> | undefined)?.type ?? {}).const];
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
    // Report the closest form: among the view kinds `type` names if any, the
    // one whose shape the value has (its issues sit deeper), else the fewest.
    const named = results.filter(
      (_, i) => isObj(v) && typeof v.type === 'string' && kindsOf(branches[i]).includes(v.type),
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
      if (!(r in v)) at(`needs "${r}"`);
    }
    for (const [k, x] of Object.entries(v)) {
      const p = `${path}/${k}`;
      if (props[k]) check(props[k], x, p, out);
      else if (s.additionalProperties === false)
        out.push({ path: p, message: 'is not part of view/2' });
      else if (isObj(s.additionalProperties)) check(s.additionalProperties, x, p, out);
    }
  }
}
