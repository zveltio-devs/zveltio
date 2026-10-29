/**
 * Schema as code, step 1 (docs/engine/rfc-schema-as-code.md): the live schema
 * as files.
 *
 * `exportSchema` returns `{ path: content }` for `schema/`. The content is
 * deterministic: the same database gives the same bytes, so a pull with no
 * change produces no diff and a pull after a change shows exactly that change.
 * Studio's dev-mode writer (step 4) will reuse it.
 *
 * Out of the artifact (RFC §2): engine collections (`is_system`), the
 * collections an extension declared (`owner_extension`, ADR 0012),
 * BYOD tables (`is_managed = false`), rows, secrets, and tenant state — grants
 * scoped to one tenant and user→role assignments. Validation rules are the
 * instance's (a tenant's own rule, migration 092, is tenant state), and so are
 * `developer/validation`'s rule groups, which combine instance rules only.
 */

import { sql } from 'kysely';
import { columnsNotNull } from '../../db/dynamic.js';
import type { Database } from '../../db/index.js';
import {
  ENGINE_SEEDED_ROLES,
  isDefaultGrant,
  isDefaultGrantRole,
  loadWithheldCollections,
} from '../tenancy/index.js';
import { toIdArray } from '../validation-engine.js';
import { withoutAuthValue } from '../virtual-collection-adapter.js';

/**
 * 3: roles carry `revokedDefaults`; a format-2 file would plan every revoked
 * default back. (2: collection files carry `validationGroups`.)
 */
export const SCHEMA_FORMAT = 3;
const SCHEMA_URL = 'https://zveltio.com/schema/v1';

/** Keys written first, in this order; every other key is sorted. */
const LEADING_KEYS = ['$schema', 'name'];

/**
 * JSON with sorted keys (after `LEADING_KEYS`), 2-space indent and a trailing
 * newline. `null` and `undefined` mean "not set" and are dropped, so a new
 * optional property does not rewrite every file. Arrays keep their order: the
 * caller sorts them by their natural key.
 */
export function serialize(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== null && obj[k] !== undefined)
    .sort((a, b) => {
      const ia = LEADING_KEYS.indexOf(a);
      const ib = LEADING_KEYS.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return Object.fromEntries(keys.map((k) => [k, normalize(obj[k])]));
}

const byKey =
  <T>(...key: ((x: T) => string)[]) =>
  (a: T, b: T) => {
    for (const k of key) {
      const x = k(a);
      const y = k(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };

/**
 * A default grant (`isDefaultGrant`) is implied by the format like the engine
 * columns, so `permissions` never lists one. What the file does carry is the
 * defaults an operator revoked (`zv_default_grant_revocations`), as the role's
 * `revokedDefaults`: without them a revoke made on one instance was lost on the
 * way to the next, which kept the access the operator took away.
 */
export { ENGINE_SEEDED_ROLES, isDefaultGrant, isDefaultGrantRole };

/** role → resource → actions, as `roles.json` lists them. */
function byRole(rows: { role: string; resource: string; action: string }[]) {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const { role, resource, action } of rows) {
    const byResource = out.get(role) ?? new Map<string, Set<string>>();
    out.set(role, byResource);
    const actions = byResource.get(resource) ?? new Set<string>();
    byResource.set(resource, actions);
    actions.add(action);
  }
  return out;
}

const listed = (m: Map<string, Set<string>> | undefined) =>
  [...(m ?? new Map<string, Set<string>>()).entries()]
    .sort(byKey(([resource]) => resource))
    .map(([resource, actions]) => ({ resource, actions: [...actions].sort() }));

const sortedOrNull = (a: string[] | null | undefined) => (a?.length ? [...a].sort() : null);

/** Field flags whose `false` is the default, so it is not written. */
const FALSE_DEFAULT_FLAGS = ['required', 'unique', 'indexed', 'encrypted'];

export function exportField(f: Record<string, unknown>): Record<string, unknown> {
  const out = { ...f };
  for (const k of FALSE_DEFAULT_FLAGS) if (out[k] === false) delete out[k];
  return out;
}

/** A group member's key: its rule's `validation` key, the group giving the field. */
export const memberKey = (m: { rule?: unknown; config?: unknown }) =>
  `${m.rule} ${serialize(m.config ?? null).trim()}`;

interface RuleGroupRow {
  name: string;
  collection: string;
  field_name: string;
  description: string | null;
  logic: string;
  rule_ids: string[];
  is_active: boolean;
}

/**
 * `developer/validation`'s groups (instance-wide since migration 091), or none
 * when the extension, and so its table, is not installed.
 */
async function ruleGroups(db: Database): Promise<RuleGroupRow[]> {
  const present = await sql<{ ok: boolean }>`
    SELECT to_regclass('zvd_validation_rule_groups') IS NOT NULL AS ok`.execute(db);
  if (!present.rows[0]?.ok) return [];
  // rule_ids may arrive as the text form `{a,b}` (see toIdArray).
  const rows = await sql<Omit<RuleGroupRow, 'rule_ids'> & { rule_ids: unknown }>`
    SELECT name, collection, field_name, description, logic, rule_ids, is_active
      FROM zvd_validation_rule_groups`.execute(db);
  return rows.rows.map((r) => ({ ...r, rule_ids: toIdArray(r.rule_ids) }));
}

/**
 * `owner` exports one extension's collections instead of the instance's: an
 * extension's declared collections belong to its package (ADR 0012), so the
 * instance artifact leaves them out, and its plan is made against them alone.
 */
export async function exportSchema(
  db: Database,
  opts: { owner?: string } = {},
): Promise<Record<string, string>> {
  // `isDefaultGrant` below tells a default from a grant by it.
  await loadWithheldCollections(db);
  const [collections, relations, rowRules, columnPerms, validation, roles, grants, revoked] =
    await Promise.all([
      db
        .selectFrom('zvd_collections')
        .selectAll()
        .where('is_system', '=', false)
        .where('is_managed', '=', true)
        .where((eb) =>
          opts.owner === undefined
            ? eb('owner_extension', 'is', null)
            : eb('owner_extension', '=', opts.owner),
        )
        .orderBy('name')
        .execute(),
      db.selectFrom('zvd_relations').selectAll().execute(),
      // Not in the hand-written DbSchema, so read with its row type spelled out.
      sql<{
        collection: string;
        role: string;
        filter_field: string;
        filter_op: string;
        filter_value_source: string;
        is_enabled: boolean;
        description: string | null;
      }>`SELECT collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
           FROM zvd_rls_policies`
        .execute(db)
        .then((r) => r.rows),
      db.selectFrom('zvd_column_permissions').selectAll().execute(),
      // Instance rules only: a tenant's own rules (092) are tenant state.
      db.selectFrom('zv_validation_rules').selectAll().where('tenant_id', 'is', null).execute(),
      db.selectFrom('zv_roles').select(['name', 'description']).orderBy('name').execute(),
      // Global grants only: a rule scoped to one tenant id is tenant state.
      db
        .selectFrom('zvd_permissions')
        .select(['v0', 'v2', 'v3'])
        .where('ptype', '=', 'p')
        .where('v1', '=', '*')
        .execute(),
      db
        .selectFrom('zv_default_grant_revocations')
        .select(['role', 'resource', 'action'])
        .execute(),
    ]);
  const groups = await ruleGroups(db);
  // A member is named by its rule's key in the file, never by id. Only an
  // instance rule on the group's own field can be one (writeValidationRuleGroup);
  // any other id in rule_ids is one the evaluator ignores, so it is left out.
  const ruleById = new Map(validation.map((v) => [v.id, v]));

  const files: Record<string, string> = {
    'zveltio-schema.json': serialize({
      $schema: `${SCHEMA_URL}/zveltio-schema.json`,
      format: SCHEMA_FORMAT,
    }),
  };

  // A relation's key under a required field: the plan compares its column's
  // NOT NULL, not the field's word for it (alterField does the same).
  const fieldsOf = (c: { fields: unknown }) =>
    ((typeof c.fields === 'string' ? JSON.parse(c.fields) : c.fields) ?? []) as Record<
      string,
      unknown
    >[];
  const notNull = await columnsNotNull(
    db,
    collections.flatMap((c) =>
      fieldsOf(c)
        .filter((f) => f.required === true && (f.type === 'm2o' || f.type === 'reference'))
        .map((f) => `zvd_${c.name}.${f.name}`),
    ),
  );

  for (const row of collections) {
    // The ai_* columns are not in the hand-written DbSchema.
    const col = row as typeof row & {
      ai_search_enabled?: boolean;
      ai_search_field?: string | null;
      ai_embed_excluded_fields?: string[] | null;
    };
    const name = col.name;
    const fields = fieldsOf(col).map((f) =>
      notNull.get(`zvd_${name}.${f.name}`) === false ? { ...f, required: false } : f,
    );
    files[`collections/${name}.json`] = serialize({
      $schema: `${SCHEMA_URL}/collection.json`,
      name,
      displayName: col.display_name,
      singularName: col.singular_name,
      description: col.description,
      icon: col.icon,
      routeGroup: col.route_group,
      isPermissioned: col.is_permissioned,
      sort: col.sort,
      sourceType: col.source_type === 'table' ? null : col.source_type,
      // The upstream credential is a secret, out of the artifact like the rest.
      virtualConfig: withoutAuthValue(col.virtual_config),
      schemaLocked: col.schema_locked || null,
      aiSearchEnabled: col.ai_search_enabled || null,
      aiSearchField: col.ai_search_field,
      aiEmbedExcludedFields: sortedOrNull(col.ai_embed_excluded_fields),
      defaultGrants: col.default_grants ? null : false,
      // Declared order: it is the order Studio shows.
      fields: fields.map(exportField),
      relations: relations
        .filter((r) => r.source_collection === name)
        .map((r) => ({
          name: r.name,
          type: r.type,
          field: r.source_field,
          target: r.target_collection,
          targetField: r.target_field,
          onDelete: r.on_delete,
          onUpdate: r.on_update,
          metadata: r.metadata,
        }))
        .sort(byKey((r) => r.name)),
      rowRules: rowRules
        .filter((r) => r.collection === name)
        .map((r) => ({
          role: r.role,
          field: r.filter_field,
          op: r.filter_op,
          value: r.filter_value_source,
          enabled: r.is_enabled ? null : false,
          description: r.description,
        }))
        .sort(
          byKey(
            (r) => r.role,
            (r) => r.field,
            (r) => r.op,
            (r) => r.value,
          ),
        ),
      columnPermissions: columnPerms
        .filter((p) => p.collection_name === name)
        .map((p) => ({ role: p.role, column: p.column_name, read: p.can_read, write: p.can_write }))
        .sort(
          byKey(
            (p) => p.role,
            (p) => p.column,
          ),
        ),
      validation: validation
        .filter((v) => v.collection === name)
        .map((v) => ({
          field: v.field_name,
          rule: v.rule_type,
          config: v.rule_config,
          message: v.error_message,
          description: v.nl_description,
          active: v.is_active ? null : false,
        }))
        .sort(
          byKey(
            (v) => v.field,
            (v) => v.rule,
            (v) => JSON.stringify(normalize(v.config)),
          ),
        ),
      validationGroups: groups
        .filter((g) => g.collection === name)
        .map((g) => ({
          name: g.name,
          field: g.field_name,
          logic: g.logic,
          description: g.description,
          active: g.is_active ? null : false,
          rules: g.rule_ids
            .flatMap((id) => {
              const v = ruleById.get(id);
              return v?.field_name === g.field_name
                ? [{ rule: v.rule_type, config: v.rule_config }]
                : [];
            })
            .sort(byKey(memberKey)),
        }))
        .sort(byKey((g) => g.name)),
    });
  }

  const actionsOf = byRole(
    grants.flatMap((g) =>
      g.v0 && g.v2 && g.v3 && !isDefaultGrant(g.v0, g.v2, g.v3)
        ? [{ role: g.v0, resource: g.v2, action: g.v3 }]
        : [],
    ),
  );
  const revokedOf = byRole(revoked.filter((r) => isDefaultGrant(r.role, r.resource, r.action)));
  // A role with grants but no zv_roles row (a seeded built-in) is still listed.
  const roleNames = [
    ...new Set([...roles.map((r) => r.name), ...actionsOf.keys(), ...revokedOf.keys()]),
  ].sort();
  const description = new Map(roles.map((r) => [r.name, r.description]));
  files['roles.json'] = serialize({
    $schema: `${SCHEMA_URL}/roles.json`,
    roles: roleNames.map((name) => ({
      name,
      description: description.get(name),
      permissions: listed(actionsOf.get(name)),
      revokedDefaults: revokedOf.has(name) ? listed(revokedOf.get(name)) : null,
    })),
  });

  return files;
}
