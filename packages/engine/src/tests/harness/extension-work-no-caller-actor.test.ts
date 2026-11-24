/**
 * Extension work with no caller is an actor with no identity (ADR 0040).
 *
 * A row rule on a caller value stands down where `zveltio.actor` is not `on`,
 * for the engine's own work. Extension code ran there too, in four places: its
 * own `ctx.internals.withTenantIsolation`, a per-tenant cron, a listener, and a
 * worker statement with no caller (gone: no SQL crosses from a worker, RFC
 * extension-model-v3 decision 2, and no worker calls a service or listens to an
 * event, phase D slice 4). So a `data:system` extension (or, before
 * ADR 0058 removed the exemption, one the operator exempted) read every row under
 * `* created_by eq user_id` and wrote, updated and deleted another user's row,
 * and decided a row under ADR 0016's `order_author neq user_id`.
 *
 * Now the engine publishes the actor there, with no identity: a per-actor rule
 * matches no row. Collection permissions answer as before — the same extension
 * still reads and writes a collection with no row rule, and one with a
 * `static:` rule it satisfies.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { guardPerTenantScheduleHandler } from '../../lib/extensions/activation.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { clearExtensionBroadcasts, extensionBroadcast } from '../../lib/extensions/index.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { dispatchToWs, EXTENSION_BROADCAST_EVENT } from '../../lib/runtime/index.js';
import { createRlsPolicy } from '../../lib/tenancy/rls.js';
import {
  applyTenantRLS,
  DEFAULT_TENANT_ID,
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
  runWithDomain,
} from '../../lib/tenancy/index.js';
import {
  asTenant,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = DEFAULT_TENANT_ID;
const SFX = String(Date.now()).slice(-7);
/** `* created_by eq user_id`. */
const OWN = `ncown_${SFX}`;
/** ADR 0016's decision collection: `* order_author neq user_id`. */
const DECIDE = `ncdec_${SFX}`;
/** No row rule. */
const FREE = `ncfree_${SFX}`;
/** `* status eq static:open`, which the probe's rows satisfy. */
const STATIC = `ncstat_${SFX}`;
/** An inline `data:system` extension, and a worker one the operator exempted. */
const EXT = `ncext${SFX}`;
const U1 = `nc-user-${SFX}`;
/** Each collection's probe row: a user's, or one the static rule admits. */
const ROW: Record<string, Record<string, string>> = {
  [OWN]: { title: 'probe', created_by: U1 },
  [DECIDE]: { title: 'probe', order_author: U1 },
  [FREE]: { title: 'probe' },
  [STATIC]: { title: 'probe', status: 'open' },
};

/** What a statement reached: rows read, updated, deleted, and whether an insert landed. */
type Reach = { read: number; update: number; del: number; insert: boolean };
const NONE: Reach = { read: 0, update: 0, del: 0, insert: false };
const ONE: Reach = { read: 1, update: 1, del: 1, insert: true };

const refused = (e: Error) => /row-level security/.test(e.message);

/** Read, update (decide), delete, insert — the insert last: a refusal aborts the transaction. */
async function probe(h: Database, coll: string): Promise<Reach> {
  const t = sql.table(`zvd_${coll}`);
  const n = (r: { numAffectedRows?: bigint }) => Number(r.numAffectedRows ?? 0n);
  const row = ROW[coll]!;
  const read = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${t}`.execute(h)).rows[0]!
    .n;
  const update = n(await sql`UPDATE ${t} SET title = 'decided'`.execute(h));
  const del = n(await sql`DELETE FROM ${t}`.execute(h));
  const insert = await sql`
    INSERT INTO ${t} (${sql.join(Object.keys(row).map((k) => sql.ref(k)))})
    VALUES (${sql.join(Object.values(row))})`
    .execute(h)
    .then(
      () => true,
      (e: Error) => {
        if (refused(e)) return false;
        throw e;
      },
    );
  return { read, update, del, insert };
}

/** Thrown to roll a probe back; carries what it measured. */
class Rollback extends Error {
  constructor(readonly out: Reach) {
    super('rollback');
  }
}
const kept = (e: unknown): Reach => {
  if (e instanceof Rollback) return e.out;
  throw e;
};

d('extension work with no caller is an actor with no identity (ADR 0040)', () => {
  let db: Database;
  // The same extension with no capability, and with `data:system`.
  const plain = gateInternals(EXT, buildExtensionInternals(), []);
  const sys = gateInternals(EXT, buildExtensionInternals(), ['data:system']);
  /** The extension's `ctx.db`: its role, its table guard, the running transaction. */
  const extDb = () =>
    createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, new Set()) as unknown as Database;

  // Each path `reach`es the collection as such an extension does — 1 by the
  // `data:system` mark, 2 and 3 through `asSystem`, 4 by the operator's
  // exemption — or does not, and collection permissions give it nothing.

  /** 1. Inside its own `ctx.internals.withTenantIsolation` — `data:system` marks it system. */
  const ownTransaction = (coll: string, reach = true) =>
    runWithDomain(TENANT, () =>
      (reach ? sys : plain).withTenantIsolation(TENANT, async (trx) => {
        throw new Rollback(
          await probe(createRestrictedDb(trx, EXT, new Set()) as unknown as Database, coll),
        );
      }),
    ).then(() => NONE, kept);

  /** 2. A `perTenant: true` cron, reaching the collection through `asSystem`. */
  const cron = async (coll: string, reach = true) => {
    let out: Reach | undefined;
    const go = async () => {
      out = await probe(extDb(), coll);
    };
    await guardPerTenantScheduleHandler(
      async () => {
        if (getCurrentDomainOrNull() !== TENANT) return;
        await (reach ? sys.asSystem([coll], go) : go());
        throw new Error('rollback');
      },
      EXT,
      db,
    )().catch(() => undefined);
    return out;
  };

  /** 3. A listener: a broadcast from another replica, in the sender's tenant. */
  const listener = async (coll: string, reach = true) => {
    let out: Reach | undefined;
    const name = `probe.${coll}`;
    const go = async () => {
      out = await probe(extDb(), coll);
    };
    const off = extensionBroadcast(EXT).on(name, async () => {
      await (reach ? sys.asSystem([coll], go) : go());
      throw new Error('rollback');
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      await dispatchToWs({
        event: EXTENSION_BROADCAST_EVENT,
        collection: EXT,
        data: { name, data: null },
        tenantId: TENANT,
        originId: 'eng-peer',
        timestamp: new Date().toISOString(),
      });
    } finally {
      console.error = quiet;
      off();
    }
    return out;
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              VALUES (${U1}, ${U1}, ${`${U1}@example.test`}, true, now(), now())`.execute(db);
    const text = (name: string) => ({
      name,
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
    });
    for (const [name, extra] of [
      [OWN, []],
      [DECIDE, [text('order_author')]],
      [FREE, []],
      [STATIC, [text('status')]],
    ] as const) {
      await DDLManager.createCollection(db, { name, fields: [text('title'), ...extra] } as never);
      await applyTenantRLS(db, `zvd_${name}`);
    }
    await asTenant(db, TENANT, async (trx) => {
      const seed = (coll: string, cols: Record<string, string>) =>
        sql`INSERT INTO ${sql.table(`zvd_${coll}`)}
              (${sql.join(Object.keys(cols).map((k) => sql.ref(k)))})
            VALUES (${sql.join(Object.values(cols))})`.execute(trx);
      await seed(OWN, { title: 'seed', created_by: U1 });
      await seed(DECIDE, { title: 'seed', order_author: U1 });
      await seed(FREE, { title: 'seed' });
      await seed(STATIC, { title: 'seed', status: 'open' });
      await seed(STATIC, { title: 'closed', status: 'closed' });
    });
    for (const [collection, filter_field, filter_op, filter_value_source] of <const>[
      [OWN, 'created_by', 'eq', 'user_id'],
      [DECIDE, 'order_author', 'neq', 'user_id'],
      [STATIC, 'status', 'eq', 'static:open'],
    ]) {
      await createRlsPolicy({
        collection,
        role: '*',
        filter_field,
        filter_op,
        filter_value_source,
      });
    }

    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(db, EXT, new Set());
    // The cron runs where the extension is on: this tenant alone.
    await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, ${TENANT}::uuid, true, true)`.execute(db);
    invalidateActivationCache();

  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    clearExtensionBroadcasts(EXT);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db).catch(() => {});
    invalidateActivationCache();
    await sql`DELETE FROM zvd_rls_policies WHERE collection IN (${OWN}, ${DECIDE}, ${STATIC})`
      .execute(db)
      .catch(() => {});
    for (const name of [OWN, DECIDE, FREE, STATIC]) {
      await dropTestCollection(db, name).catch(() => {});
    }
    await sql`DELETE FROM "user" WHERE id = ${U1}`.execute(db).catch(() => {});
    await revokeExtensionDbRoles(db, EXT, true).catch(() => {});
    _resetExtensionDbRoleForTests();
  });

  for (const [path, run] of [
    ['its own ctx.internals.withTenantIsolation', ownTransaction],
    ['a per-tenant cron', cron],
    ['a listener', listener],
  ] as const) {
    it(`${path}: a per-actor rule admits no row, and ADR 0016's rule decides none`, async () => {
      // Before: { read: 1, update: 1, del: 1, insert: true } for both.
      expect(await run(OWN)).toEqual(NONE);
      expect(await run(DECIDE)).toEqual(NONE);
    });

    it(`${path}: collection permissions answer as before — a static rule binds as it did`, async () => {
      // Reaching the collection, it still reads and writes one with no rule, and
      // one with a `static:` rule it meets...
      expect(await run(FREE)).toEqual(ONE);
      expect(await run(STATIC)).toEqual(ONE);
      // ...and not reaching it, it still gets nothing: the actor carries no grant.
      expect(await run(FREE, false)).toEqual(NONE);
    });
  }
});
