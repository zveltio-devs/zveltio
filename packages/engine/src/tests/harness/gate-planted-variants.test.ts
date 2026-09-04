/**
 * The tenancy/SQL gates, against the SECOND shape of each violation.
 *
 * `audit-gates.ts` plants one violation per gate and proves the gate is not
 * decoration. That is a different question from the one here. A gate can catch
 * the shape somebody thought to plant and be blind to the shape the code is
 * actually written in — and on 2026-09-04, reviewing section E01 file by file,
 * six of them were:
 *
 *   check-migration-safety        discarded squawk's exit code, so a linter that
 *                                 never ran produced "✅ No upgrade hazards
 *                                 found" over a NOT NULL column with no default
 *   check-pooldb-txn-skip         read quoted paths out of the COMMENTS inside
 *                                 TXN_SKIP_PREFIXES, so a router documented as
 *                                 deliberately absent counted as present
 *   check-tenant-table-on-pool    matched one line at a time, so the formatter's
 *                                 own output — `poolDb` then `.selectFrom(…)` —
 *                                 was invisible
 *   check-duplicate-rules         knew `if (cond.op === 'eq')` and not
 *                                 `switch (cond.op) { case 'eq': }`
 *   check-rule-interpreters       accepted a COMMENT naming rule-operators.js as
 *                                 proof that a file goes through it
 *   check-sql-template-backticks  said "OK — no backticks" from a checkout with
 *                                 no sibling, having scanned half its corpus
 *
 * Each case below is the variant that used to pass, so the repair cannot be
 * undone quietly. They run against a fabricated repository root rather than this
 * one: every gate here takes its corpus from paths under a root it computes, so
 * a temp root is a faithful subject and nothing has to be planted in the tree.
 *
 * The one E01 repair with no case here is `check-insert-schema-match`, whose
 * change is to the report — it now names the sites it did NOT compare, instead
 * of counting them among the ones it did. Reproducing it needs a PostgreSQL and
 * a 22-second full install; the behaviour under test is a printed line, and a
 * test that expensive for a sentence is the wrong trade.
 */

import { describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SCRIPTS = join(REPO, 'scripts');

/**
 * A literal `$` + `{` for the one fixture that has to NAME the wrong form rather
 * than perform it. Written whole it trips `noTemplateCurlyInString`, and that
 * rule is right. Same answer `check-jsonb-binding.ts` reached for `INTERP_OPEN`.
 */
const INTERP_OPEN = `$${'{'}`;

/**
 * A temp root holding one gate and whatever corpus the case fabricates.
 *
 * Nested one level deeper than the temp directory — `<mkdtemp>/repo`, not
 * `<mkdtemp>` — so that `<root>/../zveltio-extensions` is PRIVATE to the case.
 * The flat shape put that path at `/tmp/zveltio-extensions`, which is shared:
 * the case below that fabricates a sibling created it for every other case in
 * the file, and the one asserting no sibling exists then failed depending on
 * execution order. Bun's file and test order is `readdir` order, so that is a
 * flake nobody would reproduce on demand.
 */
function fakeRoot(gate: string): string {
  const root = join(mkdtempSync(join(tmpdir(), 'e01-gate-')), 'repo');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(SCRIPTS, gate), join(root, 'scripts', gate));
  copyFileSync(
    join(SCRIPTS, 'lib', 'require-sibling.ts'),
    join(root, 'scripts', 'lib', 'require-sibling.ts'),
  );
  return root;
}

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
}

async function run(
  root: string,
  gate: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', join(root, 'scripts', gate), ...args], {
    // The gates resolve their corpus from `import.meta.dir/..`, but
    // check-pooldb-txn-skip reads two paths relative to the working directory.
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as never,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

// ─── check-migration-safety ──────────────────────────────────────────────────

describe('check-migration-safety refuses a verdict its linter never gave', () => {
  const GATE = 'check-migration-safety.ts';
  const HAZARD = 'ALTER TABLE zv_settings ADD COLUMN planted text NOT NULL;\n';

  /**
   * The gate with its linter swapped for a stub this case controls.
   *
   * A real spawn of a real process, so the exit code and both streams are the
   * genuine article — only the program on the other end is ours. Pinning the
   * substitution with an `expect` means a rename of the linter fails the test
   * rather than quietly turning it into a no-op.
   */
  async function rootWithLinter(stub: string): Promise<string> {
    const root = fakeRoot(GATE);
    write(root, 'linter.ts', stub);
    const text = await Bun.file(join(SCRIPTS, GATE)).text();
    expect(text).toContain("'squawk',");
    writeFileSync(
      join(root, 'scripts', GATE),
      text.replace(/'bun',\s*'x',\s*'squawk',/, `'bun', '${join(root, 'linter.ts')}',`),
    );
    return root;
  }

  it('fails when the linter exits non-zero having printed nothing', async () => {
    const root = await rootWithLinter('process.exit(1);\n');
    try {
      write(root, 'm.sql', HAZARD);
      const { code, out } = await run(root, GATE, [join(root, 'm.sql')]);
      expect(out).not.toContain('No upgrade hazards found');
      expect(out).toContain('did not run');
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the linter prints something that is not the JSON report', async () => {
    const root = await rootWithLinter(
      "console.log('thread panicked at src/main.rs');\nprocess.exit(101);\n",
    );
    try {
      write(root, 'm.sql', HAZARD);
      const { code, out } = await run(root, GATE, [join(root, 'm.sql')]);
      expect(out).toContain('not JSON');
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still passes when the linter runs and finds nothing', async () => {
    const root = await rootWithLinter("console.log('[]');\n");
    try {
      write(root, 'm.sql', 'CREATE TABLE IF NOT EXISTS zz (id uuid PRIMARY KEY);\n');
      const { code, out } = await run(root, GATE, [join(root, 'm.sql')]);
      expect(out).toContain('No upgrade hazards found');
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── check-pooldb-txn-skip ───────────────────────────────────────────────────

describe('check-pooldb-txn-skip does not read the array’s comments as entries', () => {
  const GATE = 'check-pooldb-txn-skip.ts';

  function root(listBody: string): string {
    const r = fakeRoot(GATE);
    write(
      r,
      'packages/engine/src/middleware/tenant.ts',
      `const TXN_SKIP_PREFIXES = [\n${listBody}\n];\nexport { TXN_SKIP_PREFIXES };\n`,
    );
    write(
      r,
      'packages/engine/src/routes/index.ts',
      "app.route('/api/planted', plantedRoutes(poolDb, auth));\n",
    );
    return r;
  }

  it('a path named only in a comment does not cover the router', async () => {
    const r = root("  // '/api/planted' is deliberately NOT here.\n  '/api/insights',");
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('/api/planted');
      expect(out).toContain('INSIDE the request transaction');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a real entry still covers it', async () => {
    const r = root("  '/api/planted',\n  '/api/insights',");
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('OK');
      expect(code).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-tenant-table-on-pool ──────────────────────────────────────────────

describe('check-tenant-table-on-pool sees a chain the formatter has wrapped', () => {
  const GATE = 'check-tenant-table-on-pool.ts';

  function root(routeBody: string): string {
    const r = fakeRoot(GATE);
    write(
      r,
      'packages/engine/src/db/schema.ts',
      'export interface ZvApiKeys {\n  id: string;\n  tenant_id: string;\n}\n' +
        'export interface ZvTenants {\n  id: string;\n}\n' +
        'export interface DbSchema {\n  zv_api_keys: ZvApiKeys;\n  zv_tenants: ZvTenants;\n}\n',
    );
    write(r, 'packages/engine/src/routes/probe.ts', routeBody);
    return r;
  }

  it('catches the multi-line chain', async () => {
    const r = root(
      "export const p = (poolDb: D) =>\n  poolDb\n    .selectFrom('zv_api_keys')\n    .execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('zv_api_keys');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('still catches the single-line form', async () => {
    const r = root("export const p = (poolDb: D) => poolDb.selectFrom('zv_api_keys').execute();\n");
    try {
      expect((await run(r, GATE)).code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('ignores a commented-out site, and says how many it actually saw', async () => {
    const r = root(
      "// poolDb.selectFrom('zv_api_keys')\nexport const p = (poolDb: D) => poolDb.selectFrom('zv_tenants').execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(code).toBe(0);
      // The reach, printed. A gate reporting OK over an empty match set is the
      // thing this number exists to make visible.
      expect(out).toContain('1 `poolDb.` query site(s)');
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-duplicate-rules ───────────────────────────────────────────────────

describe('check-duplicate-rules knows the switch form of a dispatch', () => {
  const GATE = 'check-duplicate-rules.ts';

  function root(body: string): string {
    const r = fakeRoot(GATE);
    write(r, 'packages/engine/src/lib/probe.ts', body);
    return r;
  }

  it('catches `switch (cond.op)`', async () => {
    const r = root(
      "export function p(cond: { op: string }) {\n  switch (cond.op) {\n    case 'eq':\n      return '=';\n    default:\n      return '?';\n  }\n}\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('rls-filter-loop');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('still catches the if-chain', async () => {
    const r = root("export const p = (cond: { op: string }) => (cond.op === 'eq' ? '=' : '?');\n");
    try {
      expect((await run(r, GATE)).code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('does not fire on a switch over something that is not an operator', async () => {
    const r = root(
      'export const p = (x: { kind: string }) => {\n  switch (x.kind) {\n    default:\n      return 1;\n  }\n};\n',
    );
    try {
      expect((await run(r, GATE)).code).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-rule-interpreters ─────────────────────────────────────────────────

describe('check-rule-interpreters wants an import, not a mention', () => {
  const GATE = 'check-rule-interpreters.ts';

  function root(body: string): string {
    const r = fakeRoot(GATE);
    write(
      r,
      'packages/engine/src/lib/tenancy/rule-operators.ts',
      'export const RULE_OPERATORS = {};\n',
    );
    write(r, 'packages/engine/src/lib/tenancy/probe.ts', body);
    write(
      r,
      'packages/engine/src/tests/harness/row-rules-four-interpreters.test.ts',
      '// applyRlsFilters buildRowRulePredicate matchesRlsFilters rlsJsonConditions\n',
    );
    write(
      r,
      'packages/engine/src/tests/unit/rule-operators-single-source.test.ts',
      '// RULE_OPERATORS\n',
    );
    return r;
  }

  it('a comment naming rule-operators.js is not going through it', async () => {
    const r = root(
      "export function p(op: string) {\n  // rule-operators.js is the source of truth; this renders it.\n  if (op === 'not_in') return 'NOT IN';\n  return '?';\n}\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('without going through');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a real import is', async () => {
    const r = root(
      "import { RULE_OPERATORS } from './rule-operators.js';\nexport function p(op: string) {\n  if (op === 'not_in') return RULE_OPERATORS;\n  return '?';\n}\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('OK');
      expect(code).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-jsonb-binding ─────────────────────────────────────────────────────

describe('check-jsonb-binding reads code, not prose', () => {
  const GATE = 'check-jsonb-binding.ts';

  /** A root with one jsonb column declared and one source file to judge. */
  function root(body: string): string {
    const r = fakeRoot(GATE);
    mkdirSync(join(r, 'quality-gates'), { recursive: true });
    writeFileSync(join(r, 'quality-gates', 'jsonb-binding.json'), JSON.stringify({ counts: {} }));
    write(
      r,
      'packages/engine/src/db/migrations/sql/001_initial.sql',
      'CREATE TABLE IF NOT EXISTS zv_flows (\n  id uuid PRIMARY KEY,\n  trigger_config jsonb\n);\n',
    );
    write(r, 'packages/engine/src/lib/probe.ts', body);
    // An explicit EXTENSIONS_DIR is the documented way to ask for a narrower
    // scan; without it the gate now refuses, which the last case here pins.
    return r;
  }

  const narrow = { EXTENSIONS_DIR: '/nonexistent-on-purpose' };

  it('catches JSON.stringify bound to a jsonb column', async () => {
    const r = root(
      "export const p = (db: any, v: unknown) =>\n  db.insertInto('zv_flows').values({ trigger_config: JSON.stringify(v) }).execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE, [], narrow);
      expect(out).toContain('zv_flows.trigger_config');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('catches it behind a ternary — the ordinary way to write a nullable column', async () => {
    const r = root(
      "export const p = (db: any, v: unknown) =>\n  db.insertInto('zv_flows').values({ trigger_config: v ? JSON.stringify(v) : null }).execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE, [], narrow);
      expect(out).toContain('zv_flows.trigger_config');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('does NOT fire on the wrong form shown inside a comment', async () => {
    // This repository documents the shape it refuses, in the header of the gate
    // that refuses it. A ratchet that counts prose fails on a clean tree.
    const r = root(
      "/**\n * Never write this:\n *   db.insertInto('zv_flows').values({ trigger_config: JSON.stringify(v) })\n */\n" +
        "export const p = (db: any) => db.insertInto('zv_flows').values({ id: '1' }).execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE, [], narrow);
      expect(out).toContain('OK');
      expect(code).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('does NOT fire on the correct ::text::jsonb binding written by hand', async () => {
    const fixture = `export const p = (db: any, v: unknown) =>\n  db.insertInto('zv_flows').values({ trigger_config: sql\`${INTERP_OPEN}JSON.stringify(v)}::text::jsonb\` }).execute();\n`;
    // The fixture is asserted before it is used, because this case passes on
    // exit 0 — and a fixture that had silently lost its interpolation would
    // also produce exit 0, for the opposite reason. A negative test whose
    // subject can go missing is a green light wired to nothing, which is the
    // thing this whole file is about. `INTERP_OPEN` is assembled rather than
    // written whole to satisfy `noTemplateCurlyInString`, so what it produces
    // is worth pinning rather than assuming.
    expect(fixture).toContain('JSON.stringify(v)');
    expect(fixture).toContain('::text::jsonb');
    const r = root(fixture);
    try {
      expect((await run(r, GATE, [], narrow)).code).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('refuses to report on an engine-only scan when the sibling is simply absent', async () => {
    // Without the sibling it used to print `OK — 0 site(s) across 29 table(s)`;
    // with one, 115. The corpus this gate exists for lives in the extensions.
    const r = root(
      "export const p = (db: any) => db.insertInto('zv_flows').values({ id: '1' }).execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('no sibling checkout');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── the `-- DOWN` half is rollback SQL, not schema ──────────────────────────

describe('the migration readers grade the half that runs', () => {
  it('check-tenant-boundary does not count RLS enabled only in a rollback', async () => {
    const GATE = 'check-tenant-boundary.ts';
    const r = fakeRoot(GATE);
    try {
      mkdirSync(join(r, 'quality-gates'), { recursive: true });
      writeFileSync(
        join(r, 'quality-gates', 'tenant-boundary.json'),
        JSON.stringify({ instance_level: {}, unpoliced: {} }),
      );
      write(
        r,
        'packages/engine/src/db/migrations/sql/001.sql',
        'CREATE TABLE IF NOT EXISTS zz_probe (\n  id uuid PRIMARY KEY,\n  tenant_id uuid NOT NULL\n);\n' +
          '\n-- DOWN\nALTER TABLE zz_probe ENABLE ROW LEVEL SECURITY;\nDROP TABLE zz_probe;\n',
      );
      // The sibling guard fires before anything else, so give it one.
      mkdirSync(join(r, '..', 'zveltio-extensions'), { recursive: true });
      const { code, out } = await run(r, GATE);
      expect(out).toContain('zz_probe');
      expect(out).toContain('no migration enables row level security');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-sql-template-backticks ────────────────────────────────────────────

describe('check-sql-template-backticks says when it did not scan the sibling', () => {
  const GATE = 'check-sql-template-backticks.ts';

  it('qualifies its OK when there is no sibling checkout', async () => {
    const r = fakeRoot(GATE);
    try {
      write(r, 'packages/engine/src/probe.ts', 'export const x = 1;\n');
      const { code, out } = await run(r, GATE);
      expect(code).toBe(0);
      expect(out).toContain('was not scanned');
      // The sentence that used to stand alone must no longer stand alone.
      expect(out).not.toMatch(/no backticks inside SQL template comments\.\s*$/);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('still catches a backtick inside an SQL comment', async () => {
    const r = fakeRoot(GATE);
    try {
      write(
        r,
        'packages/engine/src/probe.ts',
        'export const q = sql`\n  -- DML on all of `public` is what made this reachable\n  SELECT 1\n`;\n',
      );
      const { code, out } = await run(r, GATE);
      expect(out).toContain('FAIL');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
