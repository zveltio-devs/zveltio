/**
 * `zveltio_rls` must hold no grant on a credential table.
 *
 * The role every tenant transaction drops into is granted DML on every table in
 * `public` except a named few. That is a denylist over an open namespace, and
 * this repository has paid for that shape three times — the last one let any
 * extension read `session.token`.
 *
 * It happened again: `passkey` arrived in migration 002 to fix a table Better
 * Auth had always expected, and nothing added it to the exclusion list. Measured
 * before this test existed — inside a tenant transaction, as `zveltio_rls`:
 *
 *     SELECT token FROM session          → permission denied
 *     INSERT INTO passkey (…, "userId")  → ALLOWED
 *
 * An INSERT there registers an attacker-chosen authenticator against another
 * user's account, which is an authentication bypass rather than a data leak.
 *
 * So this asserts the PROPERTY rather than the instance: outside the engine's own
 * `zv_`/`zvd_` namespace, the only table this role may touch is `user`, which is
 * granted deliberately (it holds no credentials — the password is in `account`,
 * the token in `session`) and documented where the grant is made. A fifth
 * Better-Auth table appearing in a future upgrade fails here instead of being
 * granted in silence.
 */
import { describe, expect, it, beforeAll } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp } from '../../testing/app-harness.js';

const URL = process.env.TEST_DATABASE_URL;

/** Granted on purpose, with the reason recorded at the grant site. */
const DELIBERATE = new Set(['user']);

describe.skipIf(!URL)('zveltio_rls grants stay inside the engine namespace', () => {
  let db: any;
  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it('holds no grant on a table outside zv_/zvd_ except the ones named here', async () => {
    const rows = await sql<{ table_name: string }>`
      SELECT DISTINCT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'zveltio_rls'
         AND table_schema = 'public'
         AND table_name !~ '^(zv_|zvd_)'
       ORDER BY table_name
    `.execute(db);
    const unexpected = rows.rows.map((r) => r.table_name).filter((t) => !DELIBERATE.has(t));
    expect(unexpected).toEqual([]);
  }, 60_000);

  it('cannot read a session token or write a passkey', async () => {
    const { withTenantIsolation, DEFAULT_TENANT_ID } = await import('../../lib/tenancy/index.js');
    // ONE statement per transaction, deliberately. A refused statement aborts the
    // whole transaction, so a second one in the same block answers "current
    // transaction is aborted" and the assertion measures Postgres rather than the
    // grant. This test made that mistake on its first run.
    const refused = async (stmt: (trx: never) => Promise<unknown>): Promise<string> => {
      try {
        await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => stmt(trx as never));
        return 'ALLOWED';
      } catch (err) {
        return (err as Error).message;
      }
    };

    expect(await refused((trx) => sql`SELECT token FROM session LIMIT 1`.execute(trx))).toMatch(
      /permission denied/i,
    );

    expect(
      await refused((trx) =>
        sql`INSERT INTO passkey (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt")
              VALUES ('rls-grant-probe', 'probe', 'k', '00000000-0000-0000-0000-0000000000aa', 'c', 0, 'singleDevice', false, now())`.execute(
          trx,
        ),
      ),
    ).toMatch(/permission denied/i);
  }, 60_000);
});
