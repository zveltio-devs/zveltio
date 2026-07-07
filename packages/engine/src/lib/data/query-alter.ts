/**
 * Query-alter registry.
 *
 * Extensions register WHERE-clause builders against a table; the data layer
 * applies every registered alter (in registration order) before executing
 * SELECT queries on that table. Used for cross-cutting concerns that should
 * NOT be inlined in every route handler:
 *
 *   - Tenant isolation: scope rows to the requesting user's tenant.
 *   - Soft-delete filtering: hide rows with `deleted_at IS NOT NULL`.
 *   - GDPR / column-level redaction.
 *
 * Ownership model mirrors service-registry.ts: a scoped view tags each
 * registration with the owning extension, and `unregisterAll(extName)`
 * removes everything that extension contributed (called on unload /
 * hot-reload).
 *
 * Today's scope covers SELECT queries. Applying alters to UPDATE/DELETE is a
 * follow-up — those queries have a different shape in Kysely (no `selectFrom`
 * to chain `.where()` from) and need a dedicated wrapper.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export type QueryAlterFn<QB = any, U = any> = (qb: QB, user: U) => QB;

interface AlterEntry {
  owner: string;
  table: string;
  alter: QueryAlterFn;
}

/** Public interface handed to extensions via `ctx.queryAlter`. */
export interface QueryAlterScope {
  /**
   * Register an alter for a given table. The alter receives the live Kysely
   * query builder and the authenticated user. It must return a chained
   * builder (typically `qb.where(...)`).
   */
  register(def: { table: string; alter: QueryAlterFn }): void;
  /** List the alters this extension has registered. */
  list(): Array<{ table: string }>;
  /** Remove all alters this extension has registered. Idempotent. */
  unregisterAll(): void;
}

export class QueryAlterRegistryImpl {
  private entries: AlterEntry[] = [];

  /** Internal — register on behalf of an owning extension. */
  registerAs(owner: string, table: string, alter: QueryAlterFn): void {
    this.entries.push({ owner, table, alter });
  }

  /**
   * Apply every alter registered for `table` to `qb`, in registration order.
   * Returns the chained builder. If no alters are registered, returns `qb`
   * unchanged.
   */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  applyAll<QB = any, U = any>(qb: QB, table: string, user: U): QB {
    let result = qb;
    for (const e of this.entries) {
      if (e.table === table) {
        result = e.alter(result, user) as QB;
      }
    }
    return result;
  }

  /** Drop all alters owned by an extension. Called on unload. */
  unregisterAll(owner: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.owner !== owner);
    return before - this.entries.length;
  }

  /** Test helper — wipe everything. */
  clear(): void {
    this.entries = [];
  }

  /**
   * Number of alters registered. With no args: total. With `table`: count for
   * that table.
   */
  count(table?: string): number {
    return table ? this.entries.filter((e) => e.table === table).length : this.entries.length;
  }

  /** List registered (table, owner) pairs. Useful for introspection. */
  list(): Array<{ owner: string; table: string }> {
    return this.entries.map((e) => ({ owner: e.owner, table: e.table }));
  }

  /** Scoped view passed to each extension as `ctx.queryAlter`. */
  scope(extName: string): QueryAlterScope {
    return {
      register: (def) => this.registerAs(extName, def.table, def.alter),
      list: () => this.entries.filter((e) => e.owner === extName).map((e) => ({ table: e.table })),
      unregisterAll: () => {
        this.unregisterAll(extName);
      },
    };
  }
}

export const queryAlterRegistry = new QueryAlterRegistryImpl();
