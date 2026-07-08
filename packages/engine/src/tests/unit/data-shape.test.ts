/**
 * Response-shaping helpers (lib/data/shape.ts) — the CRUD serialization boundary.
 * Pure/deterministic paths: normalizeFields, serializeRecord, resolveExpand,
 * computeEtag, and applyExpand's no-op guards. (The DB fetch inside applyExpand
 * is exercised by the crud/relations integration tests.)
 */

import { describe, it, expect } from 'bun:test';
import {
  applyExpand,
  computeEtag,
  normalizeFields,
  resolveExpand,
  serializeRecord,
} from '../../lib/data/shape.js';
// biome-ignore lint/suspicious/noExplicitAny: dynamic collection shapes in tests
type Any = any;

const def = (fields: Any[]): Any => ({ fields });

describe('normalizeFields', () => {
  it('returns [] for null/undefined/empty', () => {
    expect(normalizeFields(null)).toEqual([]);
    expect(normalizeFields(undefined)).toEqual([]);
    expect(normalizeFields({ fields: undefined } as Any)).toEqual([]);
  });

  it('parses a JSON-string fields column', () => {
    const parsed = normalizeFields({ fields: '[{"name":"a","type":"text"}]' } as Any);
    expect(parsed).toEqual([{ name: 'a', type: 'text' }]);
  });

  it('returns [] on malformed JSON', () => {
    expect(normalizeFields({ fields: '{not json' } as Any)).toEqual([]);
  });

  it('passes an already-parsed array through', () => {
    const arr = [{ name: 'x', type: 'number' }];
    expect(normalizeFields({ fields: arr } as Any)).toBe(arr);
  });

  it('returns [] when JSON parses to a non-array', () => {
    expect(normalizeFields({ fields: '{"name":"a"}' } as Any)).toEqual([]);
  });
});

describe('serializeRecord', () => {
  it('with no fields, strips internal columns and returns a copy', async () => {
    const rec = { id: '1', title: 'hi', search_vector: 'x', search_text: 'y' };
    const out = await serializeRecord(rec, def([]));
    expect(out).toEqual({ id: '1', title: 'hi' });
    expect(out).not.toBe(rec); // copy, not mutation
  });

  it('coerces numeric string values back to numbers', async () => {
    const out = await serializeRecord(
      { id: '1', qty: '42', price: '3.5' },
      def([
        { name: 'qty', type: 'integer' },
        { name: 'price', type: 'decimal' },
      ]),
    );
    expect(out.qty).toBe(42);
    expect(out.price).toBe(3.5);
  });

  it('leaves a non-finite numeric string alone (no NaN coercion)', async () => {
    const out = await serializeRecord(
      { id: '1', qty: 'abc' },
      def([{ name: 'qty', type: 'number' }]),
    );
    expect(out.qty).toBe('abc');
  });

  it('skips null/undefined field values', async () => {
    const out = await serializeRecord(
      { id: '1', qty: null },
      def([{ name: 'qty', type: 'number' }]),
    );
    expect(out.qty).toBeNull();
  });

  it('strips internal columns even when fields are defined', async () => {
    const out = await serializeRecord(
      { id: '1', title: 't', search_vector: 'x' },
      def([{ name: 'title', type: 'text' }]),
    );
    expect(out).not.toHaveProperty('search_vector');
  });
});

describe('resolveExpand', () => {
  const db = {} as Any;
  const collection = def([
    { name: 'owner', type: 'm2o', options: { related_collection: 'users' } },
    { name: 'ref', type: 'reference', options: { related_collection: 'accounts' } },
    { name: 'plain', type: 'text' },
    { name: 'noRel', type: 'm2o' }, // relation type but no related_collection
  ]);

  it('returns [] without an expand param', async () => {
    expect(await resolveExpand(db, collection, undefined)).toEqual([]);
    expect(await resolveExpand(db, collection, '')).toEqual([]);
  });

  it('resolves only requested relation fields with a target collection', async () => {
    const out = await resolveExpand(db, collection, 'owner,ref,plain,noRel,missing');
    expect(out.map((e) => e.field).sort()).toEqual(['owner', 'ref']);
    const owner = out.find((e) => e.field === 'owner')!;
    expect(owner.targetCollection).toBe('users');
    expect(typeof owner.targetTable).toBe('string');
  });

  it('ignores whitespace and empty entries in the param', async () => {
    const out = await resolveExpand(db, collection, ' owner , , ');
    expect(out.map((e) => e.field)).toEqual(['owner']);
  });

  it('returns [] when the collection has no fields', async () => {
    expect(await resolveExpand(db, def([]), 'owner')).toEqual([]);
  });
});

describe('applyExpand guards', () => {
  it('is a no-op with an empty plan or empty records (never touches db)', async () => {
    const db = {} as Any; // would throw if used
    await expect(applyExpand(db, [{ id: '1' }] as Any, [])).resolves.toBeUndefined();
    await expect(
      applyExpand(db, [], [{ field: 'x', targetCollection: 'y', targetTable: 'zvd_y' }]),
    ).resolves.toBeUndefined();
  });
});

describe('computeEtag', () => {
  it('is a 64-char hex SHA-256', async () => {
    const tag = await computeEtag([{ id: '1' }] as Any);
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for equal input', async () => {
    const a = await computeEtag([{ id: '1', v: 2 }] as Any);
    const b = await computeEtag([{ id: '1', v: 2 }] as Any);
    expect(a).toBe(b);
  });

  it('changes when the payload changes', async () => {
    const a = await computeEtag([{ id: '1' }] as Any);
    const b = await computeEtag([{ id: '2' }] as Any);
    expect(a).not.toBe(b);
  });
});
