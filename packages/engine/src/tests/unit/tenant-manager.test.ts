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

    const sqls = db.log.map((q) => q.sql);
    expect(sqls[0]).toContain('ADD COLUMN IF NOT EXISTS tenant_id');
    expect(sqls[1]).toContain('SET tenant_id');
    expect(sqls[2]).toContain('SET DEFAULT COALESCE');
    expect(sqls[3]).toContain('SET NOT NULL');
    expect(sqls[4]).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sqls[5]).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sqls[6]).toContain('FORCE ROW LEVEL SECURITY');
    expect(sqls[7]).toContain('DROP POLICY IF EXISTS tenant_isolation');
    expect(sqls[8]).toContain('CREATE POLICY tenant_isolation');
    expect(sqls[8]).toContain('WITH CHECK');
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
