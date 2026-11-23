import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Block } from '../../lib/builder-types.js';
import BlockList from './BlockList.svelte';

afterEach(cleanup);

const inner: Block = { id: 'inner', type: 'spacer', content: { height: 8 } };
const outer: Block = { id: 'outer', type: 'container', content: { children: [inner], gap: 'md' } };

describe('BlockList', () => {
  it('Enter on a nested block selects that block, not its container', async () => {
    const onSelect = vi.fn();
    const { container } = render(BlockList, {
      blocks: [outer],
      tree: [outer],
      selectedId: null,
      dragState: { active: false, zone: null },
      onChange: () => {},
      onSelect,
    });
    const blocks = container.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]');
    expect(blocks).toHaveLength(2);
    await fireEvent.keyDown(blocks[1], { key: 'Enter' });
    expect(onSelect.mock.calls).toEqual([['inner']]);
  });
});
