/**
 * buildRestrictedContext — reqDb tenantTrx + onHealthCheck (register.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import { clearExtensionHealthChecks, listHealthChecks } from '../../lib/health-registry.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function baseCtx(): ExtensionContext {
  return { db: new CannedDb().kysely } as unknown as ExtensionContext;
}

beforeEach(() => {
  clearExtensionHealthChecks('hc-ext');
});

afterEach(() => {
  clearExtensionHealthChecks('hc-ext');
});

describe('buildRestrictedContext — reqDb + health', () => {
  it('reqDb prefers tenantTrx from the Hono context over the pool fallback', async () => {
    const pool = new CannedDb();
    const tenant = new CannedDb();
    let poolHits = 0;
    let tenantHits = 0;
    pool.when(/from "zvd_items"/i, () => {
      poolHits++;
      return [];
    });
    tenant.when(/from "zvd_items"/i, () => {
      tenantHits++;
      return [];
    });
    const ctx = buildRestrictedContext(
      { db: pool.kysely } as unknown as ExtensionContext,
      'tenant-ext',
      new Hono(),
      new Set(['zvd_items']),
      false,
    );
    const honoCtx = {
      get: (key: string) => (key === 'tenantTrx' ? tenant.kysely : undefined),
    };
    await ctx
      .reqDb?.(honoCtx as never)
      ?.selectFrom('zvd_items' as never)
      .selectAll()
      .execute();
    expect(tenantHits).toBe(1);
    expect(poolHits).toBe(0);
  });

  it('onHealthCheck registers a namespaced probe', () => {
    const ctx = buildRestrictedContext(baseCtx(), 'hc-ext', new Hono(), new Set(), false);
    ctx.onHealthCheck?.('db', async () => ({ ok: true }), { critical: true });
    const names = listHealthChecks().map((c) => c.name);
    expect(names).toContain('ext:hc-ext:db');
  });
});
