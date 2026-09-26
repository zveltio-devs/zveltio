/**
 * The default tenant is not quota-limited, and migration 016 is what makes it so.
 *
 * 001 seeded the default tenant without limit columns, so it took the free-plan
 * column defaults, and middleware/tenant-quota.ts refused request 10,001 of every
 * day with 429 on every single-tenant install. The nightly soak showed 9,994
 * requests OK and then nothing but refusals.
 *
 * The quota is driven with the real row and a cache already holding 10,000 calls
 * for today, so the request under test is number 10,001.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { tenantQuota } from '../../middleware/tenant-quota.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER = '00000000-0000-0000-0000-0000000016a1';
const UNLIMITED = 2147483647;
const MIGRATION = new URL(
  '../../db/migrations/sql/016_default_tenant_unlimited.sql',
  import.meta.url,
);

/** Read per test, so the first case still says 429 rather than ENOENT when 016 is absent. */
async function run016(db: Database): Promise<void> {
  await sql.raw(parseMigrationFile(await Bun.file(MIGRATION).text()).up).execute(db);
}

type Limits = {
  max_api_calls_day: number;
  max_records: number;
  max_users: number;
  max_storage_gb: string;
};

async function limits(db: Database, id: string): Promise<Limits> {
  const r = await sql<Limits>`
    SELECT max_api_calls_day, max_records, max_users, max_storage_gb::text AS max_storage_gb
      FROM zv_tenants WHERE id = ${id}::uuid
  `.execute(db);
  return r.rows[0] as Limits;
}

/** A cache where today's counter already stands at `calls`; the limit is read from the row. */
function cacheAt(tenantId: string, calls: number): Redis {
  const today = new Date().toISOString().slice(0, 10);
  const store = new Map<string, string>([[`tq:${tenantId}:${today}`, String(calls)]]);
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
  } as unknown as Redis;
}

async function request10001(db: Database, tenantId: string): Promise<number> {
  _setCacheForTests(cacheAt(tenantId, 10_000));
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenant', { id: tenantId } as never);
    await next();
  });
  app.use('/api/*', tenantQuota(db));
  app.get('/api/x', (c) => c.text('ok'));
  return (await app.request('/api/x')).status;
}

d('the default tenant is not quota-limited', () => {
  let db: Database;
  let original: Limits;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    original = await limits(db, DEFAULT_TENANT_ID);
    await sql`
      INSERT INTO zv_tenants (id, slug, name, status)
      VALUES (${OTHER}::uuid, ${`quota-probe-${Date.now()}`}, 'Quota Probe', 'active')
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  });

  afterEach(() => _setCacheForTests(null));

  afterAll(async () => {
    await sql`
      UPDATE zv_tenants SET
        max_api_calls_day = ${original.max_api_calls_day},
        max_records = ${original.max_records},
        max_users = ${original.max_users},
        max_storage_gb = ${original.max_storage_gb}::numeric
      WHERE id = ${DEFAULT_TENANT_ID}::uuid
    `
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db).catch(() => {});
  });

  it('a migrated install answers request 10,001 of the day', async () => {
    // Runs before anything below touches the row: this is the state the
    // migration chain itself leaves behind.
    expect(await request10001(db, DEFAULT_TENANT_ID)).toBe(200);
  });

  it('016 raises every limit still at its column default to the sentinel value', async () => {
    await sql`
      UPDATE zv_tenants SET max_api_calls_day = 10000, max_records = 10000,
                            max_users = 5, max_storage_gb = 1.0
       WHERE id = ${DEFAULT_TENANT_ID}::uuid
    `.execute(db);
    expect(await request10001(db, DEFAULT_TENANT_ID)).toBe(429);

    await run016(db);

    expect(await limits(db, DEFAULT_TENANT_ID)).toEqual({
      max_api_calls_day: UNLIMITED,
      max_records: UNLIMITED,
      max_users: UNLIMITED,
      max_storage_gb: '999999.00',
    });
    expect(await request10001(db, DEFAULT_TENANT_ID)).toBe(200);
  });

  it('keeps a limit an operator set on the default tenant', async () => {
    await sql`
      UPDATE zv_tenants SET max_api_calls_day = 50000, max_records = 10000,
                            max_users = 25, max_storage_gb = 1.0
       WHERE id = ${DEFAULT_TENANT_ID}::uuid
    `.execute(db);

    await run016(db);

    expect(await limits(db, DEFAULT_TENANT_ID)).toEqual({
      max_api_calls_day: 50000,
      max_records: UNLIMITED,
      max_users: 25,
      max_storage_gb: '999999.00',
    });
  });

  it('leaves every other tenant on its own limits', async () => {
    await run016(db);
    expect(await limits(db, OTHER)).toEqual({
      max_api_calls_day: 10000,
      max_records: 10000,
      max_users: 5,
      max_storage_gb: '1.00',
    });
    expect(await request10001(db, OTHER)).toBe(429);
  });
});
