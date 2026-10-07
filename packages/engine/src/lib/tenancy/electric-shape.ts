/**
 * The Electric shape one caller may sync: table, columns and WHERE, decided by
 * the engine from the same read gate `GET /api/data` uses.
 *
 * Electric connects to Postgres as a role that bypasses RLS (it has to: it reads
 * every published row to evaluate shapes), so none of the database policies —
 * tenant isolation, row rules, collection permissions — run on what it serves.
 * Everything the database would have enforced is therefore spelled out here, as
 * a WHERE Electric evaluates on the snapshot AND on every replicated change. A
 * rule this cannot express refuses the shape; it is never left out.
 *
 * FIFTH applier of the four row-rule operators (rls.ts lists the others). It
 * emits the same SQL spellings (`RULE_OPERATORS[op].sql`), with the values as
 * Electric positional params, which Electric types against the column as
 * Postgres types an untyped literal.
 */

import type { Database } from '../../db/index.js';
import type { FilterCondition } from '../../db/dynamic.js';
import { isGodUser } from './permissions.js';
import {
  isRuleOperator,
  keepsEveryPresent,
  keepsNothing,
  RULE_OPERATORS,
} from './rule-operators.js';
import { resolveTenantScope } from './tenant-scope.js';

/** Operational columns that are never user data (`shape.ts` strips them on REST). */
const INTERNAL_COLUMNS = new Set(['search_vector', 'search_text']);

/**
 * Electric refuses a request line over ~10 KB (414 measured at 37 KB on 1.8.1),
 * and each tenant id costs ~45 bytes as a param.
 * ponytail: a reach wider than this is refused; an `= ANY($1::uuid[])` param or
 * a subquery shape would lift it if consolidating parents ever need more.
 */
export const MAX_SHAPE_TENANTS = 100;

export interface ShapeInput {
  table: string;
  /** The table's physical columns. */
  columns: string[];
  /**
   * Fields REST never returns as stored, so never synced: encrypted ones
   * (ciphertext the client cannot decrypt) and types whose API output is
   * nothing (`password`: its argon2 hash).
   */
  withheld: Set<string>;
  /** The caller's `ReadScope` (lib/data/read-scope.ts), the parts a shape can carry. */
  scope: {
    rls: Array<{ field: string; condition: FilterCondition }>;
    readable(column: string): boolean;
    altersRestrict: boolean;
    entityChecks: boolean;
  };
  /** The tenants this request reads: `zveltio_visible_tenants()`, or every one for god. */
  tenants: string[] | 'all';
}

export type ShapeDefinition =
  | { ok: true; table: string; columns: string[]; where: string | null; params: string[] }
  | { ok: false; status: 409; code: string; detail: string };

/**
 * The tenants a request reads — what `withTenantIsolation` publishes for
 * `zveltio_visible_tenants()` to answer, resolved without opening a
 * transaction: a long-poll must not hold a pooled connection while it waits.
 * God's reach is every tenant (tenant-manager.ts); a user's is their resolved
 * reach; an API key, or a user with none, reads the request's tenant only.
 */
export async function shapeTenantReach(
  db: Database,
  userId: string | null,
  tenantId: string,
): Promise<string[] | 'all'> {
  if (!userId) return [tenantId];
  if (await isGodUser(userId).catch(() => false)) return 'all';
  const { visible } = await resolveTenantScope(db, userId, tenantId);
  // The predicate's own fallback: an unpublished or empty set is the current tenant.
  return visible?.length ? visible : [tenantId];
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

function refuse(code: string, detail: string): ShapeDefinition {
  return { ok: false, status: 409, code, detail };
}

export function buildShapeDefinition(input: ShapeInput): ShapeDefinition {
  const { scope, table } = input;
  const physical = new Set(input.columns);

  // Both are decided per row in engine code, which a replicated change never
  // reaches. Refused rather than served unfiltered.
  if (scope.altersRestrict) {
    return refuse(
      'electric.unfilterable',
      `An extension narrows what this caller reads from "${table}" with a query alter, ` +
        'which Electric cannot apply. Use provider: "crdt" for this collection.',
    );
  }
  if (scope.entityChecks) {
    return refuse(
      'electric.unfilterable',
      `An extension decides row access on "${table}" in code, which Electric cannot apply. ` +
        'Use provider: "crdt" for this collection.',
    );
  }

  const params: string[] = [];
  const param = (v: unknown) => {
    params.push(String(v));
    return `$${params.length}`;
  };
  const clauses: string[] = [];

  if (input.tenants !== 'all') {
    if (!physical.has('tenant_id')) {
      return refuse('electric.untenanted', `"${table}" has no tenant_id to filter on.`);
    }
    if (input.tenants.length > MAX_SHAPE_TENANTS) {
      return refuse(
        'electric.reach_too_wide',
        `This request reads ${input.tenants.length} tenants; an Electric shape holds at most ` +
          `${MAX_SHAPE_TENANTS}.`,
      );
    }
    // An empty reach reads nothing — the database's own answer for it.
    clauses.push(
      input.tenants.length === 0
        ? 'false'
        : `tenant_id IN (${input.tenants.map(param).join(', ')})`,
    );
  }

  for (const { field, condition } of scope.rls) {
    // A rule on a column the table lacks errors on REST; here it must not
    // become a shape Electric rejects later, or one that silently drops it.
    if (!physical.has(field) || !isRuleOperator(condition.op)) {
      return refuse(
        'electric.unfilterable',
        `A row rule on "${table}" (${field} ${condition.op}) cannot be applied by Electric.`,
      );
    }
    const col = ident(field);
    if (keepsNothing(condition.op, condition.value)) clauses.push('false');
    else if (keepsEveryPresent(condition.op, condition.value)) clauses.push(`${col} IS NOT NULL`);
    else {
      const op = RULE_OPERATORS[condition.op];
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      clauses.push(
        op.list
          ? `${col} ${op.sql} (${values.map(param).join(', ')})`
          : `${col} ${op.sql} ${param(condition.value)}`,
      );
    }
  }

  // Electric keys rows by the primary key and needs it in `columns`.
  if (!scope.readable('id')) {
    return refuse('electric.columns', `The caller may not read the primary key of "${table}".`);
  }
  const columns = input.columns.filter(
    (c) => scope.readable(c) && !INTERNAL_COLUMNS.has(c) && !input.withheld.has(c),
  );

  return {
    ok: true,
    table,
    columns,
    where: clauses.length ? clauses.map((w) => `(${w})`).join(' AND ') : null,
    params,
  };
}

/** The definition as Electric's query parameters. */
export function shapeSearchParams(def: Extract<ShapeDefinition, { ok: true }>): [string, string][] {
  const out: [string, string][] = [
    ['table', def.table],
    ['columns', def.columns.map(ident).join(',')],
  ];
  if (def.where) out.push(['where', def.where]);
  def.params.forEach((v, i) => out.push([`params[${i + 1}]`, v]));
  return out;
}
