/**
 * Schema as code, step 3a (docs/engine/rfc-schema-as-code.md §6): apply.
 *
 * `applySchema` makes the instance match the files, for the steps the plan
 * gives an `op`: creating collections, adding fields, collection settings,
 * creating roles and global grants. Anything else in the plan — a removal, an
 * alteration, a rule — refuses the whole apply before a single change, so a
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
  announceSchemaChange,
  type CollectionDefinition,
  CollectionSchema,
  DDLManager,
  FieldSchema,
  fieldTypeRegistry,
  runAddField,
  runCreateCollection,
  SYSTEM_COLUMNS,
} from '../data/index.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../tenancy/index.js';
import { exportSchema } from './export.js';
import { type ApplyOp, type PlanStep, planSchema, SchemaFileError } from './plan.js';

/** An op after `prepare`: its definition parsed into the shape the engine takes. */
type Prepared =
  | { kind: 'createCollection'; definition: CollectionDefinition }
  | { kind: 'addField'; collection: string; field: z.infer<typeof FieldSchema> }
  | Exclude<ApplyOp, { kind: 'createCollection' | 'addField' }>;

/** The plan has steps `apply` cannot run yet; nothing was changed. */
export class SchemaApplyRefused extends Error {
  constructor(public readonly steps: PlanStep[]) {
    super(
      `apply cannot run ${steps.length} step(s) yet, so it changed nothing: ` +
        steps.map((s) => `${s.change} ${s.target} ${s.action}`).join('; '),
    );
  }
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
    case 'setCollection':
      return op;
  }
}

async function run(db: Database, op: Prepared): Promise<void> {
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
    case 'grant':
      // Domain '*': roles.json holds global grants only (RFC §4.2).
      await (await getEnforcer()).addPolicy(op.role, '*', op.resource, op.action);
      return;
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
): Promise<PlanStep[]> {
  return withAdvisoryLock(db, 'zveltio:schema-apply', async () => {
    const steps = planSchema(await exportSchema(db), files);
    const refused = steps.filter((s) => !s.op);
    if (refused.length) throw new SchemaApplyRefused(refused);

    const ops: Prepared[] = [];
    for (const step of steps) ops.push(await prepare(db, step, step.op as ApplyOp));
    // Not one transaction: CREATE INDEX CONCURRENTLY refuses a transaction
    // block. A step that fails leaves the ones before it applied; the next
    // apply plans from what is there and carries on from that step.
    try {
      for (const op of ops) await run(db, op);
    } finally {
      if (ops.some((op) => op.kind === 'grant')) await invalidateAllPermissionCaches();
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
