// `zveltio extension validate` and `pack` check the manifest's view/2 pages (ADR 0042).
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkViews, extensionPackCommand } from './extension-pack.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manifest = {
  name: 'billing',
  version: '1.0.0',
  collections: ['invoices'],
  actions: [{ name: 'pay' }],
  dependencies: [{ name: 'crm' }],
};

function fixture(views: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-views-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'studio', 'views'), { recursive: true });
  const pages = Object.entries(views).map(([name, view]) => {
    writeFileSync(join(dir, 'studio', 'views', `${name}.json`), JSON.stringify(view));
    return { path: `/app/billing/${name}`, label: name, schema: `views/${name}.json` };
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, studio: { pages } }));
  return dir;
}

const list = (extra: Record<string, unknown> = {}) => ({
  spec: 'zveltio.view/2',
  type: 'list',
  collection: 'invoices',
  rowActions: [{ action: 'pay' }, { action: 'crm.linkContact' }],
  ...extra,
});

describe('checkViews', () => {
  it('passes a valid view that names its own collection and actions', () => {
    const dir = fixture({ invoices: list() });
    const m = { ...manifest, studio: { pages: [{ schema: 'views/invoices.json' }] } };
    expect(checkViews(dir, m)).toEqual([]);
  });

  it('skips a view/1 document and reports a view/2 one that names what it does not own', () => {
    const dir = fixture({});
    writeFileSync(
      join(dir, 'studio/views/bad.json'),
      JSON.stringify(list({ endpoint: '/ext/billing/x' })),
    );
    writeFileSync(
      join(dir, 'studio/views/foreign.json'),
      JSON.stringify(list({ collection: 'contacts' })),
    );
    writeFileSync(
      join(dir, 'studio/views/v1.json'),
      JSON.stringify({ sduiSchema: 1, title: 't', resources: [] }),
    );
    const m = {
      ...manifest,
      studio: { pages: ['bad', 'foreign', 'v1'].map((n) => ({ schema: `views/${n}.json` })) },
    };
    expect(checkViews(dir, m).map((e) => [e.code, e.file, e.message])).toEqual([
      ['VIEW_INVALID', 'studio/views/bad.json', '/endpoint is not part of view/2'],
      [
        'VIEW_REFERENCE',
        'studio/views/foreign.json',
        '/collection collection "contacts" is not declared by this extension',
      ],
    ]);
  });
});

describe('checkViews — references across files', () => {
  it('navigate names a view file of the extension; a message key must be in its en.json', () => {
    const dir = fixture({
      thread: { ...list(), id: 'billing.thread' },
      inbox: list({
        title: 'billing.ui.inbox',
        open: 'billing.thread',
        rowActions: [{ navigate: 'billing.nowhere', label: 'billing.ui.typo' }],
      }),
    });
    mkdirSync(join(dir, 'studio', 'messages'));
    writeFileSync(
      join(dir, 'studio/messages/en.json'),
      JSON.stringify({ 'billing.ui.inbox': 'Inbox' }),
    );
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(checkViews(dir, m).map((e) => e.message)).toEqual([
      '/rowActions/0/navigate "billing.nowhere" is not the id of a view of this extension',
      '/rowActions/0/label "billing.ui.typo" is not a message key of this extension (studio/messages/en.json)',
    ]);
  });
});

describe('extension pack', () => {
  it('refuses to pack when a page file is missing or is not JSON', async () => {
    const dir = fixture({ ok: list() });
    writeFileSync(join(dir, 'studio/views/ok.json'), '{not json');
    await expect(extensionPackCommand({ dir })).rejects.toThrow('not valid JSON');
    rmSync(join(dir, 'studio/views/ok.json'));
    await expect(extensionPackCommand({ dir })).rejects.toThrow('schema file not found');
  });

  it('refuses to pack an extension whose view does not match view/2', async () => {
    const dir = fixture({ bad: list({ dataSource: '/api/data/invoices' }) });
    await expect(extensionPackCommand({ dir })).rejects.toThrow(
      'studio/views/bad.json: /dataSource is not part of view/2',
    );
  });
});

describe('checkViews — pick and facets (DR-45)', () => {
  /** An extension whose `pay` takes a string `payer` and a number `amount`, with `invoices` fields. */
  function withSchema(views: Record<string, unknown>) {
    const dir = fixture(views);
    const m = {
      ...manifest,
      collections: ['invoices', 'payers'],
      actions: [
        {
          name: 'pay',
          input: { properties: { payer: { type: 'string' }, amount: { type: 'number' } } },
        },
      ],
      studio: {
        pages: Object.keys(views).map((n) => ({ schema: `views/${n}.json` })),
      },
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    mkdirSync(join(dir, 'schema', 'collections'), { recursive: true });
    writeFileSync(
      join(dir, 'schema/collections/invoices.json'),
      JSON.stringify({
        fields: [
          { name: 'status', type: 'select', options: { choices: ['open', 'paid'] } },
          { name: 'paid', type: 'boolean' },
          { name: 'note', type: 'text' },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'schema/collections/payers.json'),
      JSON.stringify({ fields: [{ name: 'name', type: 'text' }] }),
    );
    return { dir, m };
  }
  const row = (extra: Record<string, unknown>) =>
    list({
      rowActions: [{ action: 'pay', prompt: ['payer'], pick: { payer: 'payers' }, ...extra }],
    });

  it('passes a pick of an owned collection on a string input, and facets on choices or a boolean', () => {
    const { dir, m } = withSchema({ ok: { ...row({}), facets: ['status', 'paid'] } });
    expect(checkViews(dir, m)).toEqual([]);
  });

  it('VIEW_INVALID: a pick on an input that is not a string, or not declared', () => {
    const { dir, m } = withSchema({
      amount: row({ prompt: ['amount'], pick: { amount: 'payers' } }),
      ghost: row({ prompt: ['ghost'], pick: { ghost: 'payers' } }),
    });
    expect(checkViews(dir, m).map((e) => [e.code, e.message])).toEqual([
      ['VIEW_INVALID', '/rowActions/0/pick/amount is not a string input of action "pay"'],
      ['VIEW_INVALID', '/rowActions/0/pick/ghost is not a string input of action "pay"'],
    ]);
  });

  it('VIEW_INVALID: a button pick that is not asked for or is already set', () => {
    const { dir, m } = withSchema({
      unasked: row({ prompt: undefined }),
      bound: row({ input: { payer: 'x' } }),
    });
    expect(checkViews(dir, m).map((e) => [e.code, e.message])).toEqual([
      [
        'VIEW_INVALID',
        '/rowActions/0/pick/payer names an input the button does not ask for (`prompt`)',
      ],
      ['VIEW_INVALID', '/rowActions/0/prompt/0 names an input the button already sets'],
      ['VIEW_INVALID', '/rowActions/0/pick/payer names an input the button already sets'],
    ]);
  });

  it('VIEW_REFERENCE: a pick of a collection the extension does not own', () => {
    const { dir, m } = withSchema({ foreign: row({ pick: { payer: 'contacts' } }) });
    expect(checkViews(dir, m).map((e) => [e.code, e.message])).toEqual([
      [
        'VIEW_REFERENCE',
        '/rowActions/0/pick/payer collection "contacts" is not declared by this extension',
      ],
    ]);
  });

  it('VIEW_INVALID: a facet on a field the view filter constrains; VIEW_REFERENCE: not a choice or boolean', () => {
    const { dir, m } = withSchema({
      fixed: list({ facets: ['status'], filter: [{ field: 'status', op: 'eq', value: 'open' }] }),
      plain: list({ facets: ['note', 'ghost'] }),
    });
    expect(checkViews(dir, m).map((e) => [e.code, e.message])).toEqual([
      ['VIEW_INVALID', "/facets/0 is a field the view's filter already constrains"],
      ['VIEW_REFERENCE', '/facets/1 field "ghost" is not a field of "invoices"'],
      ['VIEW_REFERENCE', '/facets/0 field "note" is neither a boolean nor has declared choices'],
    ]);
  });
});
