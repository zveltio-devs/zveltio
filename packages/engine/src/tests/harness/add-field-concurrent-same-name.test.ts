/**
 * Two adds of one field name at once: one is refused, and the metadata never
 * names a type the column does not have (A15).
 *
 * Since DR-37 the column's ADD and the metadata's append are two transactions,
 * with the unique key built CONCURRENTLY between them. Both adds passed the
 * route's 409 check; A created the column, B found it there (a no-op ADD IF NOT
 * EXISTS) and appended its own type while A was still building its key; A's
 * append then found the name and answered success without writing. The
 * metadata said `integer` for a `text` column — and had A's key build failed,
 * A would have dropped the column B had recorded.
 *
 * Deterministic: A's first query after its ADD commits (the look for an
 * existing unique index) is held in JS until B has run to the end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type KyselyPlugin, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `afc_${Date.now()}`;
const TABLE = `zvd_${C}`;

/** A plugin that holds the result of the first query matching `marker` until `release`. */
function holdAt(marker: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached!: () => void;
  const atGate = new Promise<void>((r) => {
    reached = r;
  });
  const held = new Set<unknown>();
  let done = false;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (!done && JSON.stringify(args.node).includes(marker)) {
        done = true;
        held.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (held.has(args.queryId)) {
        reached();
        await gate;
      }
      return args.result;
    },
  };
  return { plugin, release, atGate };
}

d('two adds of one field name at once', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text' }],
    } as never);
  });

  afterAll(async () => {
    await dropTestCollection(db, C);
  });

  it('refuses one, and the metadata names the type the column has', async () => {
    const hold = holdAt('i.indisunique AND i.indisvalid');
    const a = DDLManager.addField(db.withPlugin(hold.plugin), C, {
      name: 'code',
      type: 'text',
      unique: true,
    } as never).then(
      () => 'ok',
      (e: Error) => e,
    );
    await hold.atGate; // A's column is committed; its key is not built yet.
    const b = await DDLManager.addField(db, C, { name: 'code', type: 'integer' } as never).then(
      () => 'ok',
      (e: Error) => e,
    );
    hold.release();
    const results = [await a, b];

    const column = (
      await sql<{ t: string }>`
        SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
         WHERE attrelid = ${TABLE}::regclass AND attname = 'code' AND NOT attisdropped`.execute(db)
    ).rows[0]?.t;
    DDLManager.invalidateCache(C);
    const meta = await DDLManager.getCollection(db, C);
    const recorded = (meta!.fields as { name: string; type: string }[]).filter(
      (f) => f.name === 'code',
    );

    expect(results.filter((r) => r === 'ok').length, String(results)).toBe(1);
    const refused = results.find((r) => r !== 'ok') as Error & { code?: string };
    expect(refused.code).toBe('DUPLICATE');
    expect(column).toBe('text');
    expect(recorded.map((f) => f.type)).toEqual(['text']);
  });
});
