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

import { exportField, isDefaultGrant, SCHEMA_FORMAT, serialize } from './export.js';

export interface PlanStep {
  /** `+` adds, `-` removes, `~` changes. */
  change: '+' | '-' | '~';
  /** Collection name, or `role <name>` for a role. */
  target: string;
  /** What happens, in words: `add field summary (text)`. */
  action: string;
  destructive?: true;
  /**
   * What `apply` runs for this step. Absent while `apply` cannot run it yet
   * (RFC step 3b: removals, alterations, rules, migrations); `apply` then
   * refuses the whole plan before changing anything.
   */
  op?: ApplyOp;
}

export type ApplyOp =
  | { kind: 'createCollection'; definition: Obj }
  | { kind: 'addField'; collection: string; field: Obj }
  | { kind: 'setCollection'; collection: string; key: string; value: unknown }
  | { kind: 'reorderFields'; collection: string; order: string[] }
  /** Adds an entry of a collection list, or changes the one with the same natural key. */
  | { kind: 'putEntry'; collection: string; list: EntryList; entry: Obj }
  | { kind: 'removeEntry'; collection: string; list: EntryList; entry: Obj }
  | { kind: 'createRole'; name: string; description?: string }
  | { kind: 'setRole'; name: string; description: string | null }
  | { kind: 'grant'; role: string; resource: string; action: string }
  | { kind: 'revoke'; role: string; resource: string; action: string };

/** The collection lists `apply` writes entry by entry. */
export type EntryList = 'rowRules' | 'columnPermissions' | 'validation';

export class SchemaFileError extends Error {}

type Obj = Record<string, unknown>;

/** Collection keys `CollectionSchema` takes, so a create can carry them. */
const CREATE_KEYS = [
  'name',
  'displayName',
  'singularName',
  'description',
  'icon',
  'routeGroup',
  'isPermissioned',
  'sort',
  'schemaLocked',
  'aiSearchEnabled',
  'aiSearchField',
  'fields',
];

/** Settings `DDLManager.updateCollectionMetadata` writes (it skips an empty name or icon). */
const canSet = (key: string, value: unknown) =>
  key === 'description' ||
  ((key === 'displayName' || key === 'icon') && typeof value === 'string' && value !== '');

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
  /** Absent while `apply` cannot write this list's entries. */
  entries?: EntryList;
  noun: string;
  id: (e: Obj) => string;
  canon?: (e: Obj) => Obj;
}[] = [
  { key: 'relations', noun: 'relation', id: (e) => String(e.name) },
  {
    key: 'rowRules',
    entries: 'rowRules',
    noun: 'row rule',
    id: (e) => `${e.role}: ${e.field} ${e.op} ${e.value}`,
    canon: (e) => ({ ...e, enabled: e.enabled === true ? null : e.enabled }),
  },
  {
    key: 'columnPermissions',
    entries: 'columnPermissions',
    noun: 'column permission',
    id: (e) => `${e.role}: ${e.column}`,
  },
  {
    key: 'validation',
    entries: 'validation',
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
  const step = (change: PlanStep['change'], action: string, destructive?: boolean, op?: ApplyOp) =>
    steps.push({
      change,
      target: name,
      action,
      ...(destructive ? { destructive: true } : {}),
      ...(op ? { op } : {}),
    });

  for (const key of [...COLLECTION_KEYS].sort()) {
    if (key === '$schema' || key === 'name' || key === 'fields') continue;
    if (LISTS.some((l) => l.key === key)) continue;
    // A setting the file leaves out keeps the instance's value: creating a
    // collection fills defaults (icon, routeGroup, sort…), and a hand-written
    // file without them must not show drift forever. `pull` writes every one.
    if (des[key] === undefined || des[key] === null || same(cur[key], des[key])) continue;
    const op: ApplyOp | undefined = canSet(key, des[key])
      ? { kind: 'setCollection', collection: name, key, value: des[key] ?? null }
      : undefined;
    step('~', `set ${key} ${show(cur[key])} → ${show(des[key])}`, false, op);
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
      step('+', `add field ${f.name} (${f.type})`, false, {
        kind: 'addField',
        collection: name,
        field: f,
      });
    } else if (old.type !== f.type) {
      step('~', `change field ${f.name} type ${old.type} → ${f.type}`, true);
    } else if (!same(old, f)) {
      const keys = [...new Set([...Object.keys(old), ...Object.keys(f)])]
        .filter((k) => !same(old[k], f[k]))
        .sort();
      step('~', `alter field ${f.name} (${keys.join(', ')})`);
    }
  }
  // New fields are appended, so the order after the adds is the kept fields
  // in their current order, then the new ones; anything else needs a reorder.
  const order = desFields.map((f) => f.name as string);
  const after = [
    ...curFields.map((f) => f.name as string).filter((n) => desNames.has(n)),
    ...order.filter((n) => !curByName.has(n)),
  ];
  if (!same(after, order)) {
    step('~', `reorder fields (${order.join(', ')})`, false, {
      kind: 'reorderFields',
      collection: name,
      order,
    });
  }

  for (const { key, entries, noun, id, canon = (e: Obj) => e } of LISTS) {
    const raw = new Map(list(name, des[key], key).map((e) => [id(e), e]));
    const curList = new Map(list(name, cur[key], key).map((e) => [id(e), e]));
    const op = (kind: 'putEntry' | 'removeEntry', entry: Obj): ApplyOp | undefined =>
      entries && { kind, collection: name, list: entries, entry };
    for (const [k, e] of curList) {
      if (!raw.has(k)) step('-', `remove ${noun} ${k}`, false, op('removeEntry', e));
    }
    for (const [k, e] of raw) {
      const old = curList.get(k);
      if (!old) step('+', `add ${noun} ${k}`, false, op('putEntry', e));
      else if (!same(canon(old), canon(e)))
        step('~', `alter ${noun} ${k}`, false, op('putEntry', e));
    }
  }
}

/** `"<resource> <action>"` → `[resource, action]`, for every grant of a role. */
function grants(role: Obj | undefined): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const p of (role?.permissions as Obj[] | undefined) ?? []) {
    for (const a of (p.actions as unknown[] | undefined) ?? []) {
      if (isDefaultGrant(String(role?.name), String(p.resource), String(a))) continue;
      out.set(`${p.resource} ${a}`, [String(p.resource), String(a)]);
    }
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
      const unsupported = Object.keys(d).some(
        (k) => k !== '$schema' && !CREATE_KEYS.includes(k) && !LISTS.some((l) => l.key === k),
      );
      const definition = Object.fromEntries(
        CREATE_KEYS.filter((k) => k in d).map((k) => [k, d[k]]),
      );
      steps.push({
        change: '+',
        target: name,
        action: `create collection (${n} fields)`,
        ...(unsupported ? {} : { op: { kind: 'createCollection', definition } }),
      });
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
    if (!c) {
      const description = typeof d.description === 'string' ? d.description : undefined;
      steps.push({
        change: '+',
        target,
        action: 'create role',
        op: { kind: 'createRole', name, description },
      });
    } else if (!same(c.description, d.description)) {
      steps.push({
        change: '~',
        target,
        action: `set description ${show(d.description)}`,
        op: {
          kind: 'setRole',
          name,
          description: typeof d.description === 'string' ? d.description : null,
        },
      });
    }
    const had = grants(c);
    const has = grants(d);
    for (const [g, [resource, action]] of [...had].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (has.has(g)) continue;
      steps.push({
        change: '-',
        target,
        action: `revoke ${g}`,
        op: { kind: 'revoke', role: name, resource, action },
      });
    }
    for (const [g, [resource, action]] of [...has].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (had.has(g)) continue;
      steps.push({
        change: '+',
        target,
        action: `grant ${g}`,
        op: { kind: 'grant', role: name, resource, action },
      });
    }
  }

  return steps;
}
