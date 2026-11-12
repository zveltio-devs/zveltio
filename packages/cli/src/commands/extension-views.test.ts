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

  it('reports a view that is not view/2, and one that names what it does not own', () => {
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
