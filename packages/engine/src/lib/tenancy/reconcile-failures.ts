/**
 * What the last boot reconcile of each database layer could not apply, by
 * table: the message. Each failure only warned, and a warning at boot is read by
 * nobody; `/health` reports these instead (`tenant_rls`, `db_rules`). A table
 * that failed keeps what it had — every layer replaces its objects in one
 * transaction — so this is visibility, not an open door. On an upgrade it is
 * the layer never having been applied at all, which is why it must be seen.
 *
 * `*` stands for the reconcile as a whole: its list of tables could not be read.
 */
export type ReconcileStep =
  | 'tenant_rls'
  | 'row_rules'
  | 'column_guards'
  | 'column_seals'
  // A schema-branch preview's copy of a table, re-mirrored from `public` on a
  // column rule, row rule or field change (`refreshBranchProtections`); keyed
  // `<schema>.<table>`.
  | 'branch_protections';

const byStep = new Map<ReconcileStep, Map<string, string>>();

/**
 * Record how applying `step` to `table` went: `err` records a failure and
 * returns its message, no `err` clears the table's last one. Written into the
 * step's current map, so a run that overlaps a newer one still reports.
 */
export function noteReconcile(step: ReconcileStep, table: string, err?: unknown): string {
  const failures = byStep.get(step) ?? new Map<string, string>();
  byStep.set(step, failures);
  if (err === undefined) {
    failures.delete(table);
    return '';
  }
  const message = err instanceof Error ? err.message : String(err);
  failures.set(table, message);
  return message;
}

/** Start `step`'s full reconcile: forget its last failures, return the recorder. */
export function startReconcile(step: ReconcileStep): (table: string, err: unknown) => string {
  byStep.set(step, new Map());
  return (table, err) => noteReconcile(step, table, err);
}

/** The last reconcile's failures of `steps`, for the health checks. */
export function reconcileFailures(
  ...steps: ReconcileStep[]
): Array<{ step: ReconcileStep; table: string; error: string }> {
  return steps.flatMap((step) =>
    [...(byStep.get(step) ?? [])].map(([table, error]) => ({ step, table, error })),
  );
}
