import { describe, expect, test } from 'vitest';
import {
  childrenOf,
  ensureIds,
  findById,
  flatten,
  insertAt,
  isSelfOrDescendant,
  moveTo,
  nudge,
  parentIdOf,
  patchById,
  removeById,
  type TreeBlock,
} from './block-tree.js';

const box = (id: string, kids: TreeBlock[] = []): TreeBlock => ({
  id,
  type: 'container',
  content: { children: kids },
});
const leaf = (id: string, type = 'richtext'): TreeBlock => ({ id, type, content: {} });

/**
 *   a
 *   box1
 *     b
 *     box2
 *       c
 *   d
 */
const tree = (): TreeBlock[] => [
  leaf('a'),
  box('box1', [leaf('b'), box('box2', [leaf('c')])]),
  leaf('d'),
];

describe('finding', () => {
  test('reaches a block at any depth', () => {
    expect(findById(tree(), 'c')?.id).toBe('c');
    expect(findById(tree(), 'a')?.id).toBe('a');
    expect(findById(tree(), 'nope')).toBeNull();
  });

  test('reports the holding container, null at the top', () => {
    expect(parentIdOf(tree(), 'a')).toBeNull();
    expect(parentIdOf(tree(), 'b')).toBe('box1');
    expect(parentIdOf(tree(), 'c')).toBe('box2');
    // undefined means "not in this tree", which is different from "at the top"
    expect(parentIdOf(tree(), 'ghost')).toBeUndefined();
  });

  test('flatten walks depth-first', () => {
    expect(flatten(tree()).map((b) => b.id)).toEqual(['a', 'box1', 'b', 'box2', 'c', 'd']);
  });
});

describe('inserting and removing', () => {
  test('inserts at the top level', () => {
    const out = insertAt(tree(), null, 1, leaf('x'));
    expect(out.map((b) => b.id)).toEqual(['a', 'x', 'box1', 'd']);
  });

  test('inserts inside a nested container', () => {
    const out = insertAt(tree(), 'box2', 0, leaf('x'));
    const box2 = findById(out, 'box2') as TreeBlock;
    expect(childrenOf(box2).map((b) => b.id)).toEqual(['x', 'c']);
  });

  test('an out-of-range index clamps instead of leaving a hole', () => {
    const out = insertAt(tree(), null, 99, leaf('x'));
    expect(out.map((b) => b.id)).toEqual(['a', 'box1', 'd', 'x']);
  });

  test('removes at any depth, taking the subtree with it', () => {
    expect(flatten(removeById(tree(), 'box1')).map((b) => b.id)).toEqual(['a', 'd']);
    expect(flatten(removeById(tree(), 'c')).map((b) => b.id)).toEqual([
      'a',
      'box1',
      'b',
      'box2',
      'd',
    ]);
  });

  test('the original tree is never mutated', () => {
    const original = tree();
    removeById(original, 'c');
    insertAt(original, 'box1', 0, leaf('x'));
    expect(flatten(original).map((b) => b.id)).toEqual(['a', 'box1', 'b', 'box2', 'c', 'd']);
  });
});

describe('moving', () => {
  test('moves a block into a container', () => {
    const out = moveTo(tree(), 'a', 'box2', 0);
    expect(out.map((b) => b.id)).toEqual(['box1', 'd']);
    expect(childrenOf(findById(out, 'box2') as TreeBlock).map((b) => b.id)).toEqual(['a', 'c']);
  });

  test('moves a block out to the top level', () => {
    const out = moveTo(tree(), 'c', null, 0);
    expect(out.map((b) => b.id)).toEqual(['c', 'a', 'box1', 'd']);
    expect(childrenOf(findById(out, 'box2') as TreeBlock)).toEqual([]);
  });

  test('the index is read after removal, so a downward move lands where asked', () => {
    // ['a','box1','d'] — move `a` to index 2 means "after box1".
    const out = moveTo(tree(), 'a', null, 2);
    expect(out.map((b) => b.id)).toEqual(['box1', 'd', 'a']);
  });

  test('a container cannot be dropped into itself', () => {
    const out = moveTo(tree(), 'box1', 'box1', 0);
    expect(flatten(out).map((b) => b.id)).toEqual(flatten(tree()).map((b) => b.id));
  });

  test('a container cannot be dropped into its own descendant', () => {
    // box1 → box2 would detach box1's branch from the page entirely.
    const out = moveTo(tree(), 'box1', 'box2', 0);
    expect(flatten(out).map((b) => b.id)).toEqual(flatten(tree()).map((b) => b.id));
  });

  test('isSelfOrDescendant answers both halves of that question', () => {
    const t = tree();
    expect(isSelfOrDescendant(t, 'box1', 'box1')).toBe(true);
    expect(isSelfOrDescendant(t, 'box1', 'box2')).toBe(true);
    expect(isSelfOrDescendant(t, 'box2', 'box1')).toBe(false);
    expect(isSelfOrDescendant(t, 'a', 'd')).toBe(false);
  });

  test('moving an unknown id changes nothing', () => {
    expect(moveTo(tree(), 'ghost', null, 0)).toEqual(tree());
  });
});

describe('nudging', () => {
  test('reorders among top-level siblings', () => {
    expect(nudge(tree(), 'd', -1).map((b) => b.id)).toEqual(['a', 'd', 'box1']);
  });

  test('reorders among siblings inside a container', () => {
    const out = nudge(tree(), 'box2', -1);
    expect(childrenOf(findById(out, 'box1') as TreeBlock).map((b) => b.id)).toEqual(['box2', 'b']);
  });

  test('refuses to walk off either end', () => {
    expect(nudge(tree(), 'a', -1).map((b) => b.id)).toEqual(['a', 'box1', 'd']);
    expect(nudge(tree(), 'd', 1).map((b) => b.id)).toEqual(['a', 'box1', 'd']);
  });
});

describe('patching', () => {
  test('replaces a nested block only', () => {
    const out = patchById(tree(), 'c', (b) => ({ ...b, content: { text: 'hi' } }));
    expect(findById(out, 'c')?.content?.text).toBe('hi');
    expect(findById(out, 'b')?.content).toEqual({});
  });

  test('patching a container keeps its children', () => {
    const out = patchById(tree(), 'box1', (b) => ({ ...b, col_span: 6 }));
    expect(findById(out, 'box1')?.col_span).toBe(6);
    expect(childrenOf(findById(out, 'box1') as TreeBlock).map((k) => k.id)).toEqual(['b', 'box2']);
  });
});

describe('ensureIds', () => {
  test('fills in missing ids at every depth', () => {
    const raw = [
      { type: 'richtext', content: {} },
      { type: 'container', content: { children: [{ type: 'image', content: {} }] } },
    ] as TreeBlock[];
    const out = ensureIds(raw);
    expect(out[0].id).toBeTruthy();
    expect(childrenOf(out[1])[0].id).toBeTruthy();
    expect(new Set(flatten(out).map((b) => b.id)).size).toBe(3);
  });

  test('keeps ids that already exist — a migrated block carries its view id', () => {
    const out = ensureIds([{ id: 'keep-me', type: 'collection_list', content: {} }] as TreeBlock[]);
    expect(out[0].id).toBe('keep-me');
  });
});
