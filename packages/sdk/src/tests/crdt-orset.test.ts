import './setup';
import { describe, it, expect } from 'bun:test';
import { orSetAdd, orSetRemove, orSetMerge, orSetValues } from '../crdt.js';

describe('OR-Set — removal survives a merge with a stale replica', () => {
  it('does not resurrect an element that one replica removed', () => {
    const added = orSetAdd<string>([], 'x');
    const uid = added[0].uid;
    const stale = [...added]; // a replica that never saw the removal
    const removed = orSetRemove(added, uid);

    const first = orSetMerge(removed, stale);
    expect(orSetValues(first)).toEqual([]);

    // The stale replica syncs again. Without its tombstone the merged set has
    // no record of the removal, so the element reads as a fresh addition.
    const second = orSetMerge(first, stale);
    expect(orSetValues(second), 'the removed element came back').toEqual([]);
  });

  it('an element added after a removal is kept', () => {
    const first = orSetAdd<string>([], 'x');
    const removed = orSetRemove(first, first[0].uid);
    const readded = orSetAdd(removed, 'x');
    expect(orSetValues(orSetMerge(readded, removed))).toEqual(['x']);
  });
});
