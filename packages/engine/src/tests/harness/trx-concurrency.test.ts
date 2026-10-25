/**
 * Concurrent work on ONE request transaction keeps multi-statement scopes whole.
 *
 * A savepoint block and a role window are several statements on the
 * transaction's one connection. Anything else issued on that connection in
 * between — a `Promise.all` sibling, an un-awaited write — used to land inside
 * them:
 *
 *   - two savepoint blocks: `RELEASE a` also releases `b`, whose own RELEASE
 *     then fails and aborts the transaction (25P02 for every later statement);
 *   - a plain write inside someone else's savepoint was undone by its rollback;
 *   - a plain read inside the engine's window (`asEngineRole`) ran as the
 *     engine's login — a superuser here — past every row policy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { asExtensionDbRole, ensureExtensionDbRole } from '../../lib/extensions/ext-db-role.js';
import { asEngineRole } from '../../lib/role-window.js';
import { withSavepoint } from '../../lib/savepoint.js';
import { createRequestScopedDb, withTenantIsolation } from '../../lib/tenancy/index.js';
import { asEveryTenant, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const TAG = `trxconc-${A.slice(0, 8)}`;

const gate = () => {
  let open!: () => void;
  const shut = new Promise<void>((r) => {
    open = r;
  });
  return { open, shut };
};
const who = async (on: Database) =>
  (await sql<{ u: string }>`SELECT current_user AS u`.execute(on)).rows[0]!.u;
/** No tenant predicate: the row policy alone decides what this sees. */
const tenantsSeen = async (on: Database) =>
  (
    await sql<{ t: string }>`
      SELECT DISTINCT tenant_id::text AS t FROM zv_audit_log
       WHERE event_type = ${`${TAG}.e`} ORDER BY 1`.execute(on)
  ).rows.map((r) => r.t);

d('one request transaction, concurrent work', () => {
  let db: Database;
  let req: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    req = createRequestScopedDb(db);
    expect(await ensureExtensionDbRole(db)).toBe(true);
    for (const id of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`${TAG}-${id.slice(0, 4)}`}, ${TAG}, 'active')`.execute(db);
      // In the tenant's own transaction: a non-superuser owner is bound by the policy.
      await withTenantIsolation(id, (trx) =>
        sql`INSERT INTO zv_audit_log (event_type, tenant_id, resource_id)
            VALUES (${`${TAG}.e`}, ${id}::uuid, ${id})`.execute(trx),
      );
    }
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE event_type = ${`${TAG}.e`}`.execute(trx),
    );
    await sql`DELETE FROM zv_tenants WHERE id IN (${A}::uuid, ${B}::uuid)`.execute(db);
  });

  it('two savepoint blocks in Promise.all both succeed and leave the transaction usable', async () => {
    const out = await withTenantIsolation(A, async () => {
      const read = () => sql<{ n: number }>`SELECT 1 AS n`.execute(req);
      const both = await Promise.allSettled([
        withSavepoint(req, 'zv_conc_a', read, (e) => {
          throw e;
        }),
        withSavepoint(req, 'zv_conc_b', read, (e) => {
          throw e;
        }),
      ]);
      const after = await sql<{ n: number }>`SELECT 2 AS n`
        .execute(req)
        .then((r) => r.rows[0]!.n)
        .catch((e: { errno?: string; code?: string }) => e.errno ?? e.code);
      return { states: both.map((s) => s.status), after };
    });
    expect(out).toEqual({ states: ['fulfilled', 'fulfilled'], after: 2 });
  });

  it("a failing savepoint block does not undo a sibling's write made while it was open", async () => {
    const kept = await withTenantIsolation(A, async () => {
      const opened = gate();
      const fail = gate();
      const block = withSavepoint(
        req,
        'zv_conc_fail',
        async () => {
          opened.open();
          await fail.shut;
          await sql`SELECT 1 / 0`.execute(req);
        },
        () => 'fell back',
      );
      await opened.shut;
      const write = sql`SELECT set_config('zveltio.conc_probe', 'written', true)`.execute(req);
      await Bun.sleep(30);
      fail.open();
      await Promise.all([block, write]);
      return (
        await sql<{ v: string }>`SELECT current_setting('zveltio.conc_probe', true) AS v`.execute(
          req,
        )
      ).rows[0]!.v;
    });
    expect(kept).toBe('written');
  });

  it("a plain read sent during the engine's window runs as the request role, inside its tenant", async () => {
    const out = await withTenantIsolation(A, async () => {
      const requestRole = await who(req);
      const opened = gate();
      const close = gate();
      const window = asEngineRole(req, async () => {
        opened.open();
        await close.shut;
        return who(req);
      });
      await opened.shut;
      const plain = Promise.all([who(req), tenantsSeen(req)]);
      await Bun.sleep(30);
      close.open();
      const [inWindow, [plainRole, seen]] = await Promise.all([window, plain]);
      return { requestRole, inWindow, plainRole, seen };
    });
    expect(out.requestRole).toBe('zveltio_rls');
    expect(out.inWindow).not.toBe('zveltio_rls');
    expect({ plainRole: out.plainRole, seen: out.seen }).toEqual({
      plainRole: 'zveltio_rls',
      seen: [A],
    });
  });

  it("a plain engine read sent during an extension's window does not run as the extension", async () => {
    const out = await withTenantIsolation(A, async (trx) => {
      const opened = gate();
      const close = gate();
      const window = asExtensionDbRole('conc-probe', trx, trx.getExecutor() as never, async () => {
        opened.open();
        await close.shut;
        return who(trx);
      });
      await opened.shut;
      const plain = who(req);
      await Bun.sleep(30);
      close.open();
      return { inWindow: await window, plain: await plain };
    });
    expect(out).toEqual({ inWindow: 'zveltio_ext', plain: 'zveltio_rls' });
  });

  it('nested scopes run inside their parent, and siblings inside it still take turns', async () => {
    const out = await withTenantIsolation(A, () =>
      asEngineRole(req, async () => {
        const read = () => sql<{ n: number }>`SELECT 1 AS n`.execute(req);
        const states = await Promise.allSettled([
          withSavepoint(req, 'zv_conc_in_a', read, (e) => {
            throw e;
          }),
          withSavepoint(req, 'zv_conc_in_b', read, (e) => {
            throw e;
          }),
        ]);
        return { states: states.map((s) => s.status), role: await who(req) };
      }),
    );
    expect(out.states).toEqual(['fulfilled', 'fulfilled']);
    expect(out.role).not.toBe('zveltio_rls');
  });
});
