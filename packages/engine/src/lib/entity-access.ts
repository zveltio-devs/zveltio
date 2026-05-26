/**
 * Entity-access registry — per-record authorization callbacks.
 *
 * Casbin / role-based permissions answer "can role R do action A on resource
 * X?". They do not see the specific row. Extensions register callbacks here
 * to express rules that depend on the row itself:
 *
 *   - "User can view a payroll record only if it's their own."
 *   - "Manager can update an order only when its status is 'draft'."
 *   - "Document is private after working hours."
 *
 * Semantics:
 *   - First explicit `deny` wins. All registered checks must allow.
 *   - No checks for a table = allow (no extension cares about this table).
 *   - Checks are async; the data layer awaits them before returning the row
 *     or proceeding with the write.
 *
 * Scope mirrors service-registry / query-alter: scoped registrations are
 * tagged with the owning extension and cleaned up on unload.
 */

export type EntityOp = 'view' | 'update' | 'delete';
export type AccessDecision = 'allow' | 'deny';
export type EntityAccessCheck<R = any, U = any> = (
  record: R,
  user: U,
  op: EntityOp,
) => AccessDecision | Promise<AccessDecision>;

interface Entry {
  owner: string;
  table: string;
  check: EntityAccessCheck;
}

export interface EntityAccessScope {
  register(def: { table: string; check: EntityAccessCheck }): void;
  list(): Array<{ table: string }>;
  unregisterAll(): void;
}

export class EntityAccessRegistryImpl {
  private entries: Entry[] = [];

  registerAs(owner: string, table: string, check: EntityAccessCheck): void {
    this.entries.push({ owner, table, check });
  }

  /**
   * Resolve the access decision for one record. Runs every check registered
   * for the table in registration order; the first `deny` short-circuits.
   * Returns `allow` if no checks are registered or all return `allow`.
   */
  async checkAccess<R = any, U = any>(
    table: string,
    record: R,
    user: U,
    op: EntityOp,
  ): Promise<AccessDecision> {
    const checks = this.entries.filter((e) => e.table === table);
    if (checks.length === 0) return 'allow';
    for (const c of checks) {
      const decision = await c.check(record, user, op);
      if (decision === 'deny') return 'deny';
    }
    return 'allow';
  }

  /** Convenience for callers that only care about the boolean. */
  async isAllowed<R = any, U = any>(
    table: string,
    record: R,
    user: U,
    op: EntityOp,
  ): Promise<boolean> {
    return (await this.checkAccess(table, record, user, op)) === 'allow';
  }

  unregisterAll(owner: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.owner !== owner);
    return before - this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  count(table?: string): number {
    return table ? this.entries.filter((e) => e.table === table).length : this.entries.length;
  }

  list(): Array<{ owner: string; table: string }> {
    return this.entries.map((e) => ({ owner: e.owner, table: e.table }));
  }

  scope(extName: string): EntityAccessScope {
    return {
      register: (def) => this.registerAs(extName, def.table, def.check),
      list: () => this.entries.filter((e) => e.owner === extName).map((e) => ({ table: e.table })),
      unregisterAll: () => {
        this.unregisterAll(extName);
      },
    };
  }
}

export const entityAccessRegistry = new EntityAccessRegistryImpl();
