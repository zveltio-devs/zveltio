import { describe, expect, it } from 'bun:test';
import { type AnchoredChain, judgeAnchor } from '../../lib/audit-anchor.js';

const h = (c: string) => c.repeat(64);
const anchored: AnchoredChain = {
  tenant_id: null,
  head: { seq: 5, hash: h('a') },
  genesis: { seq: 2, hash: h('g') },
};
const genesis = anchored.genesis;

describe('judgeAnchor (ADR 0060 decision 5)', () => {
  it('the anchored entry still on the chain, unchanged, holds', () => {
    expect(
      judgeAnchor(anchored, { head: { seq: 9, hash: h('z') }, genesis, atAnchored: h('a') }),
    ).toBe('ok');
  });

  it('a chain ending before the anchored entry is behind', () => {
    expect(
      judgeAnchor(anchored, { head: { seq: 4, hash: h('d') }, genesis, atAnchored: null }),
    ).toBe('behind');
    expect(
      judgeAnchor({ ...anchored, genesis: null }, { head: null, genesis: null, atAnchored: null }),
    ).toBe('behind');
  });

  it('a different entry at the anchored seq is changed', () => {
    expect(
      judgeAnchor(anchored, { head: { seq: 7, hash: h('z') }, genesis, atAnchored: h('b') }),
    ).toBe('changed');
  });

  it('a genesis past the anchored entry covers it; one at it must match', () => {
    const at = (g: { seq: number; hash: string }) =>
      judgeAnchor(anchored, { head: { seq: 8, hash: h('z') }, genesis: g, atAnchored: null });
    expect(at({ seq: 6, hash: h('c') })).toBe('covered');
    expect(at({ seq: 5, hash: h('a') })).toBe('ok');
    expect(at({ seq: 5, hash: h('b') })).toBe('changed');
  });

  it('a genesis moved back, gone or rewritten is genesis_changed', () => {
    const head = { seq: 9, hash: h('z') };
    for (const g of [null, { seq: 1, hash: h('g') }, { seq: 2, hash: h('x') }]) {
      expect(judgeAnchor(anchored, { head, genesis: g, atAnchored: h('a') })).toBe(
        'genesis_changed',
      );
    }
  });
});
