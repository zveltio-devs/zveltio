import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { type AuditChainEntry, startChainWalk, walkAuditChain } from '../../lib/audit.js';

/**
 * The verify walk over one tenant's chain (ADR 0060 decision 3): the link
 * `hash = SHA-256(prev || content_hash)` from a zero genesis, contiguous `seq`,
 * each row against its entry, and a walk starting from the genesis the
 * retention purge recorded when it cut the chain's oldest end (decision 4).
 */
const sha = (...hex: string[]) => {
  const h = createHash('sha256');
  for (const x of hex) h.update(Buffer.from(x, 'hex'));
  return h.digest('hex');
};
const content = (n: number) => sha(n.toString(16).padStart(2, '0'));

/** A sound chain of `n` entries whose rows all hash to their entries. */
function chain(n: number): AuditChainEntry[] {
  let prev = '00'.repeat(32);
  return Array.from({ length: n }, (_, i) => {
    const c = content(i);
    prev = sha(prev, c);
    return { seq: i + 1, audit_id: `a${i + 1}`, content_hash: c, hash: prev, row_hash: c };
  });
}

describe('walkAuditChain', () => {
  it('accepts a sound chain across batches and ends on its head', () => {
    const all = chain(5);
    const walk = startChainWalk();
    expect(walkAuditChain(walk, all.slice(0, 2))).toBeNull();
    expect(walkAuditChain(walk, all.slice(2))).toBeNull();
    expect(walk).toMatchObject({ seq: 5, hash: all[4]!.hash, verified: 5 });
  });

  it('names the first break and its kind', () => {
    const cases: Array<[string, (c: AuditChainEntry[]) => AuditChainEntry[], object]> = [
      ['gap', (c) => [c[0]!, c[2]!], { seq: 2, audit_id: null, reason: 'gap' }],
      [
        'link',
        (c) => c.map((e, i) => (i === 1 ? { ...e, hash: content(99) } : e)),
        { seq: 2, audit_id: 'a2', reason: 'link' },
      ],
      [
        'row_changed',
        (c) => c.map((e, i) => (i === 2 ? { ...e, row_hash: content(99) } : e)),
        { seq: 3, audit_id: 'a3', reason: 'row_changed' },
      ],
      [
        'row_missing',
        (c) => c.map((e, i) => (i === 1 ? { ...e, row_hash: null } : e)),
        { seq: 2, audit_id: 'a2', reason: 'row_missing' },
      ],
    ];
    for (const [, mutate, broken] of cases) {
      expect(walkAuditChain(startChainWalk(), mutate(chain(3)))).toEqual(broken as never);
    }
  });

  it('flags a row gone at the oldest end; after a cut, walks from the genesis', () => {
    const c = chain(4);
    const gone = c.map((e, i) => (i < 2 ? { ...e, row_hash: null } : e));
    expect(walkAuditChain(startChainWalk(), gone)).toEqual({
      seq: 1,
      audit_id: 'a1',
      reason: 'row_missing',
    });

    // The purge cut seq 1-2: the genesis is entry 2, the walk checks 3-4 from it.
    const walk = startChainWalk({ seq: 2, hash: c[1]!.hash });
    expect(walkAuditChain(walk, c.slice(2))).toBeNull();
    expect(walk).toMatchObject({ seq: 4, verified: 2 });
    // A genesis that is not the cut entry's hash breaks the first link after it.
    expect(walkAuditChain(startChainWalk({ seq: 2, hash: content(99) }), c.slice(2))).toEqual({
      seq: 3,
      audit_id: 'a3',
      reason: 'link',
    });
    // Entries cut without a genesis past them: a gap.
    expect(walkAuditChain(startChainWalk(), c.slice(2))).toMatchObject({ seq: 1, reason: 'gap' });
  });
});
