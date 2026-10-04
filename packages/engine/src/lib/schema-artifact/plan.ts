/**
 * Schema as code, step 2 (docs/engine/rfc-schema-as-code.md §6): the plan.
 *
 * `planSchema(current, desired)` compares two file sets — the live schema as
 * `exportSchema` writes it, and the files a caller sends — and returns the
 * steps that would make the instance match the files. It is pure: the route
 * passes `exportSchema(db)` as `current`, so "what the instance has" has one
 * definition, and the comparison is of the same canonical form on both sides.
 *
 * `destructive` marks a step that loses data or access no file can bring back:
 * a dropped collection or field, a field type change, a removed role. Step 3
 * makes `apply` refuse those without a migration.
 */

import { exportField, SCHEMA_FORMAT, serialize } from './export.js';

export interface PlanStep {
  /** `+` adds, `-` removes, `~` changes. */
  change: '+' | '-' | '~';
  /** Collection name, or `role <name>` for a role. */
  target: string;
  /** What happens, in words: `add field summary (text)`. */
  action: string;
  destructive?: true;
}

export class SchemaFileError extends Error {}

type Obj = Record<string, unknown>;

/**
 * The top-level keys `exportSchema` writes in a collection file; anything else
 * is refused. A field's own keys are the collection API's to validate (step 3).
 */
const COLLECTION_KEYS = new Set([
  '$schema',
  'name',
  'displayName',
  'singularName',
  'description',
  'icon',
  'routeGroup',
  'isPermissioned',
  'sort',
  'sourceType',
  'virtualConfig',
  'schemaLocked',
  'inheritDown',
  'aiSearchEnabled',
  'aiSearchField',
  'aiEmbedExcludedFields',
  'fields',
  'relations',
  'rowRules',
  'columnPermissions',
  'validation',
]);

/** Collection keys that are lists of entries, each diffed by its natural key. */
const LISTS: {
  key: string;
  noun: string;
  id: (e: Obj) => string;
  canon?: (e: Obj) => Obj;
}[] = [
  { key: 'relations', noun: 'relation', id: (e) => String(e.name) },
  {
    key: 'rowRules',
    noun: 'row rule',
    id: (e) => `${e.role}: ${e.field} ${e.op} ${e.value}`,
    canon: (e) => ({ ...e, enabled: e.enabled === true ? null : e.enabled }),
  },
  { key: 'columnPermissions', noun: 'column permission', id: (e) => `${e.role}: ${e.column}` },
  {
    key: 'validation',
    noun: 'validation',
    id: (e) => `${e.field} ${e.rule} ${serialize(e.config ?? null).trim()}`,
    canon: (e) => ({ ...e, active: e.active === true ? null : e.active }),
  },
];

const same = (a: unknown, b: unknown) => serialize(a ?? null) === serialize(b ?? null);
const show = (v: unknown) => (v === undefined || v === null ? '(unset)' : JSON.stringify(v));

function parse(path: string, content: unknown): Obj {
  if (typeof content !== 'string') throw new SchemaFileError(`${path}: content must be a string`);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (err) {
    throw new SchemaFileError(`${path}: ${(err as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaFileError(`${path}: must be a JSON object`);
  }
  return value as Obj;
}

function list(path: string, value: unknown, key: string): Obj[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((e) => !e || typeof e !== 'object')) {
    throw new SchemaFileError(`${path}: ${key} must be an array of objects`);
  }
  return value as Obj[];
}

interface Parsed {
  collections: Map<string, Obj>;
  roles: Map<string, Obj>;
}

/** Reads a file set. Unknown paths and keys are refused, not ignored. */
function read(files: Record<string, unknown>): Parsed {
  const out: Parsed = { collections: new Map(), roles: new Map() };
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new SchemaFileError('files must be an object of path → content');
  }
  for (const required of ['zveltio-schema.json', 'roles.json']) {
    if (!(required in files)) throw new SchemaFileError(`${required} is missing`);
  }
  for (const [path, content] of Object.entries(files)) {
    const file = parse(path, content);
    if (path === 'zveltio-schema.json') {
      if (file.format !== SCHEMA_FORMAT) {
        throw new SchemaFileError(
          `${path}: format ${show(file.format)} is not supported (this engine reads ${SCHEMA_FORMAT})`,
        );
      }
    } else if (path === 'roles.json') {
      for (const role of list(path, file.roles, 'roles')) {
        if (typeof role.name !== 'string' || !role.name) {
          throw new SchemaFileError(`${path}: every role needs a name`);
        }
        if (out.roles.has(role.name)) throw new SchemaFileError(`${path}: role ${role.name} twice`);
        list(path, role.permissions, `${role.name}.permissions`);
        out.roles.set(role.name, role);
      }
    } else {
      const name = /^collections\/([^/]+)\.json$/.exec(path)?.[1];
      if (!name) throw new SchemaFileError(`${path}: not a schema file`);
      if (file.name !== name) {
        throw new SchemaFileError(`${path}: name ${show(file.name)} does not match the file name`);
      }
      const unknown = Object.keys(file).filter((k) => !COLLECTION_KEYS.has(k));
      if (unknown.length) throw new SchemaFileError(`${path}: unknown key ${unknown.join(', ')}`);
      const fields = list(path, file.fields, 'fields');
      const seen = new Set<string>();
      for (const f of fields) {
        if (typeof f.name !== 'string' || !f.name || typeof f.type !== 'string') {
          throw new SchemaFileError(`${path}: every field needs a name and a type`);
        }
        if (seen.has(f.name)) throw new SchemaFileError(`${path}: field ${f.name} twice`);
        seen.add(f.name);
      }
      for (const { key } of LISTS) list(path, file[key], key);
      out.collections.set(name, file);
    }
  }
  return out;
}

function diffCollection(name: string, cur: Obj, des: Obj, steps: PlanStep[]) {
  const step = (change: PlanStep['change'], action: string, destructive?: boolean) =>
    steps.push({ change, target: name, action, ...(destructive ? { destructive: true } : {}) });

  for (const key of [...COLLECTION_KEYS].sort()) {
    if (key === '$schema' || key === 'name' || key === 'fields') continue;
    if (LISTS.some((l) => l.key === key)) continue;
    if (!same(cur[key], des[key])) step('~', `set ${key} ${show(cur[key])} → ${show(des[key])}`);
  }

  const curFields = list(name, cur.fields, 'fields');
  const desFields = list(name, des.fields, 'fields').map(exportField);
  const curByName = new Map(curFields.map((f) => [f.name as string, f]));
  const desNames = new Set(desFields.map((f) => f.name as string));
  for (const f of curFields) {
    if (!desNames.has(f.name as string)) step('-', `drop field ${f.name}`, true);
  }
  for (const f of desFields) {
    const old = curByName.get(f.name as string);
    if (!old) {
      step('+', `add field ${f.name} (${f.type})`);
    } else if (old.type !== f.type) {
      step('~', `change field ${f.name} type ${old.type} → ${f.type}`, true);
    } else if (!same(old, f)) {
      const keys = [...new Set([...Object.keys(old), ...Object.keys(f)])]
        .filter((k) => !same(old[k], f[k]))
        .sort();
      step('~', `alter field ${f.name} (${keys.join(', ')})`);
    }
  }
  const kept = (fs: Obj[]) => fs.map((f) => f.name).filter((n) => curByName.has(n as string));
  const order = kept(desFields);
  if (
    !same(
      kept(curFields).filter((n) => desNames.has(n as string)),
      order,
    )
  ) {
    step('~', `reorder fields (${order.join(', ')})`);
  }

  for (const { key, noun, id, canon = (e: Obj) => e } of LISTS) {
    const curList = new Map(list(name, cur[key], key).map((e) => [id(e), canon(e)]));
    const desList = new Map(list(name, des[key], key).map((e) => [id(e), canon(e)]));
    for (const [k] of curList) if (!desList.has(k)) step('-', `remove ${noun} ${k}`);
    for (const [k, e] of desList) {
      const old = curList.get(k);
      if (!old) step('+', `add ${noun} ${k}`);
      else if (!same(old, e)) step('~', `alter ${noun} ${k}`);
    }
  }
}

function grants(role: Obj | undefined): Set<string> {
  const out = new Set<string>();
  for (const p of (role?.permissions as Obj[] | undefined) ?? []) {
    for (const a of (p.actions as unknown[] | undefined) ?? []) out.add(`${p.resource} ${a}`);
  }
  return out;
}

/**
 * The steps that turn `current` into `desired`, both `{ path: content }` as
 * `exportSchema` returns them. Throws `SchemaFileError` on a malformed file.
 * The order is stable: collections by name, then roles by name.
 */
export function planSchema(
  current: Record<string, string>,
  desired: Record<string, unknown>,
): PlanStep[] {
  const cur = read(current);
  const des = read(desired);
  const steps: PlanStep[] = [];

  const names = [...new Set([...cur.collections.keys(), ...des.collections.keys()])].sort();
  for (const name of names) {
    const c = cur.collections.get(name);
    const d = des.collections.get(name);
    if (!d) {
      steps.push({ change: '-', target: name, action: 'drop collection', destructive: true });
    } else if (!c) {
      const n = list(name, d.fields, 'fields').length;
      steps.push({ change: '+', target: name, action: `create collection (${n} fields)` });
      // Its settings and fields are the creation; its lists show as additions.
      const created: Obj = { ...d, fields: list(name, d.fields, 'fields').map(exportField) };
      for (const { key } of LISTS) created[key] = [];
      diffCollection(name, created, d, steps);
    } else {
      diffCollection(name, c, d, steps);
    }
  }

  const roles = [...new Set([...cur.roles.keys(), ...des.roles.keys()])].sort();
  for (const name of roles) {
    const c = cur.roles.get(name);
    const d = des.roles.get(name);
    const target = `role ${name}`;
    if (!d) {
      steps.push({ change: '-', target, action: 'remove role', destructive: true });
      continue;
    }
    if (!c) steps.push({ change: '+', target, action: 'create role' });
    else if (!same(c.description, d.description)) {
      steps.push({ change: '~', target, action: `set description ${show(d.description)}` });
    }
    const had = grants(c);
    const has = grants(d);
    for (const g of [...had].sort()) {
      if (!has.has(g)) steps.push({ change: '-', target, action: `revoke ${g}` });
    }
    for (const g of [...has].sort()) {
      if (!had.has(g)) steps.push({ change: '+', target, action: `grant ${g}` });
    }
  }

  return steps;
}
