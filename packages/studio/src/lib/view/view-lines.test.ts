import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * An action form draws a list-of-objects input as a table of lines and sends
 * the lines as a list: numbers as numbers, a line with nothing filled in dropped.
 */
const post = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => ({ result: {} }));

vi.mock('#lib/api.js', () => ({
  api: {
    get: async (url: string) => {
      if (url === '/api/actions') {
        return {
          actions: [
            {
              extension: 'inv',
              name: 'createInvoice',
              input: {
                required: ['client', 'lines'],
                properties: {
                  client: { type: 'string' },
                  lines: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['description'],
                      properties: {
                        description: { type: 'string' },
                        quantity: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    post: (url: string, body: unknown) => post(url, body),
  },
  dataApi: {},
}));

afterEach(cleanup);

describe('the lines of an action form', () => {
  it('draws one row per line and sends the lines as a list', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByLabelText, getByText } = render(ViewPage, {
      props: { ext: 'inv', params: {}, view: { type: 'form', action: 'createInvoice' } } as never,
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-lines-lines"]')).toBeTruthy(),
    );
    // One line to start (minItems 1); it cannot be removed below the minimum.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect((getByLabelText(/1$/, { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);
    // An untouched line is no line: the action takes at least one, so nothing is sent.
    await fireEvent.click(getByText(/save/i, { selector: 'button' }));
    expect(post).not.toHaveBeenCalled();
    await fireEvent.input(getByLabelText('description 1'), { target: { value: 'Work' } });
    await fireEvent.input(getByLabelText('quantity 1'), { target: { value: '2.5' } });
    await fireEvent.click(getByText(/\+/));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    await fireEvent.input(
      container.querySelector('input[name="client"], #client') ?? getByLabelText(/client/i),
      {
        target: { value: 'ACME' },
      },
    );
    await fireEvent.click(getByText(/save/i, { selector: 'button' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/ext/inv/actions/createInvoice', {
      client: 'ACME',
      lines: [{ description: 'Work', quantity: 2 }],
    });
  }, 60_000);
});
