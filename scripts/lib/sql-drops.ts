/**
 * The tables and columns a migration's UP half drops, for the gates that model
 * the schema from `CREATE TABLE` and `ADD COLUMN` alone.
 *
 * Those gates never read a DROP, so a dropped table stayed "created" forever:
 * migration 018 removed `zv_tenant_usage` and the tenant plan columns, and the
 * codegen, the drift check and the tenancy-boundary gate all went on describing
 * them. The extensions had already hit it unnoticed (`analytics/quality` 004).
 *
 * `sql` is the UP half with comments stripped. A drop followed, later in the
 * same text, by a CREATE of that table or an ADD of that column is a recreate,
 * and is not reported.
 */

// Postgres folds an unquoted name to lower case and keeps a quoted one as written.
const norm = (n: string) => {
  const last = n.split('.').pop()!;
  return last.startsWith('"') ? last.replace(/"/g, '') : last.toLowerCase();
};

export function droppedTables(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+?)(?:\s+CASCADE|\s+RESTRICT)?\s*;/gi,
  )) {
    for (const raw of m[1]!.split(',')) {
      // A name built at run time (`DROP TABLE %I` inside a DO block) names nothing here.
      if (!/^"?[\w.]+"?$/.test(raw.trim())) continue;
      const t = norm(raw.trim());
      const again = new RegExp(
        `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?"?${t}"?\\s*\\(`,
        'i',
      );
      if (!again.test(sql.slice(m.index! + m[0].length))) out.push(t);
    }
  }
  return out;
}

export function droppedColumns(sql: string): Array<[table: string, column: string]> {
  const out: Array<[string, string]> = [];
  const alter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(["\w.]+)\s+([^;]*);/gi;
  for (const m of sql.matchAll(alter)) {
    const t = norm(m[1]!);
    for (const d of m[2]!.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(["\w]+)/gi)) {
      const c = norm(d[1]!);
      const again = new RegExp(
        `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?"?${t}"?\\s[^;]*ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${c}"?\\s`,
        'i',
      );
      if (!again.test(sql.slice(m.index! + m[0].length))) out.push([t, c]);
    }
  }
  return out;
}
