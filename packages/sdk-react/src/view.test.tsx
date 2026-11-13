/**
 * The React `view/2` renderer against a fake engine: what `loadView` asks the
 * data API for, and what `ViewRenderer` draws from it, rendered on the server.
 */
import { describe, expect, it } from 'bun:test';
import { renderToString } from 'react-dom/server';
import type { ZveltioClient } from '@zveltio/sdk';
import type { View } from '@zveltio/sdk/view';
import { extensionPages, type Loaded, loadView, ViewRenderer, type ViewHost } from './view.js';

const rows = [
  { id: 'a', name: 'Alpha', stage: 'new' },
  { id: 'b', name: 'Beta', stage: 'won' },
];

function fakeClient(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const client = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path === '/api/data') {
        return {
          collections: [
            {
              name: 'deals',
              fields: [
                { name: 'id', type: 'uuid', is_system: true },
                { name: 'name', type: 'text' },
                { name: 'stage', type: 'text' },
              ],
            },
          ],
        };
      }
      return extra[path];
    },
    post: async (path: string, body: unknown) => {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      return { result: 7 };
    },
    collection: (c: string) => ({
      list: async (p: { filter?: unknown; limit?: number }) => {
        calls.push(`LIST ${c} ${JSON.stringify(p.filter ?? {})} ${p.limit}`);
        return { records: rows, pagination: { total: rows.length, page: 1, limit: p.limit } };
      },
      get: async (id: string) => {
        calls.push(`GET ${c}/${id}`);
        return rows.find((r) => r.id === id);
      },
    }),
    actions: {
      list: async () => ({
        actions: [
          {
            extension: 'crm',
            name: 'close',
            input: {
              properties: {
                reason: { type: 'string' },
                amount: { type: 'number' },
                items: { type: 'array' },
              },
            },
          },
        ],
      }),
    },
  };
  return { client: client as unknown as ZveltioClient, calls };
}

const host: ViewHost = {
  t: (s) => s ?? '',
  scope: {},
  press: () => {},
  select: () => {},
  save: () => {},
};
const draw = (n: Loaded) => renderToString(<ViewRenderer node={n} host={host} />);

describe('loadView + ViewRenderer', () => {
  it('a list reads the data API with its filter and draws its rows', async () => {
    const { client, calls } = fakeClient();
    const view: View = {
      type: 'list',
      collection: 'deals',
      filter: [{ field: 'stage', op: 'eq', value: 'new' }],
    };
    const n = await loadView(client, 'crm', view);
    expect(calls).toContain('LIST deals {"stage":{"eq":"new"}} 25');
    const html = draw(n);
    expect(html).toContain('Alpha');
    expect(html).toContain('<th>name</th>'); // generated default: no system field
    expect(html).not.toContain('<th>id</th>');
  });

  it('a kind it does not draw is drawn as its fallback, else its collection list', async () => {
    const { client } = fakeClient();
    const own = await loadView(client, 'crm', {
      type: 'board',
      collection: 'deals',
      groupBy: 'stage',
      fallback: { type: 'stat', source: { collection: 'deals', aggregate: 'count' } },
    });
    expect(own.kind).toBe('stat');
    expect(own.from).toBe('board');
    expect(draw(own)).toContain('data-kind="board"');
    const generated = await loadView(client, 'crm', {
      type: 'map',
      collection: 'deals',
      location: 'stage',
    });
    expect(generated.kind).toBe('list');
    expect(draw(generated)).toContain('Beta');
  });

  it('a pane waiting on a selection reads nothing until one is made', async () => {
    const { client, calls } = fakeClient();
    const view: View = {
      type: 'split',
      panes: [
        { type: 'list', id: 'deals', collection: 'deals' },
        { type: 'detail', collection: 'deals', record: { $selected: 'deals' } },
      ],
    };
    const before = await loadView(client, 'crm', view);
    expect(calls.some((c) => c.startsWith('GET deals/'))).toBe(false);
    expect(before.kind).toBe('split');
    const after = await loadView(client, 'crm', view, { selected: { deals: 'b' } });
    expect(calls).toContain('GET deals/b');
    expect(draw(after)).toContain('<dd>Beta</dd>');
  });

  it('an action form draws the scalar inputs of the action, and a stat runs its action', async () => {
    const { client, calls } = fakeClient();
    const form = await loadView(client, 'crm', { type: 'form', action: 'close' });
    const html = draw(form);
    expect(html).toContain('name="reason"');
    expect(html).toContain('type="number"');
    expect(html).not.toContain('name="items"');
    const stat = await loadView(
      client,
      'crm',
      {
        type: 'stat',
        source: { action: 'close', input: { reason: { $param: 'r' } } },
      },
      { params: { r: 'x' } },
    );
    expect(calls).toContain('POST /ext/crm/actions/close {"reason":"x"}');
    expect(draw(stat)).toContain('>7</output>');
  });

  it('a sum is not drawn: the data API has no aggregate route', async () => {
    const { client } = fakeClient();
    const n = await loadView(client, 'crm', {
      type: 'stat',
      source: { collection: 'deals', aggregate: 'sum', field: 'amount' },
    });
    expect(n.kind).toBe('notice');
  });

  it('extensionPages lists the active extensions’ view/2 pages and reports an invalid one', async () => {
    const { client } = fakeClient({
      '/api/extensions': {
        extensions: ['crm'],
        meta: [
          {
            name: 'crm',
            studio: {
              pages: [
                {
                  path: '/admin/crm',
                  schema: { spec: 'zveltio.view/2', type: 'list', collection: 'deals' },
                },
                { path: '/admin/crm/bad', schema: { spec: 'zveltio.view/2', type: 'list' } },
                { path: '/admin/crm/old', schema: { sduiSchema: 1 } },
              ],
            },
          },
          {
            name: 'off',
            studio: {
              pages: [
                { path: '/x', schema: { spec: 'zveltio.view/2', type: 'list', collection: 'x' } },
              ],
            },
          },
        ],
      },
    });
    const pages = await extensionPages(client);
    expect(pages.map((p) => [p.path, p.view.ok])).toEqual([
      ['/admin/crm', true],
      ['/admin/crm/bad', false],
    ]);
  });
});
