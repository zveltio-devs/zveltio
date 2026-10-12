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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  for (const lib of ['require-sibling.ts', 'sql-drops.ts', 'strip-comments.ts']) {
    copyFileSync(join(SCRIPTS, 'lib', lib), join(root, 'scripts', 'lib', lib));
  }
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

  // The extensions repo runs this gate too. Its `001_initial.sql` files install
  // onto a populated instance, so the engine baseline's exemption is not theirs.
  it('lints an extension 001_initial.sql that carries the baseline marker', async () => {
    const finding = JSON.stringify([
      { file: 'x', line: 1, rule_name: 'adding-required-field', level: 'Error', message: 'm' },
    ]);
    const root = await rootWithLinter(`console.log(${JSON.stringify(finding)});\n`);
    try {
      write(root, 'crm/engine/migrations/001_initial.sql', `-- BASELINE SQUASH\n${HAZARD}`);
      const { code, out } = await run(root, GATE, ['crm/engine/migrations/001_initial.sql']);
      expect(out).not.toContain('baseline squash');
      expect(out).toContain('[adding-required-field]');
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Squawk's lock-timeout rule is off for every file because the runner sets
  // lock_timeout in its transaction — which a NO TRANSACTION file never gets.
  it('refuses a non-CONCURRENTLY statement in a NO TRANSACTION file', async () => {
    const root = await rootWithLinter("console.log('[]');\n");
    try {
      write(
        root,
        'm.sql',
        '-- NO TRANSACTION\nALTER TABLE zz ADD COLUMN IF NOT EXISTS c uuid;\n' +
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_c ON zz (c);\n',
      );
      const { code, out } = await run(root, GATE, [join(root, 'm.sql')]);
      expect(out).toContain('no-transaction-lock-timeout');
      expect(out).toContain('ALTER TABLE zz');
      expect(out).not.toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_c');
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads CONCURRENTLY, `;` and `--` inside strings and comments as what encloses them', async () => {
    const root = await rootWithLinter("console.log('[]');\n");
    try {
      write(
        root,
        'm.sql',
        '-- NO TRANSACTION\n/* build; then adopt */\n' +
          "CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_c ON zz (c) WHERE c <> '--'; ALTER TABLE zz DROP COLUMN x;\n" +
          "/* CONCURRENTLY */ ALTER TABLE zz ALTER COLUMN y SET DEFAULT 'CONCURRENTLY;';\n",
      );
      const { code, out } = await run(root, GATE, [join(root, 'm.sql')]);
      expect(out.match(/\[no-transaction-lock-timeout\]/g)?.length).toBe(2);
      expect(out).toContain('DROP COLUMN x');
      expect(out).toContain('SET DEFAULT');
      expect(code).toBe(1);
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

  // The gate parses with `typescript`, and refuses a tree where `registerCoreRoutes`
  // hands the pool to no router — so the fake repo gets both.
  const MOUNT =
    "import { mountedRoutes } from './mounted.js';\n" +
    'export function registerCoreRoutes(ctx: C) {\n  const { poolDb } = ctx;\n  mountedRoutes(poolDb);\n}\n';

  function root(routeBody: string, index = MOUNT): string {
    const r = fakeRoot(GATE);
    symlinkSync(join(REPO, 'node_modules'), join(r, 'node_modules'));
    write(r, 'packages/engine/src/routes/index.ts', index);
    write(
      r,
      'packages/engine/src/routes/mounted.ts',
      'export const mountedRoutes = (db: D) => db;\n',
    );
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

  it('sees past a regex literal holding an escaped slash on the same line', async () => {
    // `/\//g` used to read as `\` then a `//` comment, blanking the site after it.
    const r = root(
      "export const p = (poolDb: D, s: string) => s.replace(/\\//g, '_') && poolDb.selectFrom('zv_api_keys').execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('zv_api_keys');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('catches an aliased table', async () => {
    const r = root(
      "export const p = (poolDb: D) => poolDb.selectFrom('zv_api_keys as k').execute();\n",
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('zv_api_keys');
      expect(code).toBe(1);
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
      expect(out).toContain('1 query site(s) on it');
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  // A raw statement on the pool is as unbound as the chain; only the chain
  // was read (ledger E01-2026-10-11).
  for (const [shape, body] of [
    [
      'a raw sql template run on poolDb',
      `export const p = (poolDb: D, id: string) =>\n  sql<{ id: string }>\`\n    SELECT id FROM zv_api_keys k WHERE k.id = ${INTERP_OPEN}id}\n  \`.execute(poolDb);\n`,
    ],
    [
      'a raw sql template run on a pool transaction',
      `export const p = (poolDb: D) =>\n  poolDb.transaction().execute(async (trx) => {\n    await sql\`UPDATE zv_api_keys SET name = ${INTERP_OPEN}'x'}\`.execute(trx);\n  });\n`,
    ],
    [
      'a pool transaction with an isolation level set',
      "export const p = (poolDb: D) =>\n  poolDb\n    .transaction()\n    .setIsolationLevel('serializable')\n    .execute(async (trx) => trx.selectFrom('zv_api_keys').execute());\n",
    ],
    [
      'a schema-qualified table in a raw template',
      'export const p = (poolDb: D) => sql`SELECT id FROM public.zv_api_keys`.execute(poolDb);\n',
    ],
    [
      'the second table of a comma join',
      'export const p = (poolDb: D) => sql`SELECT k.id FROM zv_tenants t, zv_api_keys k`.execute(poolDb);\n',
    ],
    [
      // The callback's end was found by counting parentheses, strings included:
      // the `)` in ':)' closed it, and the site after it was never read.
      'a pool transaction whose callback has a parenthesis in a string',
      "export const p = (poolDb: D) =>\n  poolDb.transaction().execute(async (trx) => {\n    log(':)');\n    await trx.selectFrom('zv_api_keys').execute();\n  });\n",
    ],
  ]) {
    it(`catches ${shape}`, async () => {
      const r = root(body);
      try {
        const { code, out } = await run(r, GATE);
        expect(out).toContain('zv_api_keys');
        expect(code).toBe(1);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  }

  // `backupRoutes(poolDb)` is `function backupRoutes(db)` inside: the gate matched
  // the text `poolDb.` and never judged one of its sites (ledger E01).
  it('follows the pool into a router that names its parameter `db`', async () => {
    const r = root(
      "export function probeRoutes(db: D) {\n  return db.selectFrom('zv_api_keys').execute();\n}\n",
      "import { probeRoutes } from './probe.js';\n" +
        'export function registerCoreRoutes(ctx: C) {\n  const { db, poolDb } = ctx;\n' +
        '  probeRoutes(poolDb);\n}\n',
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('probe.ts:2  zv_api_keys');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('does not follow the request handle, nor a pool name an inner scope shadows', async () => {
    const r = root(
      "export function probeRoutes(db: D) {\n  const g = (db: D) => db.selectFrom('zv_api_keys');\n" +
        "  return [g, db.selectFrom('zv_tenants')];\n}\n" +
        "export const scopedRoutes = (db: D) => db.selectFrom('zv_api_keys');\n",
      "import { probeRoutes, scopedRoutes } from './probe.js';\n" +
        'export function registerCoreRoutes(ctx: C) {\n  const { db, poolDb } = ctx;\n' +
        '  probeRoutes(poolDb);\n  scopedRoutes(db);\n}\n',
    );
    try {
      expect((await run(r, GATE)).code).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('refuses to pass when no router receives the pool', async () => {
    const r = root(
      "export const p = (poolDb: D) => poolDb.selectFrom('zv_tenants').execute();\n",
      'export function registerCoreRoutes() {}\n',
    );
    try {
      const { code, out } = await run(r, GATE);
      expect(out).toContain('hands the pool to no router');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('does NOT fire on a raw template run on the request handle, or on a table with no tenant', async () => {
    const r = root(
      `export const p = (db: D, poolDb: D) => {\n  sql\`SELECT 1 FROM zv_api_keys\`.execute(db);\n  return sql\`SELECT ${INTERP_OPEN}sql\`1\`} FROM zv_tenants\`.execute(poolDb);\n};\n`,
    );
    try {
      expect((await run(r, GATE)).code).toBe(0);
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
    // ZVELTIO_ALLOW_MISSING_SIBLING=1 is the documented way to ask for a
    // narrower scan; without it the gate refuses, which the last cases pin.
    return r;
  }

  const narrow = { EXTENSIONS_ROOT: '/nonexistent-on-purpose', ZVELTIO_ALLOW_MISSING_SIBLING: '1' };

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

  // `.set(updates)` with the object built a key at a time: eleven live sites
  // (saved-queries PUT among them) sat under a gate that read only literals.
  for (const [shape, line] of [
    ['a property assignment', 'u.trigger_config = JSON.stringify(v);'],
    ['a quoted key', "u['trigger_config'] = JSON.stringify(v);"],
    ['a computed key naming the column', "u[k] = k === 'trigger_config' ? JSON.stringify(v) : v;"],
    ['Object.assign', 'Object.assign(u, { trigger_config: JSON.stringify(v) });'],
  ]) {
    it(`catches an update object passed by name, written through ${shape}`, async () => {
      const r = root(
        `export const p = (db: any, k: string, v: unknown) => {\n  const u: Record<string, unknown> = {};\n  ${line}\n  return db.updateTable('zv_flows').set(u).execute();\n};\n`,
      );
      try {
        const { code, out } = await run(r, GATE, [], narrow);
        expect(out).toContain('zv_flows.trigger_config');
        expect(code).toBe(1);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  }

  it('catches an object spread into the literal', async () => {
    const r = root(
      "export const p = (db: any, v: unknown) => {\n  const patch = { trigger_config: JSON.stringify(v) };\n  return db.updateTable('zv_flows').set({ ...patch, id: 'x' }).execute();\n};\n",
    );
    try {
      const { code, out } = await run(r, GATE, [], narrow);
      expect(out).toContain('zv_flows.trigger_config');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('does NOT charge a later statement with an object passed to an earlier one', async () => {
    const r = root(
      "export const p = async (db: any, v: unknown) => {\n  await db.insertInto('zv_flows').values({ id: 'x' }).execute();\n  const u: Record<string, unknown> = {};\n  u.trigger_config = JSON.stringify(v);\n  return db.updateTable('zv_other').set(u).execute();\n};\n",
    );
    try {
      expect((await run(r, GATE, [], narrow)).code).toBe(0);
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

  it('refuses an EXTENSIONS_ROOT that holds no extension', async () => {
    // An explicit sibling path skipped the sibling check, and pointed at an
    // empty directory the gate reported OK on the engine alone.
    const r = root(
      "export const p = (db: any) => db.insertInto('zv_flows').values({ id: '1' }).execute();\n",
    );
    const empty = join(r, 'empty-extensions');
    mkdirSync(empty);
    try {
      const { code, out } = await run(r, GATE, [], { EXTENSIONS_ROOT: empty });
      expect(out).toContain('holds no extension manifest');
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
      // The sibling guard fires before anything else, so give it one — and a
      // real one. `require-sibling.ts` was tightened on 2026-09-04 (E04) to
      // demand an extension manifest within two levels, because an EMPTY
      // directory passed `existsSync` and every gate behind the guard then
      // reported its confident OK over nothing. An empty `zveltio-extensions/`
      // here was enough before that change and is not now, which is the guard
      // working: this fixture has to look like the repository it stands in for.
      mkdirSync(join(r, '..', 'zveltio-extensions', 'probe-ext'), { recursive: true });
      writeFileSync(
        join(r, '..', 'zveltio-extensions', 'probe-ext', 'manifest.json'),
        JSON.stringify({ name: 'probe-ext' }),
      );
      const { code, out } = await run(r, GATE);
      expect(out).toContain('zz_probe');
      expect(out).toContain('no migration enables row level security');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('check-tenant-boundary forgets a table a later migration drops, not one it recreates', async () => {
    // It read CREATE TABLE and never DROP TABLE, so 018's `zv_tenant_usage` and
    // 001's `zv_ddl_jobs` kept demanding entries for tables no install has.
    const GATE = 'check-tenant-boundary.ts';
    const r = fakeRoot(GATE);
    try {
      mkdirSync(join(r, 'quality-gates'), { recursive: true });
      writeFileSync(
        join(r, 'quality-gates', 'tenant-boundary.json'),
        JSON.stringify({ instance_level: {}, unpoliced: {} }),
      );
      const table = (t: string) =>
        `CREATE TABLE ${t} (\n  id uuid,\n  tenant_id uuid NOT NULL\n);\n`;
      write(
        r,
        'packages/engine/src/db/migrations/sql/001.sql',
        table('zz_gone') + table('zz_back'),
      );
      write(
        r,
        'packages/engine/src/db/migrations/sql/002.sql',
        `DROP TABLE IF EXISTS zz_gone;\nDROP TABLE zz_back;\n${table('zz_back')}`,
      );
      mkdirSync(join(r, '..', 'zveltio-extensions', 'probe-ext'), { recursive: true });
      writeFileSync(
        join(r, '..', 'zveltio-extensions', 'probe-ext', 'manifest.json'),
        JSON.stringify({ name: 'probe-ext' }),
      );
      const { code, out } = await run(r, GATE);
      expect(out).not.toContain('zz_gone');
      expect(out).toContain('zz_back');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-sql-template-backticks ────────────────────────────────────────────

describe('check-sql-template-backticks requires the sibling it scans', () => {
  const GATE = 'check-sql-template-backticks.ts';
  const optOut = { ZVELTIO_ALLOW_MISSING_SIBLING: '1' };

  it('refuses when there is no sibling checkout', async () => {
    const r = fakeRoot(GATE);
    try {
      write(r, 'packages/engine/src/probe.ts', 'export const x = 1;\n');
      const { code, out } = await run(r, GATE);
      expect(out).toContain('no sibling checkout');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('refuses an empty sibling directory, which used to get the bare OK', async () => {
    const r = fakeRoot(GATE);
    const empty = join(r, 'empty-extensions');
    mkdirSync(empty);
    try {
      write(r, 'packages/engine/src/probe.ts', 'export const x = 1;\n');
      const { code, out } = await run(r, GATE, [], { EXTENSIONS_ROOT: empty });
      expect(out).toContain('holds no extension manifest');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('qualifies its OK when told to scan this repository alone', async () => {
    const r = fakeRoot(GATE);
    try {
      write(r, 'packages/engine/src/probe.ts', 'export const x = 1;\n');
      const { code, out } = await run(r, GATE, [], optOut);
      expect(code).toBe(0);
      expect(out).toContain('was not scanned');
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
      const { code, out } = await run(r, GATE, [], optOut);
      expect(out).toContain('backtick inside an SQL comment');
      expect(code).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── sibling-reading scripts that used to answer on an empty corpus ─────────

describe('the last sibling readers refuse an empty corpus', () => {
  for (const gate of [
    'check-extension-i18n-namespaces.ts',
    'check-embedded-deps-fresh.ts',
    'schema-drift-check.ts',
  ]) {
    it(`${gate} refuses an empty EXTENSIONS_ROOT`, async () => {
      const r = fakeRoot(gate);
      const empty = join(r, 'empty-extensions');
      mkdirSync(empty);
      // i18n-namespaces imports the SDK's shared key list at load time.
      const keys = 'packages/sdk/src/validate/shared-message-keys.ts';
      mkdirSync(join(r, keys, '..'), { recursive: true });
      copyFileSync(join(REPO, keys), join(r, keys));
      try {
        const { code, out } = await run(r, gate, [], { EXTENSIONS_ROOT: empty });
        expect(out).toContain('holds no extension manifest');
        expect(code).toBe(1);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  }

  it('schema-codegen refuses even with the opt-out, and writes nothing', async () => {
    const GATE = 'schema-codegen.ts';
    const r = fakeRoot(GATE);
    try {
      const { code, out } = await run(r, GATE, [], { ZVELTIO_ALLOW_MISSING_SIBLING: '1' });
      expect(out).toContain('no narrower mode');
      expect(code).toBe(1);
      expect(existsSync(join(r, 'packages/engine/src/db/schema.generated.ts'))).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ─── check-record-attached-reads ─────────────────────────────────────────────

describe('check-record-attached-reads sees every way a route names the table', () => {
  const GATE = 'check-record-attached-reads.ts';
  const MIGRATION =
    'CREATE TABLE IF NOT EXISTS zv_notes (\n  id UUID,\n  collection TEXT NOT NULL,\n  record_id TEXT NOT NULL\n);\n' +
    'CREATE TABLE IF NOT EXISTS zv_moves (\n  id UUID,\n  table_name TEXT NOT NULL,\n  record_id UUID NOT NULL\n);\n';
  const route = (handler: string) =>
    `import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/x', async (c) => {\n${handler}\n});\n`;

  async function verdict(handler: string): Promise<{ code: number; out: string }> {
    const r = fakeRoot(GATE);
    write(r, 'packages/engine/src/db/migrations/sql/001_x.sql', MIGRATION);
    write(r, 'packages/engine/src/routes/probe.ts', route(handler));
    try {
      return await run(r, GATE);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  }

  // Each of these passed the gate: it matched the builder call or the keyword
  // in front of the name, on the same line.
  for (const [name, handler] of [
    ['sql.table', "  return db.selectFrom(sql.table('zv_notes')).selectAll().execute();"],
    ['a const', "  const T = 'zv_notes';\n  return db.selectFrom(T).selectAll().execute();"],
    ['schema-qualified', '  return sql`SELECT * FROM public.zv_notes`.execute(db);'],
    ['FROM on the line before', '  return sql`SELECT *\n    FROM\n    zv_notes`.execute(db);'],
  ] as const) {
    it(`an ungated read through ${name} fails`, async () => {
      const { code, out } = await verdict(handler);
      expect(out).toContain('zv_notes');
      expect(code).toBe(1);
    });
  }

  it('a table keyed by table_name + record_id is record-attached', async () => {
    const { code, out } = await verdict('  return sql`SELECT * FROM zv_moves`.execute(db);');
    expect(out).toContain('zv_moves');
    expect(code).toBe(1);
  });

  it('a gated route passes, and the gate says what it guards', async () => {
    const { code, out } = await verdict(
      "  if (!(await recordReadable(db, db, 'c', 'r', u, 'session'))) return c.json({}, 404);\n" +
        '  return sql`SELECT * FROM zv_notes`.execute(db);',
    );
    expect(code).toBe(0);
    expect(out).toContain('2 record-attached table(s) (zv_moves, zv_notes)');
  });

  it('a mention in a comment is not a reference', async () => {
    expect((await verdict('  // reads zv_notes elsewhere\n  return c.json(1);')).code).toBe(0);
  });
});
