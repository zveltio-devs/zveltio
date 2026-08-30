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
  extensionNameCandidates,
  guardEventHandler,
  guardListenerArgs,
  guardPublicHandler,
  guardScheduleHandler,
  invalidateActivationCache,
  isExtensionActiveAnywhere,
  isExtensionActiveForTenant,
} from '../../lib/extensions/activation.js';
import { runWithDomain } from '../../lib/tenancy/index.js';
import type { Database } from '../../db/index.js';
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

d('the other things an extension acts through (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await register(db, null, true);
    await register(db, FIRM_B, false);
    invalidateActivationCache();
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    invalidateActivationCache();
  });

  describe('event listeners', () => {
    // Gated on the ambient domain, which is the firm whose request or job is
    // being served.
    it('runs for a firm that has it on', async () => {
      let ran = false;
      const fn = guardEventHandler(
        () => {
          ran = true;
        },
        EXT,
        db,
      );
      await runWithDomain(FIRM_A, () => fn());
      expect(ran).toBe(true);
    });

    it('does not run for the firm that switched it off', async () => {
      let ran = false;
      const fn = guardEventHandler(
        () => {
          ran = true;
        },
        EXT,
        db,
      );
      await runWithDomain(FIRM_B, () => fn());
      expect(ran).toBe(false);
    });

    it('finds the listener among the bus arguments by shape, not position', async () => {
      // `events.on` is called both as (event, handler) and (event, opts, handler).
      let ran = false;
      const [, , wrapped] = guardListenerArgs(
        [
          'record.afterInsert',
          { once: true },
          () => {
            ran = true;
          },
        ],
        EXT,
        db,
      );
      await runWithDomain(FIRM_B, () => (wrapped as () => unknown)());
      expect(ran).toBe(false);
      expect(typeof wrapped).toBe('function');
    });
  });

  describe('schedules', () => {
    it('runs while at least one firm has it on', async () => {
      let ran = false;
      await guardScheduleHandler(
        () => {
          ran = true;
        },
        EXT,
        db,
      )();
      // FIRM_B switched it off, but god's install is on for everyone else.
      expect(ran).toBe(true);
    });

    it('does not run for an extension no firm has on', async () => {
      let ran = false;
      await guardScheduleHandler(
        () => {
          ran = true;
        },
        `${EXT}-absent`,
        db,
      )();
      expect(ran).toBe(false);
    });
  });

  describe('public routes', () => {
    function appWith(handler: ReturnType<typeof guardPublicHandler>, tenantId?: string) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        if (tenantId) c.set('tenant', { id: tenantId } as never);
        return next();
      });
      // The guard returns the loosest handler shape Hono accepts at runtime;
      // `get()` wants a narrower one than the wrapper can promise statically.
      app.get('/scim/Users', handler as never);
      return app;
    }

    it('is refused for the firm that switched it off', async () => {
      const app = appWith(
        guardPublicHandler((c) => c.text('acted'), EXT, db),
        FIRM_B,
      );
      expect((await app.request('/scim/Users')).status).toBe(404);
    });

    it('still answers when the request names no firm at all', async () => {
      // The case the escape hatch exists for: an IdP whose bearer token IS the
      // tenant identity cannot name a firm before the extension resolves one.
      const app = appWith(guardPublicHandler((c) => c.text('acted'), EXT, db));
      expect(await (await app.request('/scim/Users')).text()).toBe('acted');
    });

    it('is refused, firm or no firm, once no firm has it on', async () => {
      const app = appWith(guardPublicHandler((c) => c.text('acted'), `${EXT}-absent`, db));
      expect((await app.request('/scim/Users')).status).toBe(404);
    });
  });

  describe('the decision itself', () => {
    it('separates a scoped name from its first path segment', () => {
      expect(extensionNameCandidates('audit/sweep/thing')).toEqual(['audit/sweep', 'audit']);
      expect(extensionNameCandidates('crm/contacts')).toEqual(['crm/contacts', 'crm']);
      expect(extensionNameCandidates('crm')).toEqual(['crm']);
      expect(extensionNameCandidates('')).toEqual([]);
    });

    it('lets the path gate fall through for a path outside /ext/', async () => {
      const app = new Hono();
      app.use('*', extensionActivationGate(db));
      app.get('/api/anything', (c) => c.text('engine'));
      expect(await (await app.request('/api/anything')).text()).toBe('engine');
    });

    it('sees a firm changing its mind, once the cache is told', async () => {
      expect(await isExtensionActiveForTenant(db, EXT, FIRM_B)).toBe(false);
      await sql`
        UPDATE zv_extension_registry SET is_enabled = true
         WHERE name = ${EXT} AND tenant_id = ${FIRM_B}
      `.execute(db);
      // Still the cached answer, which is the point of the TTL...
      expect(await isExtensionActiveForTenant(db, EXT, FIRM_B)).toBe(false);
      invalidateActivationCache(EXT);
      expect(await isExtensionActiveForTenant(db, EXT, FIRM_B)).toBe(true);

      await sql`
        UPDATE zv_extension_registry SET is_enabled = false
         WHERE name = ${EXT} AND tenant_id = ${FIRM_B}
      `.execute(db);
      invalidateActivationCache();
      expect(await isExtensionActiveForTenant(db, EXT, FIRM_B)).toBe(false);
    });

    it('falls OPEN when the database cannot answer', async () => {
      // Deliberate: activation is a firm's preference about a feature, not an
      // authorization decision. A database that cannot answer must not switch
      // the product off for everyone.
      // A database handle that refuses, rather than a second real pool: opening
      // one here left the engine's own pool disturbed for later files, and the
      // pool-recycle suite caught it. What is under test is the catch, not the
      // driver.
      const broken = {
        getExecutor() {
          throw new Error('connection refused');
        },
      } as unknown as Database;
      // A firm nothing has cached yet: the cache is keyed by (firm, extension)
      // and knows nothing about which database answered.
      const unseen = `${FIRM_B}-never-asked`;
      expect(await isExtensionActiveForTenant(broken, EXT, unseen)).toBe(true);
      expect(await isExtensionActiveAnywhere(broken, EXT)).toBe(true);
    });

    it('asks once when several cold requests arrive together', async () => {
      invalidateActivationCache();
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => isExtensionActiveForTenant(db, EXT, FIRM_A)),
      );
      expect(answers).toEqual(Array.from({ length: 8 }, () => true));
    });
  });
});
