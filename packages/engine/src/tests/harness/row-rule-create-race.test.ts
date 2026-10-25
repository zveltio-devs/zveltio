/**
 * A row rule written while a collection is being created reaches its table.
 *
 * A rule writer rebuilds the policy of the tables it can SEE; the create (or an
 * extension's adoption) builds its table's policy from the rules it can SEE.
 * Under READ COMMITTED, a writer that listed the tables before the create
 * committed, and committed itself after the create read the rules, was seen by
 * neither: the new table stood with no `zv_row_rules` policy — RESTRICTIVE, so
 * restricting nothing — until the next boot. A `*` rule and a rule written for
 * a collection still being created both hit it.
 *
 * Made deterministic by pausing the writer right after it looked for tables,
 * then running the create to its end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type KyselyPlugin, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { announcingDDLManager } from '../../lib/extensions/register.js';
import { type RlsIdentity, withTenantIsolation } from '../../lib/tenancy/index.js';
import { createRlsPolicy, deleteRlsPolicy, initRls } from '../../lib/tenancy/rls.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ts = Date.now();
const STAR = `rrcr_star_${ts}`;
const NAMED = `rrcr_named_${ts}`;
const ADOPTED = `rrcr_adopted_${ts}`;
const OWNER = `owner_${ts}`;
const ROLE = `rrcr_role_${ts}`;
const ALICE = 'rrcr-alice';
const BOB = 'rrcr-bob';

const field = { name: OWNER, type: 'text', required: false, unique: false, indexed: false };
const member: RlsIdentity = {
  userId: ALICE,
  email: `${ALICE}@test.local`,
  role: 'member',
  roles: [ROLE],
  bypass: false,
  collectionAll: true,
};
const rule = { role: ROLE, filter_field: OWNER, filter_op: 'eq', filter_value_source: 'user_id' };

d('a row rule racing a collection create', () => {
  let db: Database;
  let tenant = '';
  const ruleIds: string[] = [];

  /** `db`, but the first statement whose SQL contains `match` waits for `release()` after it ran. */
  function pausedAt(match: string) {
    let hit!: () => void;
    const reached = new Promise<void>((r) => {
      hit = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const marked = new Set<unknown>();
    let armed = true;
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        const node = args.node as { kind: string; sqlFragments?: readonly string[] };
        if (
          armed &&
          node.kind === 'RawNode' &&
          (node.sqlFragments ?? []).join('?').includes(match)
        ) {
          armed = false;
          marked.add(args.queryId);
        }
        return args.node;
      },
      async transformResult(args) {
        if (marked.delete(args.queryId)) {
          hit();
          await gate;
        }
        return args.result;
      },
    };
    return { db: db.withPlugin(plugin) as Database, reached, release };
  }

  async function someoneWaitsOnALock(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
      if (r.rows[0]!.n > 0) return;
      await Bun.sleep(25);
    }
  }

  /** Owners the DATABASE returns to Alice for a query with no rule filter on it. */
  const seen = (name: string) =>
    withTenantIsolation(
      tenant,
      async (trx) =>
        (
          await sql
            .raw<{ o: string }>(`SELECT "${OWNER}" AS o FROM zvd_${name} ORDER BY 1`)
            .execute(trx)
        ).rows.map((r) => r.o),
      { userId: ALICE, identity: member },
    );

  const seed = (name: string) =>
    sql
      .raw(
        `INSERT INTO zvd_${name} (tenant_id, "${OWNER}") VALUES ` +
          `('${tenant}', '${ALICE}'), ('${tenant}', '${BOB}')`,
      )
      .execute(db);

  /**
   * Write `collection`'s rule paused at `pauseAt` (after it looked for tables),
   * run `create` meanwhile, then let the rule commit.
   */
  async function race(collection: string, pauseAt: string, create: () => Promise<void>) {
    // Alone: an earlier test's committed rule would be read by this create.
    for (const id of ruleIds.splice(0)) await deleteRlsPolicy(id);
    const slow = pausedAt(pauseAt);
    initRls(slow.db);
    const write = createRlsPolicy({ collection, ...rule }).then((r) => {
      ruleIds.push(r.id);
    });
    try {
      await slow.reached;
    } finally {
      initRls(db);
    }
    const made = create();
    // Serialised, the create waits for the rule; unserialised it finishes first.
    await Promise.race([made, someoneWaitsOnALock()]);
    slow.release();
    await Promise.all([write, made]);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    initRls(db);
    for (const id of ruleIds) await deleteRlsPolicy(id);
    for (const c of [STAR, NAMED, ADOPTED]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${c}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', c).execute();
    }
    await sql`DELETE FROM zvd_permissions WHERE v2 = ANY(${[STAR, NAMED, ADOPTED]})`.execute(db);
  });

  it('a `*` rule committed after a create read the rules reaches the new table', async () => {
    await race('*', 'pg_policies pp', () =>
      DDLManager.createCollection(db, { name: STAR, fields: [field] } as never),
    );
    await seed(STAR);
    expect(await seen(STAR)).toEqual([ALICE]);
  });

  it('a rule written for a collection being created reaches its table', async () => {
    await race(NAMED, 'information_schema.tables', () =>
      DDLManager.createCollection(db, { name: NAMED, fields: [field] } as never),
    );
    await seed(NAMED);
    expect(await seen(NAMED)).toEqual([ALICE]);
  });

  it('a `*` rule racing an extension adopting a table reaches it', async () => {
    await DDLManager.createCollection(db, { name: ADOPTED, fields: [field] } as never);
    // As an extension migration leaves it: the table, unregistered, no row-rule policy.
    await sql.raw(`DROP POLICY IF EXISTS zv_row_rules ON zvd_${ADOPTED}`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', ADOPTED).execute();
    await seed(ADOPTED);
    await race('*', 'pg_policies pp', () =>
      announcingDDLManager.registerMetadata(db, { name: ADOPTED, fields: [] } as never),
    );
    expect(await seen(ADOPTED)).toEqual([ALICE]);
  });
});
