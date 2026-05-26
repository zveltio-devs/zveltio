/**
 * Parse a single SQL migration file into its UP and DOWN sections.
 *
 * The DOWN section starts at the first line matching `-- DOWN` (case
 * insensitive). Everything before that marker is UP; everything after the
 * marker line is DOWN. If the marker is absent, the whole file is UP.
 *
 * Mirror of `packages/engine/src/lib/extension-loader.ts:parseMigrationSql`
 * — kept in the SDK so validators and tooling can call it without depending
 * on engine internals.
 */
export interface ParsedMigration {
  up: string;
  down: string | null;
}

export function parseMigrationSql(raw: string): ParsedMigration {
  const downIdx = raw.search(/^--\s*DOWN\b/im);
  if (downIdx < 0) {
    return { up: raw.trim(), down: null };
  }
  const up = raw.slice(0, downIdx).trim();
  const downSection = raw.slice(downIdx);
  const firstNewline = downSection.indexOf('\n');
  const downBody = firstNewline >= 0 ? downSection.slice(firstNewline + 1).trim() : '';
  return { up, down: downBody.length > 0 ? downBody : null };
}
