import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the mail pilot needs of the `view/2` renderer (ADR 0042 slice 5):
 * untrusted `richtext` drawn inert, `fallback`, `onOpen`, `busyWhen`, the
 * `richtext` and `file` editors, and a button's `files` as `$files`.
 */
const HOSTILE =
  '<p>Hi</p><img src=x onerror="alert(1)"><script>alert(2)</script>' +
  '<a href="javascript:alert(3)">x</a><img src="https://evil.test/pixel.gif">';
const records: Record<string, Record<string, unknown>> = {
  m1: { id: 'm1', subject: 'Hostile', body: HOSTILE, body_text: 'plain', is_read: false },
  m2: { id: 'm2', subject: 'Text only', body: null, body_text: 'only text', is_read: true },
  d1: {
    id: 'd1',
    subject: 'Draft',
    body: '<p>quoted</p><img src=x onerror="alert(4)">',
    attachments: [{ id: 'f1', name: 'a.pdf', size: 3, type: 'application/pdf' }],
    send_status: 'draft',
  },
  d2: { id: 'd2', subject: 'Going', body: '', attachments: [], send_status: 'queued' },
};
const calls: string[] = [];
const post = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => ({ result: {} }));
const update = vi.fn(async (_c: string, id: string, body: Record<string, unknown>) => ({
  ...records[id],
  ...body,
}));

vi.mock('#lib/api.js', () => ({
  api: {
    get: async (url: string) => {
      calls.push(`GET ${url}`);
      if (url === '/api/data') {
        return {
          collections: [
            {
              name: 'msgs',
              fields: [
                { name: 'subject', type: 'text' },
                { name: 'body', type: 'richtext' },
                { name: 'body_text', type: 'textarea' },
                { name: 'is_read', type: 'boolean' },
                { name: 'send_status', type: 'text' },
                { name: 'attachments', type: 'file', options: { multiple: true } },
              ],
            },
          ],
        };
      }
      if (url === '/api/actions') {
        return {
          actions: [
            { extension: 'mail', name: 'setFlags', input: {} },
            { extension: 'mail', name: 'send', input: {} },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    post: (url: string, body: unknown) => post(url, body),
  },
  dataApi: {
    list: async () => ({ records: Object.values(records), pagination: { total: 4 } }),
    get: async (collection: string, id: string) => {
      calls.push(`GET ${collection}/${id}`);
      return records[id];
    },
    update: (c: string, id: string, body: Record<string, unknown>) => update(c, id, body),
  },
}));

beforeEach(() => {
  calls.length = 0;
  post.mockClear();
  update.mockClear();
});
afterEach(cleanup);

const detail = (id: string, extra: Record<string, unknown> = {}) => ({
  ext: 'mail',
  params: { id },
  view: {
    type: 'detail',
    collection: 'msgs',
    record: { $param: 'id' },
    fields: ['subject', { field: 'body', fallback: 'body_text' }],
    ...extra,
  },
});

describe('the mail pilot in the view/2 renderer', () => {
  it('draws hostile rich text in a frame that runs nothing and loads nothing', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, { props: detail('m1') as never });
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')?.split(' ')).not.toContain('allow-scripts');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('<p>Hi</p>');
    expect(doc).toContain("default-src 'none'");
    expect(doc.toLowerCase()).not.toMatch(/<script|onerror|javascript:|\ssrc="https:/);
    // Nothing of the message is markup in Studio's own document.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  }, 60_000);

  it('shows the fallback field while the field is empty', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, { props: detail('m2') as never });
    await waitFor(() => expect(container.textContent).toContain('only text'));
    expect(container.querySelector('iframe')).toBeNull();
  }, 60_000);

  it('onOpen runs once for a record that meets `when`, never for one that does not', async () => {
    const onOpen = {
      action: 'setFlags',
      input: { message_ids: [{ $record: 'id' }], is_read: true },
      when: [{ field: 'is_read', op: 'eq', value: false }],
    };
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const unread = render(ViewPage, { props: detail('m1', { onOpen }) as never });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/mail/actions/setFlags', {
        message_ids: ['m1'],
        is_read: true,
      }),
    );
    // The run re-reads the record; it does not run again for it.
    await waitFor(() => expect(calls.filter((c) => c === 'GET msgs/m1').length).toBe(2));
    expect(post).toHaveBeenCalledTimes(1);
    unread.unmount();
    post.mockClear();
    const read = render(ViewPage, { props: detail('m2', { onOpen }) as never });
    await waitFor(() => expect(read.container.textContent).toContain('only text'));
    expect(post).not.toHaveBeenCalled();
  }, 60_000);

  it("a detail's toolbar acts on the record it shows", async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { getByText } = render(ViewPage, {
      props: detail('m2', {
        actions: [{ action: 'send', label: 'Reply', input: { message_id: { $record: 'id' } } }],
      }) as never,
    });
    await waitFor(() => expect(getByText('Reply')).toBeTruthy());
    await fireEvent.click(getByText('Reply'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/mail/actions/send', { message_id: 'm2' }),
    );
  }, 60_000);

  it('a button is busy while its record meets busyWhen', async () => {
    const send = {
      action: 'send',
      label: 'Send',
      input: { draft_id: { $record: 'id' } },
      busyWhen: [{ field: 'send_status', op: 'in' as const, value: ['queued', 'sending'] }],
    };
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const list = render(ViewPage, {
      props: {
        ext: 'mail',
        view: { type: 'list', collection: 'msgs', fields: ['subject'], rowActions: [send] },
      },
    });
    await waitFor(() => expect(list.getAllByText('Send')).toHaveLength(4));
    const busy = list.getAllByText('Send').map((b) => (b as HTMLButtonElement).disabled);
    // d2 is queued: busy; the others are not.
    expect(busy).toEqual([false, false, false, true]);
  }, 60_000);

  it('edits rich text inert, saves before a submit action, and hands the files', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText } = render(ViewPage, {
      props: {
        ext: 'mail',
        params: { draft_id: 'd1' },
        view: {
          type: 'form',
          collection: 'msgs',
          record: { $param: 'draft_id' },
          fields: ['subject', 'body', 'attachments'],
          submit: [
            {
              action: 'send',
              label: 'Send',
              input: { draft_id: { $record: 'id' } },
              files: { read: { $record: 'attachments' } },
            },
          ],
        },
      },
    });
    const editor = await waitFor(() => {
      const e = container.querySelector('[data-testid="view-richtext-editor"]');
      expect(e?.innerHTML).toContain('quoted');
      return e as HTMLElement;
    });
    expect(editor.innerHTML.toLowerCase()).not.toContain('onerror');
    expect(container.querySelector('[data-testid="view-files"]')?.textContent).toContain('a.pdf');
    await fireEvent.click(getByText('Send'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    // Saved first, as the user, through the data API; then the action, with `$files`.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe('msgs');
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
    expect(post).toHaveBeenCalledWith('/ext/mail/actions/send', {
      draft_id: 'd1',
      $files: { read: ['f1'] },
    });
  }, 60_000);

  it('a submit action with a confirm saves only once confirmed; cancelling saves nothing', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { getByText } = render(ViewPage, {
      props: {
        ext: 'mail',
        params: { draft_id: 'd1' },
        view: {
          type: 'form',
          collection: 'msgs',
          record: { $param: 'draft_id' },
          fields: ['subject'],
          submit: [
            {
              action: 'send',
              label: 'Send',
              confirm: 'Sure?',
              input: { draft_id: { $record: 'id' } },
            },
          ],
        },
      },
    });
    const dialogButton = (text: string) =>
      waitFor(() => {
        const b = [...document.body.querySelectorAll('button')].find(
          (x) => x.textContent?.trim() === text,
        );
        if (!b) throw new Error(`no ${text} button`);
        return b;
      });
    await waitFor(() => expect(getByText('Send')).toBeTruthy());
    await fireEvent.click(getByText('Send'));
    await fireEvent.click(await dialogButton('Cancel'));
    await new Promise((r) => setTimeout(r, 50));
    expect(update).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect((getByText('Send') as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(getByText('Send'));
    await fireEvent.click(await dialogButton('Confirm'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/mail/actions/send', { draft_id: 'd1' }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
  }, 60_000);
});
