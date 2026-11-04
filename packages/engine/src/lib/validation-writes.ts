/**
 * The writers of the instance's validation metadata: `zv_validation_rules` and
 * `zvd_validation_rule_groups`. Both bind every tenant's writes, so the request
 * roles only read them; these write as the engine, after their own check of the
 * caller. `/api/validation` and `ctx.internals` both come here.
 */
import { sql } from 'kysely';
import type { ValidationRuleGroupWrite, ValidationRuleWrite } from '@zveltio/sdk/extension';
import { getDb, type Database } from '../db/index.js';
import { sqlState } from '../db/bun-sql-quirks.js';
import { auditLog } from './audit.js';
import { toJsonb } from './jsonb.js';
import { asEngineRole } from './role-window.js';
import { withSavepoint } from './savepoint.js';
import { isTenantAdmin, requireInstanceAdmin } from './tenancy/index.js';
import { checkValidationExpression, invalidateRulesCache } from './validation-engine.js';

/** Who writes: the signed-in caller, the request's transaction and its tenant. */
export interface ValidationWriter {
  user: { id: string };
  trx: Database | undefined;
  tenantId: string | null;
}

/**
 * `Write a validation rule as `p`, the caller `/api/validation` or the `/ext/*`
 * gate admitted (`ctx.internals.writeValidationRule`). A tenant admin passed the
 * extension's old gate (`checkPermission(admin, '*')`) and stored rules that
 * refused every tenant's writes; the identity is the caller's, never an argument.
 *
 * An instance admin writes instance rules (`tenant_id` NULL), or with
 * `scope: 'tenant'` one for the request's tenant, and toggles or deletes any.
 * A tenant admin writes only rules of the request's tenant — the engine sets
 * `tenant_id` — and toggles or deletes only those: another tenant's rule or an
 * instance rule answers `null`, as one that does not exist.
 */
export async function writeValidationRule(
  p: ValidationWriter,
  write: ValidationRuleWrite,
): Promise<Record<string, unknown> | null> {
  const instance = await requireInstanceAdmin(p.user.id);
  // The tenant is the request's, never an argument.
  const ownTenant = !instance && p.tenantId && (await isTenantAdmin(p.user.id)) ? p.tenantId : null;
  if (!instance && !ownTenant) {
    throw new Error(
      'Only an instance admin, or a tenant admin for ' +
        "their own tenant's rules, may write a validation rule.",
    );
  }
  let tenantId: string | null = null;
  if (write.op === 'create' && (ownTenant || write.scope === 'tenant')) {
    if (instance ? !p.tenantId : write.scope === 'instance') {
      throw new Error(
        instance
          ? "`scope: 'tenant'` needs a request with a tenant."
          : 'An instance rule binds every tenant, so only ' + 'an instance admin may write one.',
      );
    }
    tenantId = ownTenant ?? p.tenantId;
  }
  if (write.op === 'create' && EXPRESSION_RULE_TYPES.has(write.rule.rule_type)) {
    // The route checks too, but this is the boundary: a rule that
    // cannot compile is stored as one that refuses every write to its field.
    const cfg = write.rule.rule_config as { expression?: unknown } | null | undefined;
    const expression = String(cfg?.expression ?? '');
    const verdict =
      expression === ''
        ? { ok: false as const, reason: 'is missing' }
        : checkValidationExpression(expression, write.rule.rule_type);
    if (!verdict.ok) {
      throw new Error(`The \`${write.rule.rule_type}\` rule's expression ${verdict.reason}.`);
    }
  }
  const db = p.trx ?? getDb();
  const run = async (): Promise<Record<string, unknown> | undefined> => {
    if (write.op === 'create') {
      const r = write.rule;
      return db
        .insertInto('zv_validation_rules')
        .values({
          collection: r.collection,
          field_name: r.field_name,
          rule_type: r.rule_type,
          nl_description: r.nl_description ?? null,
          rule_config: toJsonb(r.rule_config ?? {}),
          error_message: r.error_message,
          is_active: true,
          tenant_id: tenantId,
          created_by: p.user.id,
        })
        .returningAll()
        .executeTakeFirst();
    }
    if (write.op === 'setActive') {
      let q = db
        .updateTable('zv_validation_rules')
        .set({ is_active: write.is_active, updated_at: new Date() })
        .where('id', '=', write.id);
      if (write.collection) q = q.where('collection', '=', write.collection);
      if (ownTenant) q = q.where('tenant_id', '=', ownTenant);
      return q.returningAll().executeTakeFirst();
    }
    let q = db.deleteFrom('zv_validation_rules').where('id', '=', write.id);
    if (write.collection) q = q.where('collection', '=', write.collection);
    if (ownTenant) q = q.where('tenant_id', '=', ownTenant);
    return q.returningAll().executeTakeFirst();
  };
  // A savepoint, so a refused row (bulk import goes on to the next) leaves the
  // request's transaction usable.
  const row = await asEngineRole(db, () =>
    withSavepoint(db, 'zv_validation_rule_write', run, (err) => {
      // Only a create meets 098's key: one instance rule per field, type and config.
      if (write.op === 'create' && sqlState(err) === '23505') {
        const r = write.rule;
        throw Object.assign(
          new Error(
            `${r.collection}.${r.field_name} already has an ` +
              `instance rule ${r.rule_type} with this config.`,
          ),
          { errno: '23505' },
        );
      }
      throw err;
    }),
  );
  if (row) {
    invalidateRulesCache(String(row.collection));
    // An instance rule binds every tenant, so its trail is not one tenant's.
    await auditLog(db, {
      type: VALIDATION_RULE_AUDIT[write.op],
      tenantId: (row.tenant_id as string | null) ?? null,
      userId: p.user.id,
      resourceId: String(row.id),
      resourceType: 'validation_rule',
      metadata:
        write.op === 'setActive'
          ? { collection: row.collection, is_active: write.is_active }
          : { collection: row.collection, field_name: row.field_name, rule_type: row.rule_type },
    });
  }
  return row ?? null;
}

/**
 * `ctx.internals.writeValidationRuleGroup`. A group turns a field's rules from
 * AND into OR, so it binds every tenant as the rules do (migration 091); the
 * extension wrote it through `ctx.db`, inside one tenant.
 */
export async function writeValidationRuleGroup(
  p: ValidationWriter,
  write: ValidationRuleGroupWrite,
): Promise<Record<string, unknown> | null> {
  if (!(await requireInstanceAdmin(p.user.id))) {
    throw new Error(
      'Rule groups apply to every tenant, so only an ' + 'instance admin may write one.',
    );
  }
  const db = p.trx ?? getDb();
  const run = async (): Promise<Record<string, unknown> | undefined> => {
    if (write.op === 'delete') {
      const r = await sql<Record<string, unknown>>`
        DELETE FROM zvd_validation_rule_groups WHERE id = ${write.id} RETURNING *`.execute(db);
      return r.rows[0];
    }
    const g = write.group;
    // Members are instance rules on the group's own field. The evaluator never
    // groups a tenant's rule (it only tightens), so a tenant rule id, or one
    // from another field, would be stored and silently do nothing.
    // FOR SHARE: a rule deleted or renamed between this check and the INSERT
    // would otherwise land as a dangling member.
    const ruleIds = [...new Set(g.rule_ids)];
    const members = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM zv_validation_rules
         WHERE id = ANY(${ruleIds}::uuid[]) AND tenant_id IS NULL
           AND collection = ${g.collection} AND field_name = ${g.field_name}
           FOR SHARE) m`.execute(db);
    if ((members.rows[0]?.n ?? 0) !== ruleIds.length) {
      throw new Error(
        'Every rule_ids entry must be an instance ' + "rule on the group's collection and field.",
      );
    }
    const r = await sql<Record<string, unknown>>`
      INSERT INTO zvd_validation_rule_groups
        (name, collection, field_name, description, logic, rule_ids, is_active, created_by)
      VALUES (${g.name}, ${g.collection}, ${g.field_name}, ${g.description ?? null},
              ${g.logic ?? 'AND'}, ${ruleIds}::uuid[], ${g.is_active ?? true}, ${p.user.id})
      RETURNING *`.execute(db);
    return r.rows[0];
  };
  // A duplicate name (23505) is the caller's to answer; the request goes on.
  const row = await asEngineRole(db, () =>
    withSavepoint(db, 'zv_validation_rule_group_write', run, (err) => {
      throw err;
    }),
  );
  if (row) {
    invalidateRulesCache(String(row.collection));
    await auditLog(db, {
      type:
        write.op === 'create' ? 'validation_rule_group.created' : 'validation_rule_group.deleted',
      tenantId: null,
      userId: p.user.id,
      resourceId: String(row.id),
      resourceType: 'validation_rule_group',
      metadata: { collection: row.collection, name: row.name, logic: row.logic },
    });
  }
  return row ?? null;
}

const EXPRESSION_RULE_TYPES = new Set(['custom', 'nlp', 'transition']);
const VALIDATION_RULE_AUDIT = {
  create: 'validation_rule.created',
  setActive: 'validation_rule.updated',
  delete: 'validation_rule.deleted',
} as const;
