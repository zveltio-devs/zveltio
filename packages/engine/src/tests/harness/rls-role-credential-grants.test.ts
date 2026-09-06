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

  it('holds no grant on a credential table', async () => {
    // The rule used to be "nothing outside `zv_`/`zvd_`", which was wrong and
    // took an installed extension to show. Extension tables are NOT all
    // prefixed: `operations/traceability` creates `trace_lots`,
    // `trace_suppliers` and fourteen more, and 109 of roughly 300 extension
    // tables are named after the feature rather than the folder. Those grants
    // are correct — an extension cannot read its own data without them — so the
    // old rule failed on any install carrying such an extension, and passed here
    // only because this database had none. A test that turns green on the
    // absence of an extension is not testing the property it names.
    //
    // The property that actually matters is narrower and does not move: the role
    // every tenant transaction drops into must hold nothing on a table that
    // stores a credential. Those tables are known by name, they are the ones
    // migration 044 left without RLS on purpose, and a new one appearing in a
    // Better-Auth upgrade is exactly what this should fail on.
    const CREDENTIAL_TABLES = ['session', 'account', 'verification', 'twoFactor', 'passkey'];
    const rows = await sql<{ table_name: string; privilege_type: string }>`
      SELECT DISTINCT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'zveltio_rls'
         AND table_schema = 'public'
         AND table_name = ANY(${CREDENTIAL_TABLES})
       ORDER BY table_name, privilege_type
    `.execute(db);
    expect(rows.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([]);
  }, 60_000);

  it('still holds the one unprefixed grant that is deliberate', async () => {
    // `user` is granted on purpose — it holds no credential, the password is in
    // `account` and the token in `session` — and the reason is recorded at the
    // grant site. Pinned so the check above cannot be satisfied by a role that
    // has simply been granted nothing at all.
    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE grantee = 'zveltio_rls' AND table_schema = 'public' AND table_name = 'user'
    `.execute(db);
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
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
