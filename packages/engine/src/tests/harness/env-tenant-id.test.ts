/**
 * `ZVELTIO_TENANT_ID` (the single-tenant fallback in resolveTenantFromRequest)
 * must name a real `zv_tenants` row, and resolve with that row's status.
 *
 * It used to be trusted as given, with `status: 'active'` hard-coded: an id with
 * no row resolved anyway — god's visible set omitted it (reads 0 rows, REST
 * creates 403), no user could be a member (FK), and a non-RETURNING insert landed
 * in a tenant nobody could read — and a suspended tenant's id resolved active.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { assertEnvTenantExists } from '../../lib/startup-guards.js';
import { initTenantManager, resolveTenantFromRequest } from '../../lib/tenancy/index.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const ENGINE = join(import.meta.dir, '../../..');
const REFUSED = /ZVELTIO_TENANT_ID=\S+ names no tenant/;

const d = harnessAvailable() ? describe : describe.skip;

d('ZVELTIO_TENANT_ID must name a real tenant', () => {
  let db: Database;
  const suspended = crypto.randomUUID();

  beforeAll(async () => {
    db = createDb(String(process.env.TEST_DATABASE_URL));
    await sql`
      INSERT INTO zv_tenants (id, slug, name, status)
      VALUES (${suspended}, ${`envtid-${suspended.slice(0, 8)}`}, 'Env Tenant', 'suspended')
    `.execute(db);
    initTenantManager(db);
  });

  afterAll(async () => {
    delete process.env.ZVELTIO_TENANT_ID;
    await sql`DELETE FROM zv_tenants WHERE id = ${suspended}`.execute(db);
    await db.destroy();
  });

  it('the boot guard refuses an id with no row, and a non-uuid one', async () => {
    const missing = { ZVELTIO_TENANT_ID: crypto.randomUUID() };
    await expect(assertEnvTenantExists(db, missing)).rejects.toThrow(REFUSED);
    await expect(assertEnvTenantExists(db, missing)).rejects.toThrow(/unset ZVELTIO_TENANT_ID/);
    await expect(assertEnvTenantExists(db, { ZVELTIO_TENANT_ID: 'legacy' })).rejects.toThrow(
      REFUSED,
    );
  });

  it('the boot guard passes an existing tenant, and stands aside when unset', async () => {
    await expect(assertEnvTenantExists(db, { ZVELTIO_TENANT_ID: suspended })).resolves.toBe(
      undefined,
    );
    await expect(assertEnvTenantExists(db, {})).resolves.toBe(undefined);
  });

  it('a suspended tenant named by the variable resolves suspended, not active', async () => {
    process.env.ZVELTIO_TENANT_ID = suspended;
    const t = await resolveTenantFromRequest(new Headers(), 'localhost');
    expect(t?.id).toBe(suspended);
    expect(t?.status).toBe('suspended');
  });

  it('the engine refuses to boot when the variable names no row', async () => {
    const p = Bun.spawn(['bun', 'src/index.ts'], {
      cwd: ENGINE,
      env: {
        ...process.env,
        ZVELTIO_TENANT_ID: crypto.randomUUID(),
        DATABASE_URL: String(process.env.TEST_DATABASE_URL),
        NATIVE_DATABASE_URL: '',
        PORT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // On a build without the guard the engine boots and serves; the kill turns
    // that into a failure here instead of a hang.
    const timer = setTimeout(() => p.kill(), 60_000);
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    const all = `${out}\n${err}`;
    expect(p.exitCode, all.slice(-2000)).toBe(1);
    expect(all).toMatch(REFUSED);
  }, 90_000);
});
