/**
 * Tenant manager (lib/tenancy/tenant-manager.ts) — unit-tested over CannedDb.
 *
 * Covers tenant resolution (header/subdomain/env/default priority), the RLS
 * DDL appliers (statement sequence + safety guard), schema/environment
 * provisioning, and the boot reconciler's failure tolerance. Cache branches
 * (Valkey) are skipped by design: getCache() is null in the unit environment,
 * so every lookup takes the DB path.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  applyTenantRLS,
  DEFAULT_TENANT_ID,
  enableRLS,
  getDefaultTenant,
  getTenantById,
  getTenantBySlug,
  getTenantDb,
  getTenantEnvironments,
  getTenantSchemaName,
  getUserTenants,
  initTenantManager,
  invalidateTenantCache,
  provisionEnvironment,
  provisionTenantSchema,
  reconcileExtensionTenantRLS,
  reconcileTenantRLS,
  resolveEnvironment,
  resolveTenantFromRequest,
  setCurrentTenant,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const TENANT = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  plan: 'pro',
  status: 'active',
  max_records: 1000,
  max_storage_gb: 10,
  max_api_calls_day: 10000,
  max_users: 25,
  settings: {},
};

function setup(): CannedDb {
  const db = new CannedDb();
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

afterEach(() => {
  delete process.env.ZVELTIO_TENANT_ID;
  delete process.env.ZVELTIO_TENANT_NAME;
});

describe('pure helpers', () => {
  it('getTenantSchemaName sanitizes the slug', () => {
    expect(getTenantSchemaName('acme')).toBe('tenant_acme');
    expect(getTenantSchemaName('acme-corp')).toBe('tenant_acme_corp');
    // Pins current behavior: replace() runs BEFORE toLowerCase(), so uppercase
    // characters are replaced with '_' rather than lowercased. Real slugs are
    // already lowercase, so this only bites hand-crafted input.
    expect(getTenantSchemaName('Acme!')).toBe('tenant__cme_');
  });

  it('setCurrentTenant is a hard-deprecated throw', async () => {
    await expect(setCurrentTenant('x')).rejects.toThrow('deprecated');
  });

  it('getTenantDb returns what initTenantManager was given', () => {
    const db = setup();
    expect(getTenantDb()).toBe(asDb(db));
  });

  it('invalidateTenantCache is a no-op without a cache backend', async () => {
    await expect(invalidateTenantCache('acme', 'id-1', 'user-1')).resolves.toBeUndefined();
  });
});

describe('tenant lookups (DB path)', () => {
  it('getTenantBySlug returns only active tenants and null on miss', async () => {
    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = \$1 and "status" = \$2/, (q) =>
      q.parameters[0] === 'acme' ? [TENANT] : [],
    );

    expect(await getTenantBySlug('acme')).toEqual(TENANT);
    expect(await getTenantBySlug('ghost')).toBeNull();
    // the active filter is part of the query itself
    expect(db.executed(/"status" = \$2/)[0]!.parameters).toContain('active');
  });

  it('getTenantById returns the row or null', async () => {
    const db = setup();
    db.when(/select \* from "zv_tenants" where "id" = /, [TENANT]);
    expect(await getTenantById(TENANT.id)).toEqual(TENANT);

    const empty = setup();
    expect(await getTenantById('nope')).toBeNull();
    expect(empty.executed(/zv_tenants/)).toHaveLength(1);
  });

  it('getUserTenants joins memberships to active tenants with the role', async () => {
    const db = setup();
    db.when(/from "zv_tenant_users" as "tu" inner join "zv_tenants" as "t"/, [
      { ...TENANT, role: 'admin' },
    ]);
    const rows = await getUserTenants('user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('admin');
    const q = db.executed(/zv_tenant_users/)[0]!;
    expect(q.parameters).toContain('user-1');
    expect(q.parameters).toContain('active');
  });

  it('getDefaultTenant falls back to the in-memory sentinel when the row is missing', async () => {
    setup(); // no zv_tenants handler → select returns nothing
    const t = await getDefaultTenant();
    expect(t.id).toBe(DEFAULT_TENANT_ID);
    expect(t.slug).toBe('default');
    expect(t.status).toBe('active');
  });
});

describe('resolveTenantFromRequest priority chain', () => {
  it('header slug wins over everything', async () => {
    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = /, (q) =>
      q.parameters[0] === 'acme' ? [TENANT] : [],
    );
    const t = await resolveTenantFromRequest(
      new Headers({ 'x-tenant-slug': 'acme' }),
      'other.zveltio.com',
    );
    expect(t?.slug).toBe('acme');
  });

  it('resolves a known subdomain', async () => {
    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = /, (q) =>
      q.parameters[0] === 'acme' ? [TENANT] : [],
    );
    const t = await resolveTenantFromRequest(new Headers(), 'acme.zveltio.com');
    expect(t?.slug).toBe('acme');
  });

  it('unknown subdomain falls through to the default tenant, never null', async () => {
    setup();
    const t = await resolveTenantFromRequest(new Headers(), 'ghost.zveltio.com');
    expect(t?.id).toBe(DEFAULT_TENANT_ID);
  });

  it('www/api subdomains and short hostnames skip subdomain parsing', async () => {
    const db = setup();
    expect((await resolveTenantFromRequest(new Headers(), 'www.zveltio.com'))?.id).toBe(
      DEFAULT_TENANT_ID,
    );
    expect((await resolveTenantFromRequest(new Headers(), 'localhost'))?.id).toBe(
      DEFAULT_TENANT_ID,
    );
    // no slug lookup for www / localhost — only the default-tenant lookup ran
    for (const q of db.executed(/"slug" = \$1/)) {
      expect(q.parameters[0]).toBe('default');
    }
  });

  it('IPv4 and IPv6 hostnames never parse as subdomains (the 127.0.0.1 regression)', async () => {
    const db = setup();
    expect((await resolveTenantFromRequest(new Headers(), '127.0.0.1'))?.id).toBe(
      DEFAULT_TENANT_ID,
    );
    expect((await resolveTenantFromRequest(new Headers(), '[::1]'))?.id).toBe(DEFAULT_TENANT_ID);
    for (const q of db.executed(/"slug" = \$1/)) {
      expect(q.parameters[0]).toBe('default');
    }
  });

  it('ZVELTIO_TENANT_ID env var provides the legacy single-tenant identity', async () => {
    setup();
    process.env.ZVELTIO_TENANT_ID = 'legacy-tenant';
    process.env.ZVELTIO_TENANT_NAME = 'Legacy Corp';
    const t = await resolveTenantFromRequest(new Headers(), 'localhost');
    expect(t?.id).toBe('legacy-tenant');
    expect(t?.name).toBe('Legacy Corp');
  });
});

describe('applyTenantRLS', () => {
  it('refuses unsafe table names', async () => {
    const db = setup();
    await expect(applyTenantRLS(asDb(db), 'users; DROP TABLE x')).rejects.toThrow(
      'unsafe table name',
    );
    await expect(applyTenantRLS(asDb(db), 'zv_settings')).rejects.toThrow('unsafe table name');
    expect(db.log).toHaveLength(0);
  });

  it('emits the full idempotent DDL sequence for a collection table', async () => {
    const db = setup();
    await applyTenantRLS(asDb(db), 'zvd_contacts');

    // Asserted as an ordered subsequence rather than by absolute index: the
    // policy statement is now preceded by a catalogue lookup that decides which
    // overload of the visible-set function to name, and pinning positions makes
    // the test fail on any statement inserted anywhere, which says nothing
    // about whether the sequence is still correct.
    const sqls = db.log.map((q) => q.sql);
    const order = [
      'ADD COLUMN IF NOT EXISTS tenant_id',
      'SET tenant_id',
      'SET DEFAULT COALESCE',
      'SET NOT NULL',
      'CREATE INDEX IF NOT EXISTS',
      'ENABLE ROW LEVEL SECURITY',
      'FORCE ROW LEVEL SECURITY',
      'DROP POLICY IF EXISTS tenant_isolation',
      'CREATE POLICY tenant_isolation',
    ];
    let at = 0;
    for (const fragment of order) {
      const found = sqls.findIndex((q, i) => i >= at && q.includes(fragment));
      expect({ fragment, found: found >= 0 }).toEqual({ fragment, found: true });
      at = found + 1;
    }

    // Reading and writing are different predicates since the hierarchy work, and
    // the read half is shaped as `= ANY((SELECT set)::uuid[])`. The `(SELECT …)`
    // is not decoration: calling the function directly leaves the planner with
    // nothing to estimate, so it takes the index and then reads the whole table
    // — 406 ms against 143 ms on a 500 000-row scan. See
    // `005_rls_initplan_predicate.sql`. Both halves are asserted: a policy that
    // put the read predicate back into WITH CHECK would let a parent unit write
    // into a child's rows.
    const policy = sqls.find((q) => q.includes('CREATE POLICY tenant_isolation')) ?? '';
    expect(policy).toContain(
      'USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))',
    );
    expect(policy).toContain('WITH CHECK (zveltio_tenant_write_ok(tenant_id))');
  });
});

describe('reconcileTenantRLS', () => {
  it('returns 0 when zvd_collections does not exist yet', async () => {
    const db = setup();
    db.fail(/SELECT name FROM zvd_collections/i, new Error('relation does not exist'));
    expect(await reconcileTenantRLS(asDb(db))).toBe(0);
  });

  it('applies RLS to collection tables plus builtins, skipping missing tables', async () => {
    const db = setup();
    db.when(/SELECT name FROM zvd_collections/i, [{ name: 'contacts' }]);
    // to_regclass probe: contacts + builtins pages/views/zones — only contacts + pages exist
    db.when(/to_regclass/, (q) => [
      {
        exists: q.parameters[0] === 'public.zvd_contacts' || q.parameters[0] === 'public.zvd_pages',
      },
    ]);

    expect(await reconcileTenantRLS(asDb(db))).toBe(2);
    const policies = db.executed(/CREATE POLICY tenant_isolation/);
    expect(policies).toHaveLength(2);
  });

  it('one failing table does not abort the rest', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup();
      db.when(/SELECT name FROM zvd_collections/i, [{ name: 'broken' }, { name: 'ok' }]);
      db.when(/to_regclass/, [{ exists: true }]);
      db.fail(/"zvd_broken"/, new Error('permission denied'));

      expect(await reconcileTenantRLS(asDb(db))).toBe(4); // ok + pages/views/zones
      expect(warn.mock.calls.some((c) => String(c[0]).includes('zvd_broken'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('provisioning', () => {
  it('provisionTenantSchema creates the schema and the three system tables', async () => {
    const db = setup();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provisionTenantSchema('tenant_acme');
    } finally {
      log.mockRestore();
    }

    expect(db.executed(/CREATE SCHEMA IF NOT EXISTS "tenant_acme"/)).toHaveLength(1);
    for (const table of ['zvd_collections', 'zvd_relations', 'zvd_permissions']) {
      expect(
        db.executed(new RegExp(`CREATE TABLE IF NOT EXISTS "tenant_acme"\\.${table}`)),
      ).toHaveLength(1);
    }
  });

  it('provisionEnvironment provisions the env schema and registers it idempotently', async () => {
    const db = setup();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provisionEnvironment(TENANT.id, 'acme-corp', 'staging', 'Staging', false);
    } finally {
      log.mockRestore();
    }

    expect(db.executed(/CREATE SCHEMA IF NOT EXISTS "tenant_acme_corp_staging"/)).toHaveLength(1);
    const insert = db.executed(/insert into "zv_environments"/)[0]!;
    expect(insert.sql).toContain('on conflict');
    expect(insert.parameters).toContain('staging');
    expect(insert.parameters).toContain('tenant_acme_corp_staging');
    expect(insert.parameters).toContain('#d97706'); // staging color from the map
  });

  it('getTenantEnvironments lists production-first', async () => {
    const db = setup();
    db.when(/select \* from "zv_environments"/, [{ slug: 'prod' }, { slug: 'dev' }]);
    const envs = await getTenantEnvironments(TENANT.id);
    expect(envs).toHaveLength(2);
    expect(db.executed(/order by "is_production" desc/)).toHaveLength(1);
  });

  it('resolveEnvironment defaults to prod and honors x-environment', async () => {
    const db = setup();
    db.when(/select \* from "zv_environments"/, (q) =>
      q.parameters.includes('staging') ? [{ slug: 'staging' }] : [],
    );

    expect(await resolveEnvironment(TENANT as never, new Headers())).toBeNull();
    expect(db.executed(/zv_environments/)[0]!.parameters).toContain('prod');

    const env = await resolveEnvironment(
      TENANT as never,
      new Headers({ 'x-environment': 'staging' }),
    );
    expect(env?.slug).toBe('staging');
  });
});

describe('withTenantIsolation + enableRLS', () => {
  it('runs the callback inside a transaction with the tenant GUC set', async () => {
    const db = setup();
    let sawTrx = false;
    const result = await withTenantIsolation('tenant-9', async (trx) => {
      sawTrx = Boolean(trx);
      return 42;
    });
    expect(result).toBe(42);
    expect(sawTrx).toBe(true);
    const guc = db.executed(/set_config\('zveltio.current_tenant'/)[0]!;
    expect(guc.parameters).toContain('tenant-9');
  });

  it('enableRLS emits column/index/RLS/policy DDL and warns about NULL-tenant rows', async () => {
    const db = setup();
    db.when(/COUNT\(\*\)::int AS orphan_count/i, [{ orphan_count: 3 }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await enableRLS('zvd_orders');
      expect(db.executed(/ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES/)).toHaveLength(1);
      expect(db.executed(/FORCE ROW LEVEL SECURITY/)).toHaveLength(1);
      expect(db.executed(/CREATE POLICY tenant_isolation/)).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('3 row(s)'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('enableRLS stays silent when no orphan rows exist', async () => {
    const db = setup();
    db.when(/COUNT\(\*\)::int AS orphan_count/i, [{ orphan_count: 0 }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await enableRLS('zvd_orders');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('row(s)'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Extensions install their own tenant isolation, and every one of the 54 copies
 * of the template was fail-OPEN: with no tenant context the policy admitted
 * every row, where the engine's own tables admitted none. Since 31 of 53
 * extensions hold a bare `db` somewhere instead of `reqDb(c)`, that turned a
 * routine mistake into a cross-tenant read.
 *
 * The fix rewrites those policies at boot rather than patching 54 files —
 * tenant isolation becomes something the host guarantees, which also covers
 * extensions that are not in this repository. These cases pin what it touches
 * and, more importantly, what it refuses to touch.
 */
describe('reconcileExtensionTenantRLS', () => {
  const policies = () => [
    { tablename: 'zv_search_indexes', policyname: 'tenant_isolation_search' },
  ];

  it('returns 0 when pg_policies cannot be read', async () => {
    const db = setup();
    db.fail(/FROM pg_policies/i, new Error('permission denied'));
    expect(await reconcileExtensionTenantRLS(asDb(db))).toBe(0);
  });

  it('rewrites an extension policy onto the shared predicate', async () => {
    const db = setup();
    db.when(/FROM pg_policies/i, policies());
    db.when(/COUNT\(\*\)::int AS n/i, [{ n: 0 }]);

    expect(await reconcileExtensionTenantRLS(asDb(db))).toBe(1);
    const created = db.executed(/CREATE POLICY/i);
    expect(created).toHaveLength(1);
    expect(created[0]?.sql).toContain(
      'USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))',
    );
    expect(created[0]?.sql).toContain('WITH CHECK (zveltio_tenant_write_ok(tenant_id))');
    // Both directions — a policy with USING but no WITH CHECK stops reads and
    // still allows a write into another tenant.
    expect(created[0]?.sql).toContain('WITH CHECK');
  });

  it('forces RLS, since the engine connects as the table owner', async () => {
    // ENABLE alone is advisory for the owner; without FORCE the whole policy
    // is decoration.
    const db = setup();
    db.when(/FROM pg_policies/i, policies());
    db.when(/COUNT\(\*\)::int AS n/i, [{ n: 0 }]);
    await reconcileExtensionTenantRLS(asDb(db));
    expect(db.executed(/FORCE ROW LEVEL SECURITY/i)).toHaveLength(1);
  });

  it('backfills rows with no tenant_id before switching the predicate', async () => {
    // The old policy showed a NULL tenant_id to everyone; the new one shows it
    // to nobody. Without the backfill the fix would read as data loss.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup();
      db.when(/FROM pg_policies/i, policies());
      db.when(/COUNT\(\*\)::int AS n/i, [{ n: 7 }]);

      await reconcileExtensionTenantRLS(asDb(db));
      const backfill = db.executed(/UPDATE .*SET tenant_id/i);
      expect(backfill).toHaveLength(1);
      expect(backfill[0]?.sql).toContain(DEFAULT_TENANT_ID);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('7 row(s)'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not touch a table that has no rows to backfill', async () => {
    const db = setup();
    db.when(/FROM pg_policies/i, policies());
    db.when(/COUNT\(\*\)::int AS n/i, [{ n: 0 }]);
    await reconcileExtensionTenantRLS(asDb(db));
    expect(db.executed(/UPDATE .*SET tenant_id/i)).toHaveLength(0);
  });

  it('sets the column default so reads and writes agree', async () => {
    // The read predicate falls back to the default tenant when there is no
    // GUC. If the column default did not, a contextless INSERT would write a
    // row the very next contextless SELECT could not see.
    const db = setup();
    db.when(/FROM pg_policies/i, policies());
    db.when(/COUNT\(\*\)::int AS n/i, [{ n: 0 }]);
    await reconcileExtensionTenantRLS(asDb(db));
    const def = db.executed(/ALTER COLUMN tenant_id SET DEFAULT/i);
    expect(def).toHaveLength(1);
    expect(def[0]?.sql).toContain(DEFAULT_TENANT_ID);
  });

  it('refuses a table or policy name that is not a plain identifier', async () => {
    // These names are read from pg_policies and interpolated into DDL.
    const db = setup();
    db.when(/FROM pg_policies/i, [
      { tablename: 'zv_ok"; DROP TABLE x; --', policyname: 'tenant_isolation_x' },
      { tablename: 'zv_ok', policyname: 'p"; DROP TABLE y; --' },
    ]);
    expect(await reconcileExtensionTenantRLS(asDb(db))).toBe(0);
    expect(db.executed(/DROP TABLE/i)).toHaveLength(0);
  });

  it('one failing table does not stop the others', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup();
      db.when(/FROM pg_policies/i, [
        { tablename: 'zv_broken', policyname: 'tenant_isolation_a' },
        { tablename: 'zv_fine', policyname: 'tenant_isolation_b' },
      ]);
      db.when(/COUNT\(\*\)::int AS n/i, [{ n: 0 }]);
      db.fail(/"zv_broken"/, new Error('permission denied'));

      expect(await reconcileExtensionTenantRLS(asDb(db))).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('zv_broken'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
