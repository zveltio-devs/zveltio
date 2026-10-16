/**
 * Phase A coverage — health routes (routes/health.ts), mounted at /api/health.
 * Had no dedicated harness suite (58.8% incidental). `/` and `/ready` are
 * public; version/migrations/deep/update-check/:subsystem require a session.
 * All in-process + DB, no external service.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, reconcileSealedColumns } from '../../lib/data/index.js';
import { reconcileTenantRLS } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('health routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    ({ cookie: memberCookie } = await createMemberSession(app, db, { role: 'member' }));
  });

  it('GET /api/health is public and reports ok + demo_mode', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; demo_mode?: boolean };
    expect(body.status).toBe('ok');
    expect(typeof body.demo_mode).toBe('boolean');
  });

  it('GET /api/health/ready is public and returns a readiness verdict', async () => {
    const res = await app.request('/api/health/ready');
    // 200 ready or 503 not-ready are both valid, well-formed responses.
    expect([200, 503]).toContain(res.status);
  });

  it('GET /api/health/version → 401 anonymous, 200 with a session', async () => {
    const anon = await app.request('/api/health/version');
    expect(anon.status).toBe(401);
    const authed = await app.request('/api/health/version', { headers: { cookie } });
    expect(authed.status).toBe(200);
  });

  it('GET /api/health/migrations lists migration state (authed)', async () => {
    const res = await app.request('/api/health/migrations', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('GET /api/health/deep runs subsystem checks (authed)', async () => {
    const res = await app.request('/api/health/deep', { headers: { cookie } });
    // deep may report degraded subsystems (cache/S3 absent) but the endpoint
    // itself must respond cleanly, not 401/500.
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body).toBe('object');
  });

  it('GET /api/health/update-check responds (authed)', async () => {
    const res = await app.request('/api/health/update-check', { headers: { cookie } });
    // May reach out to the registry; any non-auth verdict is fine here.
    expect(res.status).not.toBe(401);
  });

  it('GET /api/health/:subsystem returns a single subsystem verdict (authed)', async () => {
    const res = await app.request('/api/health/database', { headers: { cookie } });
    expect([200, 404, 503]).toContain(res.status);
  });

  it('GET /api/health/sync is ok while no prepared transaction holds sync pull', async () => {
    const res = await app.request('/api/health/sync', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('GET /api/health/deep → 401 anonymous', async () => {
    const res = await app.request('/api/health/deep');
    expect(res.status).toBe(401);
  });

  it('GET /api/health/deep → 403 for an authenticated non-admin member', async () => {
    const res = await app.request('/api/health/deep', { headers: { cookie: memberCookie } });
    expect(res.status).toBe(403);
  });

  // /:subsystem is /deep's per-subsystem breakdown and must carry the same
  // instance-admin gate — otherwise a plain member gets the reconnaissance
  // /deep refuses them, one subsystem at a time (measured live: 403 from
  // /deep, 200 from /database, /storage, /extensions before this test).
  it('GET /api/health/:subsystem → 403 for an authenticated non-admin member', async () => {
    const res = await app.request('/api/health/database', { headers: { cookie: memberCookie } });
    expect(res.status).toBe(403);
  });

  it('GET /api/health/tenant_rls names the tables the boot reconcile could not isolate', async () => {
    // A reconcile failure used to be one console.warn at boot. Plant one: the
    // collection-permission function gone (a broken database), inside a
    // transaction that is always rolled back. A collection of its own, so
    // there is a table to fail on even on a fresh database.
    const name = `hrecon_${Date.now()}`;
    await DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'title', type: 'text' }],
    });
    try {
      await db
        .transaction()
        .execute(async (trx) => {
          await sql`ALTER FUNCTION zveltio_collection_allows(text, text) RENAME TO zveltio_collection_allows_gone`.execute(
            trx,
          );
          await reconcileTenantRLS(trx);
          throw new Error('rollback');
        })
        .catch((err: Error) => {
          if (err.message !== 'rollback') throw err;
        });

      const bad = await app.request('/api/health/tenant_rls', { headers: { cookie } });
      const badBody = (await bad.json()) as { ok: boolean; detail?: { failed: unknown[] } };
      expect(badBody.ok).toBe(false);
      expect(badBody.detail?.failed.length).toBeGreaterThan(0);

      // A clean reconcile clears it.
      await reconcileTenantRLS(db);
      const res = await app.request('/api/health/tenant_rls', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    } finally {
      await DDLManager.dropCollection(db, name, { force: true }).catch(() => {});
    }
  }, 120_000);

  it('GET /api/health/tenant_rls reports a boot reconcile that could not list the tables', async () => {
    // An unreadable zvd_collections (a lock timeout behind another replica's
    // migration) skipped the whole reconcile and the narrow-role revoke, and
    // /health stayed green. Planted as before, in a transaction rolled back.
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`ALTER TABLE zvd_collections RENAME TO zvd_collections_gone`.execute(trx);
        await reconcileTenantRLS(trx);
        throw new Error('rollback');
      })
      .catch((err: Error) => {
        if (err.message !== 'rollback') throw err;
      });
    try {
      const bad = await app.request('/api/health/tenant_rls', { headers: { cookie } });
      const badBody = (await bad.json()) as { ok: boolean; detail?: { failed: unknown[] } };
      expect(badBody).toMatchObject({ ok: false, detail: { failed: [{ table: '*' }] } });
    } finally {
      await reconcileTenantRLS(db);
    }
  }, 120_000);

  it('GET /api/health/db_rules names the tables the boot could not seal or mask', async () => {
    // Same shape as tenant_rls: the seal/mask function gone, in a transaction
    // that is always rolled back. Before, only a console.warn said so.
    const name = `hseal_${Date.now()}`;
    await DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'title', type: 'text' }],
    });
    try {
      await db
        .transaction()
        .execute(async (trx) => {
          await sql`ALTER FUNCTION zveltio_mask_columns(regclass, text[], text[], text[]) RENAME TO zveltio_mask_columns_gone`.execute(
            trx,
          );
          await reconcileSealedColumns(trx);
          throw new Error('rollback');
        })
        .catch((err: Error) => {
          if (err.message !== 'rollback') throw err;
        });

      const bad = await app.request('/api/health/db_rules', { headers: { cookie } });
      const badBody = (await bad.json()) as {
        ok: boolean;
        detail?: { failed: Array<{ step: string; table: string }> };
      };
      expect(badBody.ok).toBe(false);
      expect(badBody.detail?.failed).toContainEqual(
        expect.objectContaining({ step: 'column_seals', table: name }),
      );

      // A clean reconcile clears it.
      await reconcileSealedColumns(db);
      const res = await app.request('/api/health/db_rules', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    } finally {
      await DDLManager.dropCollection(db, name, { force: true }).catch(() => {});
    }
  }, 120_000);
});
