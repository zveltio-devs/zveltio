/**
 * `scripts/lib/install-template.ts` builds "the database a real install
 * produces" for the installed-schema snapshot, `ext:seam` and the numeric gate.
 * It applied SQL migrations only, and ADR 0012 moves extension tables out of
 * SQL into declared collections: each port took its tables out of the template,
 * the snapshot was re-recorded without them, and the numeric gate's column
 * corpus shrank, all green. `zvd_invoices.amount_paid` was one of them.
 *
 * In a child process: the template applies collections through the engine's
 * own code, whose after-commit notices would otherwise reach this process's
 * harness engine (its enforcer, its tenant pool).
 */

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessAvailable } from '../../testing/app-harness.js';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SIBLING = join(REPO, '..', 'zveltio-extensions');
const d = harnessAvailable() && existsSync(SIBLING) ? describe : describe.skip;

d('install template', () => {
  it('holds every collection an extension declares', async () => {
    const lib = join(REPO, 'scripts', 'lib', 'install-template.ts');
    const db = `zveltio_tpl_test_${process.pid}`;
    const script = `
      import { SQL } from 'bun';
      const { ADMIN_URL, EXT_ROOT, buildInstallTemplate, dbUrl, extensionDirs } = await import(${JSON.stringify(lib)});
      const admin = new SQL(ADMIN_URL);
      try {
        const problems = await buildInstallTemplate(admin, ${JSON.stringify(db)});
        const declared = extensionDirs(EXT_ROOT).flatMap((dir) =>
          (JSON.parse(require('node:fs').readFileSync(dir + '/manifest.json', 'utf8')).collections ?? []).map((c) => 'zvd_' + c));
        const sql = new SQL(dbUrl(${JSON.stringify(db)}));
        const rows = await sql\`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'\`;
        await sql.end();
        const have = new Set(rows.map((r) => r.table_name));
        console.log(JSON.stringify({ problems, declared: declared.length, missing: declared.filter((t) => !have.has(t)) }));
      } finally {
        await admin.unsafe('DROP DATABASE IF EXISTS ${db}');
        await admin.end();
      }`;
    // A directory with no `.env`: Bun loads one from the working directory.
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, err).toBe(0);
    const { problems, declared, missing } = JSON.parse(out.trim().split('\n').at(-1) as string);
    expect(problems).toEqual([]);
    expect(missing).toEqual([]);
    // Not vacuous: the sibling declares collections (the wave ports more).
    expect(declared).toBeGreaterThan(0);
  }, 120_000);
});
