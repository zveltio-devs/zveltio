import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The detail layout renders one record with lazily-fetched panels. Four of its
 * defects are only visible once it is mounted: the first panel was never
 * initialised, relation options were shared between panels by bare field name,
 * a submitted draft stayed on screen, and only `table` panels were invalidated
 * after a write.
 */
const record = { id: 'run-1', name: 'Run 1', status: 'in_progress' };

const get = vi.fn(async (url: string) => {
  if (url.includes('/inputs')) return [{ id: 'in-1', label: 'Input one' }];
  if (url.includes('/outputs')) return [{ id: 'out-1', label: 'Output one' }];
  if (url.includes('/consumptions')) return [{ id: 'c-1', qty: 2 }];
  return record;
});
const post = vi.fn(async (_url: string, _body?: unknown) => ({}));
vi.mock('$lib/api.js', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
    patch: vi.fn(async () => ({})),
    put: vi.fn(),
    delete: vi.fn(),
    fetch: vi.fn(),
  },
}));

const toastError = vi.fn();
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { error: (msg: string) => toastError(msg), success: vi.fn() },
}));

const relField = (name: string, source: string) => ({
  name,
  label: name,
  type: 'relation',
  relation: { dataSource: source, labelKey: 'label' },
});

function resource(panels: unknown[]) {
  return {
    id: 'production',
    label: 'production',
    layout: 'detail',
    detail: {
      loadEndpoint: '/ext/ops/production/{id}',
      titleKey: 'name',
      panels,
    },
  };
}

const props = (panels: unknown[]) => ({
  resource: resource(panels) as any,
  routeParams: { id: 'run-1' },
  extName: 'ops',
});

beforeEach(() => {
  get.mockClear();
  post.mockClear();
  toastError.mockClear();
});
afterEach(cleanup);

describe('DetailLayout first panel', () => {
  it('fetches the first panel instead of leaving it empty', async () => {
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const { container } = render(DetailLayout, {
      props: props([
        {
          id: 'consumptions',
          label: 'consumptions',
          kind: 'table',
          dataSource: '/ext/ops/production/{id}/consumptions',
          columns: [{ key: 'qty', label: 'qty' }],
        },
      ]),
    });

    // No click: panel 0 is the one the page opens on.
    await waitFor(() =>
      expect(get.mock.calls.map((c) => c[0])).toContain('/ext/ops/production/run-1/consumptions'),
    );
    await waitFor(() => expect(container.textContent).toContain('2'));
  }, 60_000);

  it('builds the draft of a first panel that is a form', async () => {
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const { container } = render(DetailLayout, {
      props: props([
        {
          id: 'consume',
          label: 'consume',
          kind: 'form',
          form: {
            endpoint: '/ext/ops/production/{id}/consume',
            fields: [{ name: 'quantity_used', label: 'qty', type: 'number' }],
          },
        },
      ]),
    });

    // Without a draft the field binding reads `undefined[name]` and the page
    // renders nothing at all.
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('input[type="number"]')).toBeTruthy(),
    );
  }, 60_000);
});

describe('DetailLayout relation options', () => {
  it('keeps two same-named relation fields on their own source', async () => {
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const { container, getByText } = render(DetailLayout, {
      props: props([
        {
          id: 'consume',
          label: 'consume',
          kind: 'form',
          form: {
            endpoint: '/ext/ops/production/{id}/consume',
            fields: [relField('lot_id', '/ext/ops/inputs')],
          },
        },
        {
          id: 'produce',
          label: 'produce',
          kind: 'form',
          form: {
            endpoint: '/ext/ops/production/{id}/produce',
            fields: [relField('lot_id', '/ext/ops/outputs')],
          },
        },
      ]),
    });

    await waitFor(() => expect(container.textContent).toContain('Input one'));
    await fireEvent.click(getByText('produce'));
    // One cache slot per bare field name served both panels: the second picker
    // listed the first one's rows.
    await waitFor(() => expect(container.textContent).toContain('Output one'));
    expect(container.textContent).not.toContain('Input one');
  }, 60_000);
});

describe('DetailLayout panel form submit', () => {
  it('clears the draft and invalidates every cached panel', async () => {
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const { container, getByText } = render(DetailLayout, {
      props: props([
        {
          id: 'consumptions',
          label: 'consumptions',
          kind: 'table',
          dataSource: '/ext/ops/production/{id}/consumptions',
          columns: [{ key: 'qty', label: 'qty' }],
        },
        {
          id: 'tree',
          label: 'tree',
          kind: 'tree',
          dataSource: '/ext/ops/production/{id}/inputs',
        },
        {
          id: 'consume',
          label: 'consume',
          kind: 'form',
          form: {
            endpoint: '/ext/ops/production/{id}/consume',
            fields: [{ name: 'quantity_used', label: 'qty', type: 'number' }],
          },
        },
      ]),
    });

    await waitFor(() => expect(container.textContent).toContain('tree'));
    await fireEvent.click(getByText('tree'));
    await waitFor(() => expect(get.mock.calls.some((c) => c[0].includes('/inputs'))).toBe(true));

    await fireEvent.click(getByText('consume'));
    const qty = () => container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await waitFor(() => expect(qty()).toBeTruthy());
    await fireEvent.input(qty(), { target: { value: '7' } });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.btn-primary')!);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // The values used to stay, so Save re-posted the same consumption.
    await waitFor(() => expect(qty().value).toBe('0'));

    // The tree is the panel a consume changes; only tables were busted.
    get.mockClear();
    await fireEvent.click(getByText('tree'));
    await waitFor(() => expect(get.mock.calls.some((c) => c[0].includes('/inputs'))).toBe(true));
  }, 60_000);
});

describe('DetailLayout header actions', () => {
  it('does not open a download that leaves the extension namespace', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const p = props([{ id: 'info', label: 'info', kind: 'fields', fields: [] }]);
    (p.resource as any).detail.actions = [
      {
        id: 'label',
        kind: 'download',
        label: 'label',
        endpoint: '/ext/ops/../../api/backups/{id}',
      },
    ];
    const { getByText } = render(DetailLayout, { props: p });

    await waitFor(() => expect(getByText('label')).toBeTruthy());
    await fireEvent.click(getByText('label'));
    // A download is a GET, but the URL still comes from the schema and travels
    // with the admin's cookie. It used to return before the guard.
    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, 60_000);
});

describe('DetailLayout load failure', () => {
  it('reports a server error instead of showing it as "not found"', async () => {
    get.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Request failed: 500'), { status: 500 });
    });
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    render(DetailLayout, {
      props: props([{ id: 'info', label: 'info', kind: 'fields', fields: [] }]),
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Request failed: 500'));
  }, 60_000);

  it('stays silent for a genuine 404', async () => {
    get.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const { container } = render(DetailLayout, {
      props: props([{ id: 'info', label: 'info', kind: 'fields', fields: [] }]),
    });

    await waitFor(() => expect(container.textContent).toContain('Page not found'));
    expect(toastError).not.toHaveBeenCalled();
  }, 60_000);
});

describe('DetailLayout hidden panel', () => {
  it('moves off a form panel whose visibleWhen stopped matching', async () => {
    let status = 'in_progress';
    get.mockImplementation(async (url: string) => {
      if (url.includes('/consumptions')) return [{ id: 'c-1', qty: 2 }];
      return { ...record, status };
    });
    const { default: DetailLayout } = await import('./DetailLayout.svelte');
    const p = props([
      {
        id: 'consume',
        label: 'consume',
        kind: 'form',
        form: {
          endpoint: '/ext/ops/production/{id}/consume',
          visibleWhen: { field: 'status', equals: 'in_progress' },
          fields: [{ name: 'quantity_used', label: 'qty', type: 'number' }],
        },
      },
      {
        id: 'consumptions',
        label: 'consumptions',
        kind: 'table',
        dataSource: '/ext/ops/production/{id}/consumptions',
        columns: [{ key: 'qty', label: 'qty' }],
      },
    ]);
    (p.resource as any).detail.actions = [
      {
        id: 'finish',
        label: 'finish',
        method: 'PATCH',
        endpoint: '/ext/ops/production/{id}/finish',
      },
    ];
    const { container, getByText } = render(DetailLayout, { props: p });

    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('input[type="number"]')).toBeTruthy(),
    );

    status = 'done';
    await fireEvent.click(getByText('finish'));

    // The tab vanishes with the status change; `panelId` used to keep pointing
    // at it and every branch of the body fell through to nothing.
    await waitFor(() => expect(container.textContent).toContain('2'));
    expect(container.querySelector('input[type="number"]')).toBeNull();
  }, 60_000);
});
