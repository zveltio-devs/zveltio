/**
 * The GA baseline builds what the beta chain builds, and the runner takes each
 * kind of database down the path the owner decision names.
 *
 * Two ways to reach the same schema, and both stay in use until the replaced
 * files are deleted: fresh installs take the baseline, existing ones took the
 * chain. Every migration added after the baseline runs on both, so this has to
 * keep holding — a squash on 2026-08-23 rewrote released files into 001 and
 * broke every existing database, which is what an unproved squash looks like.
 *
 * Equivalent means: identical `pg_dump --schema-only`, identical database-level
 * settings, identical seed rows (less the columns two builds of the chain do not
 * agree on — random ids, timestamps) and an identical ledger.
 *
 * Needs pg_dump matching the server (18); CI installs it. Unlike other harness
 * files this one fails rather than skips without it: a skipped equivalence check
 * reads exactly like a passing one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { join } from 'path';
import { _internalForTests, createDb } from '../../db/index.js';
import { parseBaseline, rollbackMigration, runPending } from '../../db/migrations/index.js';
import {
  createScratchDb,
  databaseSettings,
  dropScratchDb,
  migrate,
  normalizeDump,
  pgDump,
  readData,
  seeds,
  stableProjection,
  volatileColumns,
} from '../../../scripts/lib/baseline.js';
import { superuserTitle, superuserUrl } from '../../testing/app-harness.js';

// Creates scratch databases: a superuser's setup, not the engine's path.
const SERVER = process.env.TEST_DATABASE_URL ? await superuserUrl() : null;
const d = SERVER ? describe : describe.skip;

const BASELINE_FILE = '062_ga_baseline.sql';
const baselinePath = join(import.meta.dir, '../../db/migrations/baseline', BASELINE_FILE);

const names = {
  chain: `zveltio_bleq_${process.pid}_chain`,
  again: `zveltio_bleq_${process.pid}_again`,
  base: `zveltio_bleq_${process.pid}_base`,
};
const url: Record<keyof typeof names, string> = { chain: '', again: '', base: '' };

async function ledger(u: string): Promise<string[]> {
  const db = new SQL(u);
  try {
    const rows: Array<{ r: string }> = await db`
      SELECT concat_ws('|', version, name, filename, checksum, engine_version,
                       rolled_back_at IS NULL) AS r
        FROM zv_schema_versions
      UNION ALL SELECT 'm|' || name FROM zv_migrations ORDER BY 1`;
    return rows.map((x) => x.r);
  } finally {
    await db.close();
  }
}

d(superuserTitle('GA baseline', SERVER), () => {
  const server = SERVER as string;
  let freshApplied: string[] = [];
  let markApplied: string[] = [];
  let chainDumpBeforeMark = '';

  beforeAll(async () => {
    for (const k of Object.keys(names) as Array<keyof typeof names>) {
      url[k] = await createScratchDb(server, names[k]);
    }
    await migrate(url.chain, { ignoreBaseline: true });
    await migrate(url.again, { ignoreBaseline: true });
    freshApplied = await migrate(url.base);
    chainDumpBeforeMark = await pgDump(url.chain, ['--schema-only']);
    // The upgrade an existing install takes: the whole chain is applied.
    markApplied = await migrate(url.chain);
  }, 120_000);

  afterAll(async () => {
    for (const n of Object.values(names)) await dropScratchDb(server, n);
  });

  it('a fresh database runs the baseline and none of the files it replaces', () => {
    expect(freshApplied[0]).toBe(BASELINE_FILE);
    expect(freshApplied.filter((f) => f < BASELINE_FILE)).toEqual([]);
  });

  it('a fresh database the engine booted on first still takes the baseline', async () => {
    // Boot (`initDatabase`) creates an empty zv_migrations before migrating.
    const name = `zveltio_bleq_${process.pid}_boot`;
    const u = await createScratchDb(server, name);
    const db = createDb(u);
    try {
      await _internalForTests.ensureMigrationsTable(db);
      expect((await runPending(db))[0]).toBe(BASELINE_FILE);
    } finally {
      await db.destroy();
      await dropScratchDb(server, name);
    }
  }, 60_000);

  it('a database that ran the whole chain records the baseline without running it', async () => {
    expect(markApplied).toEqual([BASELINE_FILE]);
    expect(normalizeDump(await pgDump(url.chain, ['--schema-only']))).toBe(
      normalizeDump(chainDumpBeforeMark),
    );
  });

  it('both have the same pg_dump --schema-only', async () => {
    const chain = normalizeDump(await pgDump(url.chain, ['--schema-only']));
    expect(chain.length).toBeGreaterThan(10_000);
    expect(normalizeDump(await pgDump(url.base, ['--schema-only']))).toBe(chain);
  });

  it('neither has two indexes on the same key, a plain one beside a UNIQUE included (A09)', async () => {
    // The chain built four twice under two names, and the baseline copied them.
    for (const u of [url.chain, url.base]) {
      const db = new SQL(u);
      try {
        const rows: Array<{ same: string }> = await db`
          SELECT string_agg(x.indexrelid::regclass::text, ' = ' ORDER BY x.indexrelid::regclass::text) AS same
            FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
           WHERE i.relnamespace = 'public'::regnamespace
           GROUP BY x.indrelid, i.relam, x.indkey::text, x.indclass::text,
                    x.indcollation::text, x.indoption::text,
                    pg_get_expr(x.indexprs, x.indrelid), pg_get_expr(x.indpred, x.indrelid)
          HAVING count(*) > 1 ORDER BY 1`;
        expect(rows.map((r) => r.same)).toEqual([]);
      } finally {
        await db.close();
      }
    }
  });

  it('both have the same database-level settings', async () => {
    const chain = await databaseSettings(url.chain);
    expect(chain).toContain('zveltio.current_tenant=');
    expect(await databaseSettings(url.base)).toEqual(chain);
  });

  it('both have the same ledger', async () => {
    const chain = await ledger(url.chain);
    expect(chain.length).toBeGreaterThan(100);
    expect(await ledger(url.base)).toEqual(chain);
  });

  it('both seed the same rows', async () => {
    const versions = new Set(
      (await ledger(url.chain))
        .filter((r) => !r.startsWith('m|'))
        .map((r) => Number(r.split('|')[0])),
    );
    versions.delete(0); // 001's own row, which the baseline carries as a seed
    const chain = seeds(await readData(url.chain), versions);
    const volatile = volatileColumns(chain, seeds(await readData(url.again), versions));
    const base = seeds(await readData(url.base), versions);
    expect(base.map((t) => t.name)).toEqual(chain.map((t) => t.name));
    expect(chain.find((t) => t.name === 'zvd_permissions')?.rows.length).toBeGreaterThan(100);
    for (const t of chain) {
      const b = base.find((x) => x.name === t.name);
      expect(b && stableProjection(b, volatile)).toEqual(stableProjection(t, volatile));
    }
  });

  it('every REPLACES line names a shipped file by the checksum the runner records', async () => {
    const b = parseBaseline(await Bun.file(baselinePath).text());
    expect(b?.release).toMatch(/^v3\.0\.0-beta\.\d+$/);
    const recorded = (await ledger(url.chain))
      .filter((r) => !r.startsWith('m|'))
      .map((r) => r.split('|'))
      .map(([version, , filename, checksum]) => `${version} ${filename} ${checksum}`);
    const declared = (b?.replaces ?? []).map((r) => `${r.version} ${r.filename} ${r.checksum}`);
    expect(declared.length).toBeGreaterThan(50);
    for (const r of declared) expect(recorded).toContain(r);
  });

  it('rollback below the baseline is refused before any DOWN runs (A09)', async () => {
    const before = await pgDump(url.base, ['--schema-only']);
    const db = createDb(url.base);
    try {
      const res = await rollbackMigration(db, 0);
      expect(res.success).toBe(false);
      expect(res.error).toContain('cannot be rolled back');
      expect(res.error).toContain('not a supported operation');
    } finally {
      await db.destroy();
    }
    expect(normalizeDump(await pgDump(url.base, ['--schema-only']))).toBe(normalizeDump(before));
  });

  it('a database that stopped partway through the chain is refused, and nothing changes', async () => {
    // A real beta install stopped at 058: the later files' DOWNs run, as the
    // betas' own rollback would have. Not lower: 058's DOWN drops a cluster
    // role, which would reach every other database on this server.
    const db = createDb(url.again);
    try {
      expect(await rollbackMigration(db, 58, { ignoreBaseline: true })).toEqual({ success: true });
      const before = await ledger(url.again);
      await expect(runPending(db)).rejects.toThrow(/Upgrade to v3\.0\.0-beta\.\d+ first/);
      expect(await ledger(url.again)).toEqual(before);
    } finally {
      await db.destroy();
    }
  });
});
