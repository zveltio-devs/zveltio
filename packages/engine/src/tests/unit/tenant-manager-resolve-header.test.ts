/**
 * resolveTenantFromRequest — explicit X-Tenant-Slug header path (tenant-manager.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  DEFAULT_TENANT_ID,
  initTenantManager,
  resolveTenantFromRequest,
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

afterEach(() => {
  delete process.env.ZVELTIO_TENANT_ID;
  delete process.env.ZVELTIO_TENANT_NAME;
});

describe('resolveTenantFromRequest — X-Tenant-Slug', () => {
  it('returns the tenant when the header slug matches an active row', async () => {
    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = /, (q) =>
      q.parameters[0] === 'acme' ? [TENANT] : [],
    );
    const t = await resolveTenantFromRequest(new Headers({ 'x-tenant-slug': 'acme' }), 'localhost');
    expect(t?.slug).toBe('acme');
  });

  it('returns null when the header slug is unknown (no default fallback)', async () => {
    setup();
    const t = await resolveTenantFromRequest(
      new Headers({ 'x-tenant-slug': 'missing-tenant' }),
      'localhost',
    );
    expect(t).toBeNull();
  });

  it('header slug takes priority over subdomain and default tenant', async () => {
    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = /, (q) =>
      q.parameters[0] === 'acme' ? [TENANT] : [],
    );
    const t = await resolveTenantFromRequest(
      new Headers({ 'x-tenant-slug': 'acme' }),
      'other.zveltio.com',
    );
    expect(t?.slug).toBe('acme');
    expect(t?.id).not.toBe(DEFAULT_TENANT_ID);
  });
});
