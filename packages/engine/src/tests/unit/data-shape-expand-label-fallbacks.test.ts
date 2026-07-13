/**
 * applyExpand _label fallback chain (lib/data/shape.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { applyExpand, resolveExpand } from '../../lib/data/shape.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

const COLLECTION = {
  fields: [{ name: 'ref', type: 'm2o', options: { related_collection: 'targets' } }],
};

describe('applyExpand — _label fallbacks', () => {
  it('uses name, label, full_name, display_name, then id slice fallbacks', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'targets', fields: JSON.stringify([{ name: 'title', type: 'text' }]) },
    ]);
    db.when(/SELECT \* FROM "zvd_targets"/i, [
      { id: 't-name', name: 'Named Row' },
      { id: 't-label', label: 'Label Row' },
      { id: 't-full', full_name: 'Full Name Row' },
      { id: 't-display', display_name: 'Display Row' },
      { id: 't-idonly', created_at: '2020-01-01' },
    ]);

    const records = [
      { id: 'r1', ref: 't-name' },
      { id: 'r2', ref: 't-label' },
      { id: 'r3', ref: 't-full' },
      { id: 'r4', ref: 't-display' },
      { id: 'r5', ref: 't-idonly' },
    ] as Record<string, unknown>[];

    const plan = await resolveExpand(asDb(db), COLLECTION as never, 'ref');
    await applyExpand(asDb(db), records as never, plan);

    expect((records[0]!.ref_expanded as { _label: string })._label).toBe('Named Row');
    expect((records[1]!.ref_expanded as { _label: string })._label).toBe('Label Row');
    expect((records[2]!.ref_expanded as { _label: string })._label).toBe('Full Name Row');
    expect((records[3]!.ref_expanded as { _label: string })._label).toBe('Display Row');
    expect((records[4]!.ref_expanded as { _label: string })._label).toBe('t-idonly'.slice(0, 8));
  });
});
