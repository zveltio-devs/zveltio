/**
 * Schema as code, step 3a (docs/engine/rfc-schema-as-code.md §6): apply.
 *
 * `applySchema` makes the instance match the files, for the steps the plan
 * gives an `op`: creating collections, adding fields, collection settings,
 * field order, row rules, column permissions, validation rules, roles and
 * global grants. Anything else in the plan — a drop, a field alteration, a
 * relation — refuses the whole apply before a single change, so a
 * half-applied file set is never the result of an unsupported step.
 *
 * Each op runs through the functions the collection and permission routes
 * use (`runCreateCollection`, `runAddField`, `updateCollectionMetadata`, the
 * Casbin enforcer), under one advisory lock so two applies cannot interleave.
 */

import type { z } from 'zod';
import type { Database } from '../../db/index.js';
import { withAdvisoryLock } from '../../db/advisory-lock.js';
import { auditLog } from '../audit.js';
import {
  alterField,
  announceSchemaChange,
  dropField,
  type CollectionDefinition,
  CollectionSchema,
  DDLManager,
  FieldSchema,
  fieldTypeRegistry,
  runAddField,
  runCreateCollection,
  schemaChangeRefusal,
  SYSTEM_COLUMNS,
} from '../data/index.js';
import { toJsonb } from '../jsonb.js';
import {
  createRlsPolicy,
  deleteColumnPermission,
  deleteRole,
  ENGINE_SEEDED_ROLES,
  deleteRlsPolicy,
  getEnforcer,
  invalidateAllPermissionCaches,
  putColumnPermission,
  reconcilePolicies,
  UnenforceableRuleError,
  updateRlsPolicy,
} from '../tenancy/index.js';
import { checkValidationExpression, invalidateRulesCache } from '../validation-engine.js';
import { exportSchema } from './export.js';
import { sql } from 'kysely';
import {
  type ApplyOp,
  type MigrationOp,
  type PlanStep,
  planSchema,
  SchemaFileError,
} from './plan.js';

/** An op after `prepare`: its definition parsed into the shape the engine takes. */
type Prepared =
  | { kind: 'createCollection'; definition: CollectionDefinition }
  | { kind: 'addField'; collection: string; field: z.infer<typeof FieldSchema> }
  | Exclude<ApplyOp, { kind: 'createCollection' | 'addField' }>;

/** The plan has steps `apply` cannot run yet; nothing was changed. */
export class SchemaApplyRefused extends Error {
  constructor(
    public readonly steps: PlanStep[],
    why = `apply cannot run ${steps.length} step(s) yet`,
  ) {
    super(
      `${why}, so it changed nothing: ` +
        steps.map((s) => `${s.change} ${s.target} ${s.action}`).join('; '),
    );
  }
}

/** Migration id → checksum, for every schema migration this instance ran. */
export async function appliedMigrations(db: Database): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; checksum: string }>`
    SELECT id, checksum FROM zv_schema_migrations`.execute(db);
  return new Map(rows.rows.map((r) => [r.id, r.checksum]));
}

const ROLE_NAME = /^[a-z][a-z0-9_-]*$/;

function checkFields(target: string, fields: { name: string; type: string }[]) {
  for (const f of fields) {
    if (SYSTEM_COLUMNS.has(f.name))
      throw new SchemaFileError(`${target}: "${f.name}" is a system column`);
    if (!fieldTypeRegistry.has(f.type)) {
      throw new SchemaFileError(`${target}: field ${f.name} has unknown type "${f.type}"`);
    }
  }
}

function parsed<T>(
  target: string,
  result:
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
): T {
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new SchemaFileError(`${target}: ${issue.path.join('.') || 'value'}: ${issue.message}`);
}

/** Validates one op before anything runs, and returns it in the shape the engine takes. */
async function prepare(db: Database, step: PlanStep, op: ApplyOp): Promise<Prepared> {
  const target = `${step.target} ${step.action}`;
  switch (op.kind) {
    case 'createCollection': {
      const definition = parsed(target, CollectionSchema.safeParse(op.definition));
      checkFields(target, definition.fields);
      // The export leaves engine, extension and BYOD collections out, so the
      // plan cannot tell a new name from one of those; the catalog can.
      const taken = await db
        .selectFrom('zvd_collections')
        .select('name')
        .where('name', '=', definition.name)
        .executeTakeFirst();
      if (taken || (await DDLManager.tableExists(db, definition.name))) {
        throw new SchemaFileError(
          `${target}: a collection or table named ${definition.name} exists outside the schema files`,
        );
      }
      return { ...op, definition };
    }
    case 'addField': {
      const field = parsed(target, FieldSchema.safeParse(op.field));
      checkFields(target, [field]);
      return { ...op, field };
    }
    case 'createRole':
      if (!ROLE_NAME.test(op.name)) {
        throw new SchemaFileError(`${target}: role name must be lowercase letters, digits, _ or -`);
      }
      return op;
    case 'grant':
      if (!ROLE_NAME.test(op.role) || !op.resource || !op.action) {
        throw new SchemaFileError(
          `${target}: a grant needs a valid role, a resource and an action`,
        );
      }
      return op;
    case 'setRole':
    case 'revoke':
    case 'setCollection':
    case 'reorderFields':
      return op;
    case 'putEntry':
    case 'removeEntry':
      checkEntry(target, op.list, op.entry);
      return op;
    case 'migration': {
      const c = op.change;
      if (c.op === 'changeFieldType' && !fieldTypeRegistry.has(c.to)) {
        throw new SchemaFileError(`${target}: unknown type "${c.to}"`);
      }
      if (c.op === 'renameField' && SYSTEM_COLUMNS.has(c.to)) {
        throw new SchemaFileError(`${target}: "${c.to}" is a system column`);
      }
      if (c.op === 'dropRole') {
        // A role the engine seeds holds every tenant's admins and members;
        // dropping it takes their access, and the next boot seeds it back.
        const custom =
          !ENGINE_SEEDED_ROLES.includes(c.role) &&
          (await db
            .selectFrom('zv_roles')
            .select('name')
            .where('name', '=', c.role)
            .executeTakeFirst());
        if (!custom) throw new SchemaFileError(`${target}: ${c.role} is not a custom role`);
      }
      if (c.op === 'dropCollection') {
        // The plan cannot see a collection the export leaves out, so it lets
        // the name through (a rerun finds it gone). The catalog can: an engine,
        // extension or BYOD collection is not the files' to drop, and a
        // schema-locked one is refused here as `DELETE /api/collections` does.
        const meta = await db
          .selectFrom('zvd_collections')
          .select('is_system')
          .where('name', '=', c.collection)
          .executeTakeFirst();
        const why = meta?.is_system
          ? `Collection '${c.collection}' is an engine or extension collection.`
          : await schemaChangeRefusal(db, c.collection, 'drop');
        if (why) throw new SchemaFileError(`${target}: ${why}`);
      }
      return op;
    }
  }
}

const fieldsOf = async (db: Database, collection: string) => {
  const col = await DDLManager.getCollection(db, collection);
  return (
    typeof col?.fields === 'string' ? JSON.parse(col.fields) : (col?.fields ?? [])
  ) as CollectionDefinition['fields'];
};

/**
 * Runs one migration op through the function its route uses. Each is a no-op
 * when its effect is already there, so an apply that failed part-way through
 * a migration can run it again from the top.
 */
async function migrate(db: Database, op: MigrationOp, userId: string | undefined) {
  if (op.op === 'dropRole') return deleteRole(db, op.role);
  if (op.op === 'dropCollection') {
    if (!(await DDLManager.getCollection(db, op.collection))) return;
    await DDLManager.dropCollection(db, op.collection);
    return announceSchemaChange(op.collection, 'drop');
  }
  const field = (await fieldsOf(db, op.collection)).find(
    (f) => f.name === (op.op === 'renameField' ? op.from : op.field),
  );
  if (!field) return;
  if (op.op === 'renameField') {
    await alterField(db, op.collection, op.from, { newName: op.to }, userId);
  } else if (op.op === 'changeFieldType') {
    if (field.type !== op.to)
      await alterField(db, op.collection, op.field, { newType: op.to }, userId);
  } else {
    await dropField(db, op.collection, op.field, userId);
  }
}

const str = (v: unknown) => typeof v === 'string' && v !== '';
const optional = (v: unknown, type: string) => v === undefined || v === null || typeof v === type;

/** The keys each list entry needs, as `exportSchema` writes them. */
function checkEntry(target: string, list: string, e: Record<string, unknown>) {
  const ok =
    list === 'rowRules'
      ? str(e.role) &&
        str(e.field) &&
        str(e.op) &&
        str(e.value) &&
        optional(e.enabled, 'boolean') &&
        optional(e.description, 'string')
      : list === 'columnPermissions'
        ? str(e.role) &&
          str(e.column) &&
          optional(e.read, 'boolean') &&
          optional(e.write, 'boolean')
        : str(e.field) &&
          str(e.rule) &&
          optional(e.message, 'string') &&
          optional(e.description, 'string') &&
          optional(e.active, 'boolean');
  if (!ok)
    throw new SchemaFileError(`${target}: entry is missing a key or has one of the wrong type`);
  if (list === 'validation' && e.rule === 'nlp') {
    // The same check the validation rules API runs before storing an expression.
    const verdict = checkValidationExpression(
      String((e.config as { expression?: unknown })?.expression ?? ''),
    );
    if (!verdict.ok) throw new SchemaFileError(`${target}: the expression ${verdict.reason}`);
  }
}

type Entry = Record<string, unknown>;

async function findRowRule(db: Database, collection: string, e: Entry) {
  const r = await sql<{ id: string }>`
    SELECT id FROM zvd_rls_policies
     WHERE collection = ${collection} AND role = ${e.role} AND filter_field = ${e.field}
       AND filter_op = ${e.op} AND filter_value_source = ${e.value}`.execute(db);
  return r.rows[0]?.id;
}

const findColumnPermission = (db: Database, collection: string, e: Entry) =>
  db
    .selectFrom('zvd_column_permissions')
    .select('id')
    .where('collection_name', '=', collection)
    .where('column_name', '=', String(e.column))
    .where('role', '=', String(e.role))
    .executeTakeFirst()
    .then((r) => r?.id);

const findValidation = (db: Database, collection: string, e: Entry) =>
  db
    .selectFrom('zv_validation_rules')
    .select('id')
    .where('collection', '=', collection)
    .where('field_name', '=', String(e.field))
    .where('rule_type', '=', String(e.rule))
    .where(sql<boolean>`COALESCE(rule_config, 'null'::jsonb) = ${toJsonb(e.config ?? null)}`)
    .executeTakeFirst()
    .then((r) => r?.id);

/** Adds an entry, or changes the one with its natural key (the plan's `id`). */
async function putEntry(db: Database, collection: string, list: string, e: Entry) {
  if (list === 'rowRules') {
    const id = await findRowRule(db, collection, e);
    const is_enabled = e.enabled !== false;
    // ponytail: updateRlsPolicy COALESCEs, so a description removed from the file stays; clear it in Studio.
    const description = (e.description as string | undefined) ?? undefined;
    if (id) await updateRlsPolicy(id, { is_enabled, description });
    else {
      await createRlsPolicy({
        collection,
        role: String(e.role),
        filter_field: String(e.field),
        filter_op: String(e.op),
        filter_value_source: String(e.value),
        is_enabled,
        description,
      });
    }
  } else if (list === 'columnPermissions') {
    await putColumnPermission(db, {
      collection_name: collection,
      column_name: String(e.column),
      role: String(e.role),
      can_read: e.read !== false,
      can_write: e.write !== false,
    });
  } else {
    const values = {
      error_message: (e.message as string | undefined) ?? null,
      nl_description: (e.description as string | undefined) ?? null,
      is_active: e.active !== false,
    };
    const id = await findValidation(db, collection, e);
    if (id) {
      await db
        .updateTable('zv_validation_rules')
        .set({ ...values, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
    } else {
      await db
        .insertInto('zv_validation_rules')
        .values({
          ...values,
          collection,
          field_name: String(e.field),
          rule_type: String(e.rule),
          rule_config: toJsonb(e.config ?? null),
        })
        .execute();
    }
    invalidateRulesCache(collection);
  }
}

async function removeEntry(db: Database, collection: string, list: string, e: Entry) {
  if (list === 'rowRules') {
    const id = await findRowRule(db, collection, e);
    if (id) await deleteRlsPolicy(id);
  } else if (list === 'columnPermissions') {
    const id = await findColumnPermission(db, collection, e);
    if (id) await deleteColumnPermission(db, id);
  } else {
    const id = await findValidation(db, collection, e);
    if (id) await db.deleteFrom('zv_validation_rules').where('id', '=', id).execute();
    invalidateRulesCache(collection);
  }
}

async function run(db: Database, op: Prepared, userId: string | undefined): Promise<void> {
  switch (op.kind) {
    case 'createCollection':
      return runCreateCollection(db, op.definition);
    case 'addField':
      return runAddField(db, op.collection, op.field);
    case 'setCollection':
      await DDLManager.updateCollectionMetadata(db, op.collection, { [op.key]: op.value });
      return announceSchemaChange(op.collection, 'alter');
    case 'createRole':
      await db
        .insertInto('zv_roles')
        .values({ name: op.name, description: op.description ?? null })
        .execute();
      return;
    case 'setRole':
      await db
        .updateTable('zv_roles')
        .set({ description: op.description })
        .where('name', '=', op.name)
        .execute();
      return;
    case 'grant':
      // Domain '*': roles.json holds global grants only (RFC §4.2).
      await (await getEnforcer()).addPolicy(op.role, '*', op.resource, op.action);
      return;
    case 'revoke':
      await (await getEnforcer()).removePolicy(op.role, '*', op.resource, op.action);
      return;
    case 'reorderFields': {
      const fields = await fieldsOf(db, op.collection);
      const at = (n: string) => {
        const i = op.order.indexOf(n);
        return i === -1 ? op.order.length : i;
      };
      await DDLManager.updateCollectionMetadata(db, op.collection, {
        fields: [...fields].sort((a, b) => at(a.name) - at(b.name)),
      });
      return announceSchemaChange(op.collection, 'alter');
    }
    case 'migration':
      try {
        await migrate(db, op.change, userId);
      } catch (err) {
        // The migrations before this one are recorded and stay applied.
        throw new SchemaFileError(`migration ${op.id}: ${(err as Error).message}`);
      }
      if (op.last) {
        await sql`INSERT INTO zv_schema_migrations (id, checksum, applied_by)
                  VALUES (${op.id}, ${op.checksum}, ${userId ?? null})
                  ON CONFLICT (id) DO NOTHING`.execute(db);
      }
      return;
    case 'putEntry':
      // A row rule is checked against the columns it names, which an earlier
      // step may have added, so only now; the steps before it stay applied.
      return putEntry(db, op.collection, op.list, op.entry).catch((err) => {
        if (err instanceof UnenforceableRuleError) {
          throw new SchemaFileError(`${op.collection} row rule: ${err.message}`);
        }
        throw err;
      });
    case 'removeEntry':
      return removeEntry(db, op.collection, op.list, op.entry);
  }
}

/**
 * Makes the instance match `files` and returns the steps it ran. Throws
 * `SchemaFileError` for a malformed or invalid file and `SchemaApplyRefused`
 * for a plan with a step it cannot run; in both cases nothing is changed.
 */
export async function applySchema(
  db: Database,
  files: Record<string, unknown>,
  userId: string | undefined,
  opts: { allowDestructive?: boolean } = {},
): Promise<PlanStep[]> {
  return withAdvisoryLock(db, 'zveltio:schema-apply', async () => {
    const steps = planSchema(await exportSchema(db), files, await appliedMigrations(db));
    const refused = steps.filter((s) => !s.op);
    if (refused.length) throw new SchemaApplyRefused(refused);
    // Every destructive step left has an op, so it comes from a migration
    // (RFC §6): a drop in the state diff alone has none and was refused above.
    const destructive = steps.filter((s) => s.destructive);
    if (destructive.length && !opts.allowDestructive) {
      throw new SchemaApplyRefused(destructive, 'destructive steps need --allow-destructive');
    }

    const ops: Prepared[] = [];
    for (const step of steps) ops.push(await prepare(db, step, step.op as ApplyOp));
    // Not one transaction: CREATE INDEX CONCURRENTLY refuses a transaction
    // block. A step that fails leaves the ones before it applied; the next
    // apply plans from what is there and carries on from that step.
    const policies = ops.some((op) => op.kind === 'grant' || op.kind === 'revoke');
    // The plan is read from the table, and casbin skips — without touching
    // the table — a revoke its model lacks or a grant it already holds. Bring
    // the model to the table first, as the orphan prune route does.
    if (policies) await reconcilePolicies();
    try {
      for (const op of ops) await run(db, op, userId);
    } finally {
      if (policies) await invalidateAllPermissionCaches();
    }
    if (steps.length) {
      await auditLog(db, {
        type: 'schema.applied',
        userId,
        resourceType: 'schema',
        metadata: { steps: steps.map((s) => `${s.change} ${s.target} ${s.action}`) },
      });
    }
    return steps;
  });
}
