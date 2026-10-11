/**
 * Parse a single SQL migration file into its UP and DOWN sections.
 *
 * The DOWN section starts at the first line that is exactly `-- DOWN` (case
 * insensitive, surrounding spaces allowed). Everything before that marker is
 * UP; everything after the marker line is DOWN. If the marker is absent, the
 * whole file is UP.
 *
 * Mirror of `packages/engine/src/lib/extensions/extension-utils.ts:parseMigrationSql`
 * — kept in the SDK so validators and tooling can call it without depending
 * on engine internals. The two must agree on the marker: the engine was moved
 * to the anchored `\s*$` form and this copy kept `\b`, so a comment such as
 * `-- DOWN: manual rollback required` ended UP here and not there —
 * `withTestDb` applied half an extension's schema while the engine applied all
 * of it, and the validator saw a DOWN section the engine did not.
 */
export interface ParsedMigration {
  up: string;
  down: string | null;
}

export function parseMigrationSql(raw: string): ParsedMigration {
  const downIdx = raw.search(/^--\s*DOWN\s*$/im);
  if (downIdx < 0) {
    return { up: raw.trim(), down: null };
  }
  const up = raw.slice(0, downIdx).trim();
  const downSection = raw.slice(downIdx);
  const firstNewline = downSection.indexOf('\n');
  const downBody = firstNewline >= 0 ? downSection.slice(firstNewline + 1).trim() : '';
  return { up, down: downBody.length > 0 ? downBody : null };
}
