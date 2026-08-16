/**
 * Moving blocks around a tree.
 *
 * A page used to be a flat list, so every operation was an array index and the
 * editor could pass `i` around. With containers a block can hold blocks, and an
 * index means nothing without knowing whose index it is — so everything here
 * works by BLOCK ID, and the tree is walked to find it.
 *
 * Ids, not paths: a path is invalidated by the very operation that uses it (drag
 * a block upward and every path below it shifts), which is the classic way a
 * drag-and-drop tree corrupts itself. An id survives the move.
 *
 * Every function returns a NEW tree. The editor's undo stack keeps previous
 * versions, so mutating in place would rewrite history as well as the present.
 */

// biome-ignore lint/suspicious/noExplicitAny: block content is untyped JSON
type Any = any;

export interface TreeBlock {
  id: string;
  type: string;
  content?: Record<string, Any>;
  style?: Record<string, Any>;
  col_span?: number;
  [k: string]: Any;
}

/** The block type that holds a list of other blocks. */
export const CONTAINER_TYPE = 'container';

/**
 * A data block drawing `view_type: 'template'` holds ONE block — designed once,
 * drawn once per record. It nests under its own key rather than `children`,
 * because it is a single slot and not a list, and because the renderer has to
 * tell the two apart.
 */
export const TEMPLATE_TYPE = 'collection_list';

function holdsTemplate(block: TreeBlock | null | undefined): boolean {
  return block?.type === TEMPLATE_TYPE && !!block?.content?.item_template;
}

/** Does this block hold other blocks, by either route? */
export function isContainer(block: TreeBlock | null | undefined): boolean {
  return block?.type === CONTAINER_TYPE || holdsTemplate(block);
}

/**
 * The blocks nested inside, whichever slot they use — so every helper below
 * walks the whole tree without knowing which kind of nesting it is looking at.
 */
export function childrenOf(block: TreeBlock): TreeBlock[] {
  if (holdsTemplate(block)) return [block.content!.item_template as TreeBlock];
  const kids = block?.content?.children;
  return Array.isArray(kids) ? kids : [];
}

function withChildren(block: TreeBlock, children: TreeBlock[]): TreeBlock {
  if (holdsTemplate(block)) {
    // One slot: an insert lands in it only when it is empty, and a removal
    // clears it. Anything else would silently drop blocks the author added.
    return { ...block, content: { ...(block.content ?? {}), item_template: children[0] ?? null } };
  }
  return { ...block, content: { ...(block.content ?? {}), children } };
}

/** The block with this id, anywhere in the tree. */
export function findById(blocks: TreeBlock[], id: string | null): TreeBlock | null {
  if (!id) return null;
  for (const b of blocks) {
    if (b.id === id) return b;
    if (isContainer(b)) {
      const hit = findById(childrenOf(b), id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The id of the container holding this block, or null when it sits at the top.
 *
 * Needed to answer "may this be dropped here" — a container cannot be dropped
 * into itself or into its own descendant, which is the move that turns a tree
 * into a cycle and the editor into an infinite render.
 */
export function parentIdOf(
  blocks: TreeBlock[],
  id: string,
  parent: string | null = null,
): string | null | undefined {
  for (const b of blocks) {
    if (b.id === id) return parent;
    if (isContainer(b)) {
      const hit = parentIdOf(childrenOf(b), id, b.id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Is `maybeDescendantId` inside the block `ancestorId` (or the same block)? */
export function isSelfOrDescendant(
  blocks: TreeBlock[],
  ancestorId: string,
  maybeDescendantId: string,
): boolean {
  if (ancestorId === maybeDescendantId) return true;
  const ancestor = findById(blocks, ancestorId);
  if (!ancestor || !isContainer(ancestor)) return false;
  return findById(childrenOf(ancestor), maybeDescendantId) !== null;
}

/** Remove a block wherever it is. */
export function removeById(blocks: TreeBlock[], id: string): TreeBlock[] {
  const out: TreeBlock[] = [];
  for (const b of blocks) {
    if (b.id === id) continue;
    out.push(isContainer(b) ? withChildren(b, removeById(childrenOf(b), id)) : b);
  }
  return out;
}

/**
 * Insert `block` at `index` inside `parentId` — or at the top level when
 * `parentId` is null.
 */
export function insertAt(
  blocks: TreeBlock[],
  parentId: string | null,
  index: number,
  block: TreeBlock,
): TreeBlock[] {
  if (parentId === null) {
    const next = [...blocks];
    next.splice(clamp(index, 0, next.length), 0, block);
    return next;
  }
  return blocks.map((b) => {
    if (b.id === parentId && isContainer(b)) {
      const kids = [...childrenOf(b)];
      kids.splice(clamp(index, 0, kids.length), 0, block);
      return withChildren(b, kids);
    }
    return isContainer(b) ? withChildren(b, insertAt(childrenOf(b), parentId, index, block)) : b;
  });
}

/**
 * Move an existing block to a new parent and index.
 *
 * Removal happens first, so the index is read against the tree the block has
 * already left — otherwise dragging a block two places down inside its own
 * parent lands it one short, every time.
 *
 * Refuses to drop a container into itself or into its own subtree; that move
 * would detach the branch from the page and lose it.
 */
export function moveTo(
  blocks: TreeBlock[],
  id: string,
  parentId: string | null,
  index: number,
): TreeBlock[] {
  if (parentId !== null && isSelfOrDescendant(blocks, id, parentId)) return blocks;
  const block = findById(blocks, id);
  if (!block) return blocks;
  return insertAt(removeById(blocks, id), parentId, index, block);
}

/** Replace one block, wherever it is, with the result of `fn`. */
export function patchById(
  blocks: TreeBlock[],
  id: string,
  fn: (b: TreeBlock) => TreeBlock,
): TreeBlock[] {
  return blocks.map((b) => {
    if (b.id === id) return fn(b);
    return isContainer(b) ? withChildren(b, patchById(childrenOf(b), id, fn)) : b;
  });
}

/** Move a block one place up or down among its siblings. */
export function nudge(blocks: TreeBlock[], id: string, delta: -1 | 1): TreeBlock[] {
  const parent = parentIdOf(blocks, id);
  if (parent === undefined) return blocks;
  const siblings = parent === null ? blocks : childrenOf(findById(blocks, parent) as TreeBlock);
  const from = siblings.findIndex((b) => b.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= siblings.length) return blocks;

  const reordered = [...siblings];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  if (parent === null) return reordered;
  return patchById(blocks, parent, (b) => withChildren(b, reordered));
}

/** Every block in the tree, depth-first — for counting and for tests. */
export function flatten(blocks: TreeBlock[]): TreeBlock[] {
  const out: TreeBlock[] = [];
  for (const b of blocks) {
    out.push(b);
    if (isContainer(b)) out.push(...flatten(childrenOf(b)));
  }
  return out;
}

/**
 * Give every block an id, recursively.
 *
 * Blocks written before the builder returned have none, and the canvas keys on
 * id — without this they collide and Svelte reuses the wrong node.
 */
export function ensureIds(blocks: TreeBlock[]): TreeBlock[] {
  return blocks.map((b) => {
    const withId: TreeBlock = { ...b, id: b.id ?? crypto.randomUUID(), content: b.content ?? {} };
    return isContainer(withId) ? withChildren(withId, ensureIds(childrenOf(withId))) : withId;
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
