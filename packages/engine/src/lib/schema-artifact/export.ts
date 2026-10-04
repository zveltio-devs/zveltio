/**
 * Schema as code, step 1 (docs/engine/rfc-schema-as-code.md): the live schema
 * as files.
 *
 * `exportSchema` returns `{ path: content }` for `schema/`. The content is
 * deterministic: the same database gives the same bytes, so a pull with no
 * change produces no diff and a pull after a change shows exactly that change.
 * Studio's dev-mode writer (step 4) will reuse it.
 *
 * Out of the artifact (RFC §2): engine and extension collections (`is_system`),
 * BYOD tables (`is_managed = false`), rows, secrets, and tenant state — grants
 * scoped to one tenant and user→role assignments.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export const SCHEMA_FORMAT = 1;
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

const sortedOrNull = (a: string[] | null | undefined) => (a?.length ? [...a].sort() : null);

/** Field flags whose `false` is the default, so it is not written. */
const FALSE_DEFAULT_FLAGS = ['required', 'unique', 'indexed', 'encrypted'];

function exportField(f: Record<string, unknown>): Record<string, unknown> {
  const out = { ...f };
  for (const k of FALSE_DEFAULT_FLAGS) if (out[k] === false) delete out[k];
  return out;
}

export async function exportSchema(db: Database): Promise<Record<string, string>> {
  const [collections, relations, rowRules, columnPerms, validation, roles, grants] =
    await Promise.all([
      db
        .selectFrom('zvd_collections')
        .selectAll()
        .where('is_system', '=', false)
        .where('is_managed', '=', true)
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
      db.selectFrom('zv_validation_rules').selectAll().execute(),
      db.selectFrom('zv_roles').select(['name', 'description']).orderBy('name').execute(),
      // Global grants only: a rule scoped to one tenant id is tenant state.
      db
        .selectFrom('zvd_permissions')
        .select(['v0', 'v2', 'v3'])
        .where('ptype', '=', 'p')
        .where('v1', '=', '*')
        .execute(),
    ]);

  const files: Record<string, string> = {
    'zveltio-schema.json': serialize({
      $schema: `${SCHEMA_URL}/zveltio-schema.json`,
      format: SCHEMA_FORMAT,
    }),
  };

  for (const row of collections) {
    // The ai_* columns are not in the hand-written DbSchema.
    const col = row as typeof row & {
      ai_search_enabled?: boolean;
      ai_search_field?: string | null;
      ai_embed_excluded_fields?: string[] | null;
    };
    const name = col.name;
    const fields = (typeof col.fields === 'string' ? JSON.parse(col.fields) : col.fields) as
      | Record<string, unknown>[]
      | null;
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
      virtualConfig: col.virtual_config,
      schemaLocked: col.schema_locked || null,
      inheritDown: col.inherit_down || null,
      aiSearchEnabled: col.ai_search_enabled || null,
      aiSearchField: col.ai_search_field,
      aiEmbedExcludedFields: sortedOrNull(col.ai_embed_excluded_fields),
      // Declared order: it is the order Studio shows.
      fields: (fields ?? []).map(exportField),
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
    });
  }

  const actionsOf = new Map<string, Map<string, Set<string>>>();
  for (const g of grants) {
    if (!g.v0 || !g.v2 || !g.v3) continue;
    const byResource = actionsOf.get(g.v0) ?? new Map<string, Set<string>>();
    actionsOf.set(g.v0, byResource);
    const actions = byResource.get(g.v2) ?? new Set<string>();
    byResource.set(g.v2, actions);
    actions.add(g.v3);
  }
  // A role with grants but no zv_roles row (a seeded built-in) is still listed.
  const roleNames = [...new Set([...roles.map((r) => r.name), ...actionsOf.keys()])].sort();
  const description = new Map(roles.map((r) => [r.name, r.description]));
  files['roles.json'] = serialize({
    $schema: `${SCHEMA_URL}/roles.json`,
    roles: roleNames.map((name) => ({
      name,
      description: description.get(name),
      permissions: [...(actionsOf.get(name) ?? new Map()).entries()]
        .sort(byKey(([resource]) => resource))
        .map(([resource, actions]) => ({ resource, actions: [...actions].sort() })),
    })),
  });

  return files;
}
