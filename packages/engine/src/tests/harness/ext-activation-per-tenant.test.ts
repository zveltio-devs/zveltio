/**
 * God installs an extension for the instance; the admin of a firm decides
 * whether it acts for that firm. Until this suite passed, the second half was
 * not merely missing — it was unrepresentable: `zv_extension_registry` carried
 * `UNIQUE (name)`, so an extension had exactly one row and `tenant_id` could
 * only record who installed it last. A second firm's row was a duplicate key.
 *
 * The model these tests pin:
 *
 *   tenant_id IS NULL   god's install — on for every firm unless overridden
 *   tenant_id = <firm>  that firm admin's override, on or off
 *
 * The override direction matters. The column comment written when `tenant_id`
 * was added reads "tenant_id SET = enabled only for that specific tenant",
 * which can say "on for B alone" but cannot say "off for B" — and "off for B"
 * is the half the owner asked for. Existing rows become the global row, so the
 * upgrade changes nothing: what is active today stays active for everyone.
 *
 * Extensions load instance-wide — one process, one route table — so activation
 * is a gate at request time, never a filter at load time. A firm that turned an
 * extension off still has its code in memory. That is why the gate is proved by
 * planting on the boundary rather than by reading the loader.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import {
  extensionActivationGate,
  isExtensionActiveForTenant,
} from '../../lib/extensions/activation.js';
import { createDb, type Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const EXT = `acttest-${STAMP}`;
const FIRM_A = `11111111-1111-4111-8111-${String(STAMP).slice(-12).padStart(12, '0')}`;
const FIRM_B = `22222222-2222-4222-8222-${String(STAMP).slice(-12).padStart(12, '0')}`;

async function register(db: Database, tenantId: string | null, enabled: boolean) {
  await sql`
    INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
    VALUES (${EXT}, ${EXT}, ${tenantId}, true, ${enabled})
  `.execute(db);
}

d('extension activation is per firm (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
  });

  it('lets both halves of the model exist at once', async () => {
    // The whole point. Under `UNIQUE (name)` the second insert is a duplicate
    // key, which is why per-firm activation could not be built before.
    await register(db, null, true);
    await register(db, FIRM_B, false);

    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM zv_extension_registry WHERE name = ${EXT}
    `.execute(db);
    expect(rows.rows[0]?.n).toBe('2');
  });

  it("a firm with no row inherits god's install", async () => {
    expect(await isExtensionActiveForTenant(db, EXT, FIRM_A)).toBe(true);
  });

  it('a firm that turned it off does not get it', async () => {
    expect(await isExtensionActiveForTenant(db, EXT, FIRM_B)).toBe(false);
  });

  it('nothing is active when god never installed it', async () => {
    expect(await isExtensionActiveForTenant(db, `${EXT}-absent`, FIRM_A)).toBe(false);
  });

  it('refuses a second global row for the same extension', async () => {
    // Without NULLS NOT DISTINCT, NULL differs from itself in a unique index
    // and an extension could carry several conflicting instance-wide rows.
    let threw = false;
    try {
      await register(db, null, false);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  describe('the HTTP boundary', () => {
    // A sentinel stands in for a mounted extension: the harness boots with an
    // empty extensions directory, so reaching the sentinel is the observable
    // that "the extension acted for this firm".
    function appFor(tenantId: string) {
      const app = new Hono();
      app.use('/ext/*', async (c, next) => {
        c.set('tenant', { id: tenantId } as never);
        return next();
      });
      app.use('/ext/*', extensionActivationGate(db));
      app.all('/ext/*', (c) => c.text('reached'));
      return app;
    }

    it('reaches the extension for a firm that has it on', async () => {
      const res = await appFor(FIRM_A).request(`/ext/${EXT}/anything`);
      expect(await res.text()).toBe('reached');
    });

    it('does not reach the extension for a firm that turned it off', async () => {
      const res = await appFor(FIRM_B).request(`/ext/${EXT}/anything`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toBe('reached');
    });

    it('answers a disabled extension exactly like an absent one', async () => {
      // Otherwise the 404 body tells an outsider which extensions a firm turned
      // off, which is a fact about that firm.
      const off = await appFor(FIRM_B).request(`/ext/${EXT}/anything`);
      const absent = await appFor(FIRM_B).request(`/ext/${EXT}-absent/anything`);
      expect(await off.text()).toBe(await absent.text());
      expect(off.status).toBe(absent.status);
    });
  });
});
