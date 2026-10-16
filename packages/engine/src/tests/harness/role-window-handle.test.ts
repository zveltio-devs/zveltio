/**
 * `asEngineRole` queues its window on the transaction it is handed.
 *
 * It used to queue on the request's transaction (the ALS) whatever `db` was. An
 * engine helper handed another transaction — `ctx.internals.addTenantMember(trx)`
 * inside `ctx.adminDb.transaction()` — then opened its window in the middle of
 * an extension window on that transaction: the extension's statement ran as the
 * engine's login, and the engine's restore left the transaction on the
 * extension role for every engine statement after it.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { engineHandle } from '../../lib/engine-handle.js';
import { asExtensionDbRole, ensureExtensionDbRole } from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { asEngineRole } from '../../lib/role-window.js';
import { DEFAULT_TENANT_ID, withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const gate = () => {
  let open!: () => void;
  const shut = new Promise<void>((r) => {
    open = r;
  });
  return { open, shut };
};
const who = async (on: Database) =>
  (await sql<{ u: string }>`SELECT current_user AS u`.execute(on)).rows[0]!.u;

d('asEngineRole on a transaction other than the request one', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
    expect(await ensureExtensionDbRole(db)).toBe(true);
  }, 120_000);

  it('waits for the extension window open on that transaction, and leaves its role as it was', async () => {
    const login = (await sql<{ u: string }>`SELECT session_user AS u`.execute(db)).rows[0]!.u;
    // In a request, as an extension's adminDb transaction would be.
    await withTenantIsolation(DEFAULT_TENANT_ID, () =>
      db.transaction().execute(async (trx) => {
        // What `ctx.internals.*(trx)` runs its engine SQL on.
        const engine = engineHandle(createRestrictedDb(trx, 'rw-probe', new Set()));
        const extOpened = gate();
        const extGo = gate();
        const engGo = gate();
        // An extension statement's window, held open between its SET and the statement.
        const ext = asExtensionDbRole('rw-probe', trx, trx.getExecutor() as never, async () => {
          extOpened.open();
          await extGo.shut;
          return who(trx);
        });
        await extOpened.shut;
        const eng = asEngineRole(engine, async () => {
          await engGo.shut;
          return who(engine);
        });
        await Bun.sleep(50);
        extGo.open();
        const extUser = await ext;
        engGo.open();
        const engUser = await eng;
        const after = (await sql<{ r: string }>`SELECT current_setting('role') AS r`.execute(trx))
          .rows[0]!.r;
        expect({ extUser, engUser, after }).toEqual({
          extUser: 'zveltio_ext',
          engUser: login,
          after: 'none',
        });
      }),
    );
  });
});
