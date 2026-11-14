/**
 * An extension's update that retypes a field to a type with the same column
 * (ADR 0042 slice 5: mail's `body_html` textarea → `richtext`, its draft
 * `attachments` json → `file`). The extension plan had no op for any type
 * change but into `secret`, so the update refused to load. Now the column and
 * every value stay, the table is not rewritten, and the next load owes nothing;
 * a change of column is still refused. ADR 0047 decision 4 settles the rule.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { applyDeclaredCollections } from '../../lib/extensions/declared-collections.js';
import { planExtensionSchema, runApplyOp } from '../../lib/schema-artifact/apply.js';
import { SchemaFileError } from '../../lib/schema-artifact/plan.js';
import { DDLManager } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `rsc_${STAMP}`;
const EXT = `rsc-ext-${STAMP}`;

const file = (body: string, files: string, label = 'text') => ({
  [`collections/${C}.json`]: JSON.stringify({
    name: C,
    fields: [
      { name: 'label', type: label },
      { name: 'body', type: body },
      { name: 'files', type: files },
    ],
  }),
});

d("an extension's update retypes a field within its column (ADR 0042 slice 5)", () => {
  let db: Database;
  const table = `zvd_${C}`;
  const raw = async () =>
    (
      await sql<{ body: string; files: unknown }>`
        SELECT body, files FROM ${sql.table(table)} ORDER BY label`.execute(db)
    ).rows;
  const relfilenode = async () =>
    (
      await sql<{ n: string }>`
        SELECT relfilenode::text AS n FROM pg_class WHERE oid = ${table}::regclass`.execute(db)
    ).rows[0]!.n;
  const types = async () => {
    const def = await DDLManager.getCollection(db, C);
    const fields = (typeof def?.fields === 'string' ? JSON.parse(def.fields) : def?.fields) as {
      name: string;
      type: string;
    }[];
    return Object.fromEntries(fields.map((f) => [f.name, f.type]));
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await applyDeclaredCollections(db, EXT, file('textarea', 'json'), true);
    await sql`
      INSERT INTO ${sql.table(table)} (label, body, files) VALUES
        ('a', '<p>Hi <img src=x onerror=alert(1)></p>', ${JSON.stringify([{ file_id: 'f1', filename: 'a.pdf' }])}::jsonb),
        ('b', 'plain', NULL)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (db) await dropTestCollection(db, C);
  });

  it('keeps every value and the table, and owes nothing after', async () => {
    const before = await raw();
    const node = await relfilenode();
    await applyDeclaredCollections(db, EXT, file('richtext', 'file'), true);
    expect(await types()).toMatchObject({ body: 'richtext', files: 'file' });
    expect(await raw()).toEqual(before);
    // No ALTER COLUMN TYPE: the table was not rewritten.
    expect(await relfilenode()).toBe(node);
    expect(await planExtensionSchema(db, EXT, file('richtext', 'file'))).toEqual([]);
  });

  it('a change of column is still refused, and changes nothing', async () => {
    await expect(
      applyDeclaredCollections(db, EXT, file('richtext', 'file', 'integer'), true),
    ).rejects.toThrow(/change field label type text → integer/);
    expect((await types()).label).toBe('text');
  });

  it('a retype op on a field no longer of a kept type is refused at apply', async () => {
    // Planned against `richtext`; the field became `password` before it ran.
    await expect(
      runApplyOp(
        db,
        { kind: 'retype', collection: C, field: 'label', to: 'password' },
        undefined,
        EXT,
      ),
    ).rejects.toBeInstanceOf(SchemaFileError);
    expect((await types()).label).toBe('text');
  });
});
