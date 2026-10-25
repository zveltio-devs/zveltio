/**
 * A purge's DOWN SQL drops an extension's tables with SQL, not `dropCollection`.
 * The engine's records under each name — the registry row and the rules written
 * for the collection — stayed until someone dropped the ghost by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { purgeExtensionData } from '../../lib/extensions/migration-runner.js';
import { realtimeBus, SCHEMA_CHANGED_EVENT } from '../../lib/runtime/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const EXT = `hpurge${Date.now() % 1_000_000}`;
const NAME = `${EXT}_items`;
const KEPT = `${EXT}_kept`;

d("purge clears what the engine keeps for the extension's dropped tables", () => {
  let db: Database;
  const count = async (q: ReturnType<typeof sql<{ n: string }>>) =>
    Number((await q.execute(db)).rows[0]!.n);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const name of [NAME, KEPT]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text' }],
      } as never);
    }
    await sql`INSERT INTO zv_migrations (name, down_sql)
              VALUES (${`ext:${EXT}:001_init`}, ${`DROP TABLE "zvd_${NAME}" CASCADE`})`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
    for (const name of [NAME, KEPT]) await dropTestCollection(db, name).catch(() => {});
  });

  it('drops the registry row and rules of a table the DOWN dropped, and only that one', async () => {
    expect(
      await count(sql`SELECT count(*)::text AS n FROM zvd_permissions WHERE v2 = ${NAME}`),
    ).toBeGreaterThan(0);

    // Announced as every drop is: another replica keeps the definition it cached.
    const announced: unknown[] = [];
    const bus = realtimeBus();
    const publish = bus.publish;
    bus.publish = (m) => {
      if (m.event === SCHEMA_CHANGED_EVENT) announced.push([m.collection, m.data]);
      return publish.call(bus, m);
    };
    try {
      await purgeExtensionData(EXT, db);
      for (let i = 0; i < 50 && announced.length === 0; i++) await Bun.sleep(10);
    } finally {
      bus.publish = publish;
    }
    expect(announced).toEqual([[NAME, { action: 'drop' }]]);

    expect(
      await count(sql`SELECT count(*)::text AS n FROM zvd_collections WHERE name = ${NAME}`),
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::text AS n FROM zvd_permissions WHERE v2 = ${NAME}`),
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::text AS n FROM zvd_collections WHERE name = ${KEPT}`),
    ).toBe(1);
    expect(
      await count(sql`SELECT count(*)::text AS n FROM zvd_permissions WHERE v2 = ${KEPT}`),
    ).toBeGreaterThan(0);
  });
});
