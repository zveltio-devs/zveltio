import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openFile = vi.fn(async (_id: string) => {});
vi.mock('./engine.js', async (orig) => ({
  ...(await orig<typeof import('./engine.js')>()),
  openFile: (id: string) => openFile(id),
}));

afterEach(cleanup);

describe('ViewFiles', () => {
  it('opening a shown file does not also click the row around it', async () => {
    const { default: ViewFiles } = await import('./ViewFiles.svelte');
    const row = vi.fn();
    const { getByText } = render(ViewFiles, {
      value: { id: 'f1', name: 'invoice.pdf', size: 1, type: 'application/pdf' },
    });
    // Svelte delegates `onclick` to the mount root, so a row's handler hears a
    // click above the root, the way ViewList's card and row do in the page.
    document.body.addEventListener('click', row);
    await fireEvent.click(getByText('invoice.pdf'));
    expect(openFile).toHaveBeenCalledWith('f1');
    expect(row).not.toHaveBeenCalled();
    document.body.removeEventListener('click', row);
  }, 60_000);
});
